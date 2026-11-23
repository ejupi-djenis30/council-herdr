import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { alignmentChallenge, alignmentNotice, alignmentOf } from './alignment.mjs';
import { PollStore } from './polls.mjs';
import { readDebateRoom } from './debate-room.mjs';
import { isDirectory, readText } from './store-files.mjs';

const spaceId = /^[a-z0-9-]{1,80}$/i;
const recordId = /^(poll|debate)-[0-9a-f-]{36}$/;
const terminalId = /^t[0-9a-z]+$/;
const waiting = new Set(['queued', 'alignment_required', 'not_aligned']);
const retryable = new Set(['expired', 'dispatch_failed', 'unavailable']);
const wakeEvents = new Set(['status', 'labels', 'created', 'restarted', 'finished', 'removed', 'lost']);
const deliveryWindow = 15 * 60 * 1000;

function recordPath(cwd, id, create = false) {
  if (typeof id !== 'string' || !recordId.test(id)) return null;
  const base = join(cwd, '.agent_workspace');
  const dir = join(base, '.invites');
  if (!isDirectory(base) || !isDirectory(dir, { create })) return null;
  return join(dir, `${id}.json`);
}

function readRecord(path, id) {
  const raw = path && readText(path, 1024 * 1024);
  if (!raw) return null;
  const record = JSON.parse(raw);
  if (record?.id !== id || !Number.isFinite(record.expiresAt) || !Array.isArray(record.targets)) return null;
  return { ...record, targets: record.targets.filter(target => typeof target?.address === 'string' && terminalId.test(target.address)) };
}

function saveRecord(path, record) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(record), { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function claimFile(path) {
  try { writeFileSync(path, '', { flag: 'wx' }); } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

function stopWaiting(target, state) {
  if (target.state === 'sending') return { ...target, state: 'uncertain' };
  if (waiting.has(target.state)) return { ...target, state, reason: target.state };
  return target;
}

export function readInvitationDelivery(cwd, id, { closed = false } = {}) {
  try {
    const path = recordPath(cwd, id);
    const record = readRecord(path, id);
    if (!record) return null;
    const expired = Date.now() >= record.expiresAt;
    const claimed = existsSync(`${path}.lock`);
    const active = !closed && !expired && (['pending', 'running'].includes(record.dispatch) || (!record.dispatch && claimed));
    const targets = closed || expired ? record.targets.map(target => stopWaiting(target, closed ? 'cancelled' : 'expired')) : record.targets;
    return {
      expiresAt: record.expiresAt, active, claimed, space: record.space,
      targets: targets.map(target => ({ ...target, retryable: Boolean(!closed && record.space && !claimed && !active &&
        Number.isSafeInteger(target.createdAt) && retryable.has(target.state)) }))
    };
  } catch { return null; }
}

export function readInvitations(cwd, id) {
  return readInvitationDelivery(cwd, id)?.targets ?? null;
}

function defaultCommand(args, timeout) {
  return new Promise(resolve => {
    execFile('hc', args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      let details;
      try { details = JSON.parse(stdout || stderr); } catch {}
      resolve({ ok: !error, details });
    });
  });
}

function messageFor({ id, cwd, entry, target, poll }) {
  const header = poll ? 'You were invited to a Council poll.' : 'You were invited to a Council debate.';
  const mode = poll ? 'poll' : 'debate';
  const task = poll
    ? `Read the question and options with council_poll_read (pollId, project); respond with council_poll_vote (pollId, project, voter, optionId and note, or answer). CLI: poll show ${id}, then poll vote ${id} --voter ${target.address} with --option <id> or --answer <text> as allowed.`
    : `Read the topic and current conversation with council_debate_read (debateId, project), then post one reasoned reply with council_debate_reply (debateId, project, author, text). CLI: debate show ${id}, then debate reply ${id} --author ${target.address} --text <your reply>.`;
  return `${header}\nProject: ${cwd}\nID: ${id}\nYour terminal address: ${target.address}\n${task}\nCLI fallback: from the project folder run node with the entry point ${entry}, followed by the ${mode} command above. If you cannot submit, give your response in this terminal.`;
}

export async function inviteReadyAgent({ space, address, createdAt, message, entry, probeSent, markProbe = () => {},
  deadline = Infinity, command = defaultCommand, stillOpen = () => true }) {
  const remaining = () => Math.max(1, deadline - Date.now());
  const result = await command(['get', '--json', address], Math.min(10000, remaining()));
  const terminal = result.details;
  if (!result.ok || terminal?.state !== 'live' || terminal.labels?.['herdr.space'] !== space) return 'unavailable';
  if (createdAt != null && terminal.created_ms !== createdAt) return 'unavailable';
  if (!stillOpen()) return 'cancelled';
  const alignment = alignmentOf(terminal);
  if (alignment === 'not_aligned') return 'not_aligned';
  const state = terminal.status?.state;
  if (!terminal.reported || !['idle', 'done'].includes(state)) return probeSent && alignment === 'unconfirmed' ? 'alignment_required' : 'queued';
  if (Date.now() >= deadline) return 'expired';
  const checking = alignment !== 'aligned';
  if (checking && probeSent) return 'alignment_required';
  // Herdr's idle guard is exact and rejects done. A fresh done report also means the agent has ended its turn.
  const options = state === 'idle' ? ['--if', 'idle'] : [];
  let text = message;
  if (checking) {
    const challenge = alignmentChallenge(terminal);
    if (challenge.argument) {
      const tagged = await command(['label', '--json', address, challenge.argument], Math.min(10000, remaining()));
      if (!tagged.ok) return 'alignment_required';
    }
    text = alignmentNotice(entry, challenge);
  }
  if (Date.now() >= deadline) return 'expired';
  if (!stillOpen()) return 'cancelled';
  const delivery = await command(['send', '--json', ...options, address, text], Math.min(90000, remaining()));
  const failure = delivery.details?.error?.kind;
  if (checking && !['blocked', 'status_mismatch', 'finished', 'not_found'].includes(failure)) {
    markProbe();
    return 'alignment_required';
  }
  if (delivery.ok) return delivery.details?.started === true ? 'sent' : 'uncertain';
  switch (failure) {
    case 'blocked':
    case 'status_mismatch': return 'queued';
    case 'finished':
    case 'not_found': return 'unavailable';
    default: return 'uncertain';
  }
}

function isOpen(cwd, id) {
  try { return id.startsWith('poll-') ? !new PollStore(cwd).show(id).closedAt : Boolean(readDebateRoom(cwd, id)); }
  catch { return false; }
}

export function prepareInvitations(cwd, { id, space, recipients, address }, { lifetime = deliveryWindow } = {}) {
  if (typeof space !== 'string' || !spaceId.test(space)) throw new Error('Invalid invitation space.');
  const path = recordPath(cwd, id, true);
  if (!path || !isOpen(cwd, id)) throw new Error('The poll or debate is unavailable.');
  const claim = `${path}.lock`;
  if (!claimFile(claim)) throw new Error('An invitation worker still holds this delivery.');

  try {
    const prior = readRecord(path, id);
    let targets;
    if (address !== undefined) {
      const now = Date.now();
      if (!prior || prior.space !== space || (now < prior.expiresAt && ['pending', 'running'].includes(prior.dispatch))) {
        throw new Error('This invitation is not ready to retry.');
      }
      targets = now >= prior.expiresAt ? prior.targets.map(target => stopWaiting(target, 'expired')) : prior.targets;
      const target = targets.find(target => target.address === address);
      if (!target || !Number.isSafeInteger(target.createdAt) || !retryable.has(target.state)) throw new Error('Only confirmed unsent invitations can be retried.');
      targets = targets.map(person => person === target ? { ...person, state: 'queued', reason: undefined, probeSent: false } : person);
    } else {
      if (prior || existsSync(path)) throw new Error('This invitation roster already exists.');
      if (!Array.isArray(recipients)) throw new Error('Invalid invitation recipients.');
      targets = [...new Map(recipients.filter(person => typeof person?.address === 'string' && terminalId.test(person.address))
        .map(person => [person.address, {
          address: person.address, label: typeof person.label === 'string' ? person.label.slice(0, 120) : person.address,
          createdAt: Number.isSafeInteger(person.createdAt) ? person.createdAt : null,
          state: 'queued'
        }])).values()];
    }
    if (!targets.length) return null;
    const dispatchId = randomUUID();
    saveRecord(path, { id, space, dispatchId, dispatch: 'pending', expiresAt: Date.now() + lifetime, targets });
    return { id, space, dispatchId };
  } finally {
    unlinkSync(claim);
  }
}

export function recordInvitationLaunchFailure(cwd, { id, dispatchId }) {
  const path = recordPath(cwd, id);
  if (!path || typeof dispatchId !== 'string') return false;
  const claim = `${path}.lock`;
  if (!claimFile(claim)) return false;
  try {
    const record = readRecord(path, id);
    if (record?.dispatchId !== dispatchId || record.dispatch !== 'pending') return false;
    record.dispatch = 'failed';
    record.targets = record.targets.map(target => stopWaiting(target, 'dispatch_failed'));
    saveRecord(path, record);
    return true;
  } finally {
    unlinkSync(claim);
  }
}

export async function checkInvitationAlignment(cwd, entry, { id, space, address }, command = defaultCommand) {
  const path = recordPath(cwd, id);
  const record = readRecord(path, id);
  const target = record?.targets.find(person => person.address === address);
  if (!target || !Number.isSafeInteger(target.createdAt) || record.space !== space || !isOpen(cwd, id)) {
    throw new Error('This invitation has no matching terminal to check.');
  }
  const setupStates = ['alignment_required', 'not_aligned'];
  if (!setupStates.some(state => state === target.state || state === target.reason)) throw new Error('This invitation is not waiting for setup.');
  const lock = join(dirname(path), `send-${address}.lock`);
  if (!claimFile(lock)) throw new Error('This terminal is already being checked. Try again shortly.');
  try {
    const reply = await command(['get', '--json', address], 10000);
    const terminal = reply.details;
    if (!reply.ok || terminal?.state !== 'live' || terminal.created_ms !== target.createdAt || terminal.labels?.['herdr.space'] !== space) {
      throw new Error('The original terminal is no longer available in this space.');
    }
    if (alignmentOf(terminal) === 'aligned') return { state: 'aligned' };
    if (!terminal.reported || !['idle', 'done'].includes(terminal.status?.state)) throw new Error('Wait for this terminal to finish its current turn, then check again.');
    const challenge = alignmentChallenge(terminal);
    if (challenge.argument) {
      const label = await command(['label', '--json', address, challenge.argument], 10000);
      if (!label.ok) throw new Error('Herdr could not register the setup check.');
    }
    const guard = terminal.status.state === 'idle' ? ['--if', 'idle'] : [];
    if (!isOpen(cwd, id)) throw new Error('The poll or debate is no longer available.');
    const delivery = await command(['send', '--json', ...guard, address, alignmentNotice(entry, challenge)], 90000);
    return { state: delivery.ok && delivery.details?.started === true ? 'sent' : 'uncertain' };
  } finally {
    unlinkSync(lock);
  }
}

export async function sendInvitations(cwd, entry, args, { lifetime = deliveryWindow } = {}) {
  const { id, space } = args;
  const path = recordPath(cwd, id, true);
  if (!path || typeof space !== 'string' || !spaceId.test(space)) throw new Error('Invalid invitation destination.');
  // Support workers launched by an older panel that supplied the roster directly.
  const ticket = args.dispatchId ? args : existsSync(path) ? null : prepareInvitations(cwd, args, { lifetime });
  if (!ticket) return;
  const claim = `${path}.lock`;
  if (!claimFile(claim)) return;
  try {
    const record = readRecord(path, id);
    if (record?.dispatchId !== ticket.dispatchId || record.space !== space || record.dispatch !== 'pending') return;
    const open = () => isOpen(cwd, id);
    const poll = id.startsWith('poll-');
    const { targets } = record;
    const awaitingLock = new Set();
    const save = () => saveRecord(path, record);
    record.dispatch = 'running';
    save();

    if (!open() || Date.now() >= record.expiresAt) {
      record.targets = targets.map(target => stopWaiting(target, open() ? 'expired' : 'cancelled'));
      record.dispatch = 'stopped';
      save();
      return;
    }

    async function deliver(target) {
      const lock = join(dirname(path), `send-${target.address}.lock`);
      if (!claimFile(lock)) {
        awaitingLock.add(target.address);
        return 'queued';
      }
      awaitingLock.delete(target.address);
      try {
        return await inviteReadyAgent({ ...target, space, entry, message: messageFor({ id, cwd, entry, target, poll }), markProbe: () => { target.probeSent = true; },
          deadline: record.expiresAt, stillOpen: open });
      } finally {
        unlinkSync(lock);
      }
    }

    let feed, reader, locks, deadline;
    const active = new Map();
    const changed = new Set();
    const byId = new Map(targets.map(target => [target.address, target]));
    let stopping = false;
    const stop = () => { stopping = true; locks?.close(); reader?.close(); feed?.kill(); };

    function schedule(address) {
      const target = byId.get(address);
      if (stopping || !target || Date.now() >= record.expiresAt) return;
      if (active.has(address)) return void changed.add(address);
      if (!waiting.has(target.state)) return;
      target.state = 'sending';
      save();
      const task = deliver(target)
        .then(state => { target.state = state; }, () => { target.state = 'uncertain'; })
        .finally(() => {
          active.delete(address);
          save();
          if (changed.delete(address)) schedule(address);
          if (targets.every(item => !waiting.has(item.state) && item.state !== 'sending')) stop();
        });
      active.set(address, task);
    }

    try {
      feed = spawn('hc', ['events', '--json', '--label', `herdr.space=${space}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      reader = createInterface({ input: feed.stdout });
      feed.on('error', stop);
      locks = watch(dirname(path), (_event, file) => {
        const match = /^send-(t[0-9a-z]+)\.lock$/.exec(file ?? '');
        if (match && awaitingLock.has(match[1]) && !existsSync(join(dirname(path), file))) {
          awaitingLock.delete(match[1]);
          schedule(match[1]);
        }
      });
      locks.on('error', stop);
      deadline = setTimeout(stop, Math.max(1, record.expiresAt - Date.now()));
      for await (const line of reader) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (Array.isArray(event.terminals)) targets.forEach(target => schedule(target.address));
        else if (event.method === 'event' && wakeEvents.has(event.params?.type)) schedule(event.params.terminal);
      }
    } finally {
      clearTimeout(deadline);
      stop();
      await Promise.allSettled(active.values());
      const stoppedState = !open() ? 'cancelled' : Date.now() >= record.expiresAt ? 'expired' : 'dispatch_failed';
      record.targets = targets.map(target => stopWaiting(target, stoppedState));
      record.dispatch = record.targets.some((target, index) => target !== targets[index] && target.state === 'dispatch_failed') ? 'failed' : 'stopped';
      save();
    }
  } finally {
    unlinkSync(claim);
  }
}
