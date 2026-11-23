import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { alignmentChallenge, alignmentNotice, alignmentOf } from './alignment.mjs';
import { PollStore } from './polls.mjs';
import { readDebateRoom } from './debate-room.mjs';
import { isDirectory, readText } from './store-files.mjs';

const spaceId = /^[a-z0-9-]{1,80}$/i;
const recordId = /^(poll|debate)-[0-9a-f-]{36}$/;
const terminalId = /^t[0-9a-z]+$/;
const waiting = new Set(['queued', 'alignment_required', 'not_aligned']);
const lifetimeMs = 15 * 60 * 1000;
const wakeEvents = new Set(['status', 'labels', 'created', 'restarted', 'finished', 'removed', 'lost']);

function recordPath(cwd, id, create = false) {
  if (typeof id !== 'string' || !recordId.test(id)) return null;
  const base = join(cwd, '.agent_workspace');
  const dir = join(base, '.invites');
  if (!isDirectory(base) || !isDirectory(dir, { create })) return null;
  return join(dir, `${id}.json`);
}

function readQueue(path, id) {
  const raw = readText(path, 1024 * 1024);
  if (raw === null) return null;
  const record = JSON.parse(raw);
  if (record?.id !== id || !Number.isFinite(record.expiresAt) || !Array.isArray(record.targets) ||
      record.targets.some(target => !terminalId.test(target?.address ?? '')) ||
      new Set(record.targets.map(target => target.address)).size !== record.targets.length) {
    throw new Error('Invalid invitation queue.');
  }
  return record;
}

function updateQueue(path, record) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(record), { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function removeClaim(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function liveClaim(dir, key, own, prune = false) {
  const prefix = `${key}.`;
  return readdirSync(dir).some(name => {
    if (name === own || !name.startsWith(prefix)) return false;
    const owner = /^(\d+)\.[0-9a-f-]+\.lock$/.exec(name.slice(prefix.length));
    if (!owner) return false;
    try {
      process.kill(Number(owner[1]), 0);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') return true;
      if (prune) removeClaim(join(dir, name));
      return false;
    }
  });
}

// Each contender publishes its own claim before checking for other live owners.
// Contention backs off, and a dead owner's filename can be removed without touching a new claim.
function claim(dir, key, legacy) {
  if (existsSync(legacy)) return null;
  const own = `${key}.${process.pid}.${randomUUID()}.lock`;
  const path = join(dir, own);
  writeFileSync(path, '', { flag: 'wx' });
  try {
    if (!liveClaim(dir, key, own, true)) return () => removeClaim(path);
  } catch (error) {
    removeClaim(path);
    throw error;
  }
  removeClaim(path);
  return null;
}

export function planInvitations(space, recipients) {
  if (recipients === undefined) return null;
  if (typeof space !== 'string' || !spaceId.test(space) || !Array.isArray(recipients)) {
    throw new Error('Invalid invitation recipients.');
  }
  const targets = new Map();
  for (const recipient of recipients) {
    if (!recipient || typeof recipient.address !== 'string' || !terminalId.test(recipient.address) ||
        !Number.isSafeInteger(recipient.createdAt) || recipient.createdAt <= 0) {
      throw new Error('An invitation needs the selected terminal identity.');
    }
    const label = typeof recipient.label === 'string' ? recipient.label.slice(0, 120) : recipient.address;
    targets.set(recipient.address, { address: recipient.address, label, createdAt: recipient.createdAt, state: 'queued' });
  }
  return targets.size ? { space, expiresAt: Date.now() + lifetimeMs, targets: [...targets.values()] } : null;
}

export function prepareInvitations(cwd, id, plan) {
  const path = recordPath(cwd, id, true);
  if (!path) throw new Error('Invalid invitation destination.');
  writeFileSync(path, JSON.stringify({ id, ...plan }), { flag: 'wx' });
}

function projectTargets(record, running) {
  const expired = Date.now() >= record.expiresAt;
  return record.targets.map(target => {
    if (target.state === 'sending' && (!running || expired)) return { ...target, state: 'uncertain' };
    return expired && waiting.has(target.state) ? { ...target, state: 'expired', reason: target.state } : target;
  });
}

function recordIsOpen(cwd, id) {
  try {
    return id.startsWith('poll-') ? !new PollStore(cwd).show(id).closedAt : !readDebateRoom(cwd, id).closedAt;
  } catch { return false; }
}

export function pendingInvitationIds(cwd, space) {
  if (typeof space !== 'string' || !spaceId.test(space)) return [];
  const workspace = join(cwd, '.agent_workspace');
  const dir = join(workspace, '.invites');
  if (!isDirectory(workspace) || !isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(file => {
    const id = file.name.slice(0, -5);
    if (!file.isFile() || !file.name.endsWith('.json') || !recordId.test(id)) return [];
    const path = join(dir, file.name);
    try {
      const record = readQueue(path, id);
      if (!record || record.space !== space || Date.now() >= record.expiresAt ||
          !record.targets.some(target => waiting.has(target.state) || target.state === 'sending') ||
          existsSync(`${path}.lock`) || liveClaim(dir, id) || !recordIsOpen(cwd, id)) return [];
      return [id];
    } catch { return []; }
  });
}

function retryable(target) {
  return target.state === 'expired' && waiting.has(target.reason) && Number.isSafeInteger(target.createdAt);
}

export function readInvitationDelivery(cwd, id, { closed = false } = {}) {
  try {
    const path = recordPath(cwd, id);
    const record = path && readQueue(path, id);
    if (!record) return null;
    const claimed = existsSync(`${path}.lock`) || liveClaim(dirname(path), id);
    const targets = projectTargets(record, claimed).map(target => closed && waiting.has(target.state)
      ? { ...target, state: 'cancelled' } : target);
    return {
      space: record.space ?? null, expiresAt: record.expiresAt, claimed,
      active: !closed && Date.now() < record.expiresAt && targets.some(target => waiting.has(target.state) || target.state === 'sending'),
      targets: targets.map(target => ({ ...target, retryable: !closed && !claimed && Boolean(record.space) && retryable(target) }))
    };
  } catch { return null; }
}

export function readInvitations(cwd, id, options) {
  return readInvitationDelivery(cwd, id, options)?.targets ?? null;
}

export function retryInvitation(cwd, { id, space, address }) {
  const path = recordPath(cwd, id);
  if (!path || !recordIsOpen(cwd, id)) throw new Error('The poll or debate is no longer available.');
  const release = claim(dirname(path), id, `${path}.lock`);
  if (!release) throw new Error('An invitation worker still holds the queue. Try again after it exits.');
  try {
    const record = readQueue(path, id);
    if (!record || record.space !== space) throw new Error('Open this invitation in its original space.');
    const targets = projectTargets(record, false);
    const target = targets.find(item => item.address === address);
    if (!target || !retryable(target)) throw new Error('Only a confirmed unsent invitation can be retried.');
    target.state = 'queued';
    delete target.reason;
    delete target.probeSent;
    record.targets = targets;
    record.expiresAt = Date.now() + lifetimeMs;
    updateQueue(path, record);
    return { id, address, expiresAt: record.expiresAt };
  } finally {
    release();
  }
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

// Capture identity before publication so a reused address cannot receive an old invitation.
export async function publishWithInvitations(cwd, addresses, publish, command = defaultCommand) {
  if (addresses === undefined) return publish({});
  if (!Array.isArray(addresses) || addresses.length > 32 ||
      addresses.some(address => typeof address !== 'string' || !terminalId.test(address))) {
    throw new Error('Select up to 32 local Herdr terminal addresses for invitations.');
  }
  if (!addresses.length) return publish({});
  const recipients = await Promise.all([...new Set(addresses)].map(async address => {
    const { ok, details } = await command(['get', '--json', address], 10000);
    if (!ok || details?.state !== 'live' || details.address !== address || !details.reported || !details.status?.app) {
      throw new Error(`No live reporting agent at ${address}. Check its Herdr address.`);
    }
    return { address, label: details.name || details.status.app, createdAt: details.created_ms, space: details.labels?.['herdr.space'] };
  }));
  const space = recipients[0].space;
  if (!space || recipients.some(recipient => recipient.space !== space)) throw new Error('Choose agents from one Herdr space.');
  const plan = planInvitations(space, recipients);
  const record = publish({ participants: plan.targets, beforePublish: id => prepareInvitations(cwd, id, plan) });
  const id = record.sessionId ?? record.id;
  const entry = fileURLToPath(new URL('./council.mjs', import.meta.url));
  const args = ['run', '--bg', '--json', '--no-parent', '--no-notify', '--outlive-parent', '--rm',
    '--name', `council-invite-${id.replace(/-/g, '').slice(-17)}`, '--cwd', cwd, '--', process.execPath, entry, 'invite', id];
  // The open record and queue survive a lost launch reply. Desktop reconciles the original queue.
  let worker;
  try { worker = await command(args, 15000); } catch {}
  return { ...record, invitationDelivery: readInvitationDelivery(cwd, id),
    workerAddress: worker?.ok ? worker.details?.address ?? null : null,
    ...(!worker?.ok || !worker.details?.address ? { nextAction: 'Invitations are saved. Open Council Desktop in the recipient space to check delivery.' } : {}) };
}

export async function checkInvitationAlignment(cwd, entry, { id, space, address }, command = defaultCommand) {
  const path = recordPath(cwd, id);
  const record = path && readQueue(path, id);
  const target = record?.targets.find(person => person.address === address);
  if (!target || !Number.isSafeInteger(target.createdAt) || record.space !== space || !recordIsOpen(cwd, id)) {
    throw new Error('This invitation has no matching terminal to check.');
  }
  const setupStates = ['alignment_required', 'not_aligned'];
  if (!setupStates.some(state => state === target.state || state === target.reason)) throw new Error('This invitation is not waiting for setup.');
  const dir = dirname(path);
  const key = `send-${address}`;
  const release = claim(dir, key, join(dir, `${key}.lock`));
  if (!release) throw new Error('This terminal is already being checked. Try again shortly.');
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
      const tagged = await command(['label', '--json', address, challenge.argument], 10000);
      if (!tagged.ok) throw new Error('Herdr could not register the setup check.');
    }
    if (!recordIsOpen(cwd, id)) throw new Error('The poll or debate is no longer available.');
    const guard = terminal.status.state === 'idle' ? ['--if', 'idle'] : [];
    const delivery = await command(['send', '--json', ...guard, address, alignmentNotice(entry, challenge)], 90000);
    return { state: delivery.ok && delivery.details?.started === true ? 'sent' : 'uncertain' };
  } finally {
    release();
  }
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
  markSending = () => {}, deadline = Infinity, command = defaultCommand, stillOpen = () => true }) {
  const remaining = () => Math.max(1, deadline - Date.now());
  if (Date.now() >= deadline) return 'expired';
  const result = await command(['get', '--json', address], Math.min(10000, remaining()));
  const terminal = result.details;
  if (!result.ok) return terminal?.error?.kind === 'not_found' ? 'unavailable' : 'queued';
  if (terminal?.state !== 'live' || terminal.labels?.['herdr.space'] !== space) return 'unavailable';
  if (createdAt != null && terminal.created_ms !== createdAt) return 'unavailable';
  if (!stillOpen()) return 'cancelled';
  const alignment = alignmentOf(terminal);
  if (alignment === 'not_aligned') return 'not_aligned';
  const state = terminal.status?.state;
  if (!terminal.reported || !['idle', 'done'].includes(state)) return probeSent && alignment === 'unconfirmed' ? 'alignment_required' : 'queued';
  const checking = alignment !== 'aligned';
  if (checking && probeSent) return 'alignment_required';
  // Herdr's idle guard is exact and rejects done. A fresh done report also means the agent has ended its turn.
  const options = state === 'idle' ? ['--if', 'idle'] : [];
  let text = message;
  if (checking) {
    const challenge = alignmentChallenge(terminal);
    if (challenge.argument) {
      if (Date.now() >= deadline) return 'expired';
      const tagged = await command(['label', '--json', address, challenge.argument], Math.min(10000, remaining()));
      if (!tagged.ok) return 'alignment_required';
    }
    text = alignmentNotice(entry, challenge);
  }
  if (Date.now() >= deadline) return 'expired';
  if (!stillOpen()) return 'cancelled';
  if (checking) markProbe(true);
  else markSending();
  const delivery = await command(['send', '--json', ...options, address, text], Math.min(90000, remaining()));
  const failure = delivery.details?.error?.kind;
  if (checking) {
    if (!['blocked', 'status_mismatch', 'finished', 'not_found'].includes(failure)) return 'alignment_required';
    markProbe(false);
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

export async function sendInvitations(cwd, entry, { id, space, recipients }, {
  command = defaultCommand, events = space => spawn('hc', ['events', '--json', '--label', `herdr.space=${space}`], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
  })
} = {}) {
  const path = recordPath(cwd, id, true);
  if (!path) throw new Error('Invalid invitation destination.');
  const dir = dirname(path);
  const release = claim(dir, id, `${path}.lock`);
  if (!release) return;
  try {
    const open = () => recordIsOpen(cwd, id);
    let record = readQueue(path, id);
    if (!record) {
      // Accept a launch from a previous desktop build when it has not created a queue yet.
      const plan = planInvitations(space, recipients);
      if (!plan || !open()) return;
      record = { id, ...plan };
      updateQueue(path, record);
    }
    if (typeof record.space !== 'string' || !spaceId.test(record.space)) return;
    const nextTargets = projectTargets(record, false);
    const save = () => updateQueue(path, record);
    if (nextTargets.some((target, index) => target !== record.targets[index])) {
      record.targets = nextTargets;
      save();
    }
    const targets = record.targets.filter(target => waiting.has(target.state));
    if (!targets.length) return;
    if (!open()) {
      targets.forEach(target => { target.state = 'cancelled'; });
      save();
      return;
    }

    const poll = id.startsWith('poll-');
    const active = new Map();
    const changed = new Set();
    const awaitingLock = new Set();
    const byId = new Map(targets.map(target => [target.address, target]));
    const feed = events(record.space);
    const reader = createInterface({ input: feed.stdout });
    let stopping = false;
    let failure;
    let locks;
    let timer;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      locks?.close();
      reader.close();
      feed.kill();
    };
    feed.on('error', stop);

    function schedule(address) {
      const target = byId.get(address);
      if (stopping || !target || Date.now() >= record.expiresAt) return;
      if (active.has(address)) {
        changed.add(address);
        return;
      }
      if (!waiting.has(target.state)) return;

      const key = `send-${address}`;
      const legacy = join(dir, `${key}.lock`);
      const unlock = claim(dir, key, legacy);
      if (!unlock) {
        awaitingLock.add(address);
        return;
      }
      awaitingLock.delete(address);
      const task = inviteReadyAgent({
        ...target, space: record.space, entry, command, deadline: record.expiresAt, stillOpen: open,
        message: messageFor({ id, cwd, entry, target, poll }),
        markProbe: sent => { target.probeSent = sent; save(); },
        markSending: () => { target.state = 'sending'; save(); }
      }).then(state => { target.state = state; }, () => {
        if (target.state === 'sending') target.state = 'uncertain';
      }).then(() => {
        // Publish the outcome before releasing the terminal for another invitation.
        try { save(); } finally { unlock(); }
        active.delete(address);
        if (changed.delete(address)) schedule(address);
        if (!active.size && targets.every(item => !waiting.has(item.state))) stop();
      }).catch(error => {
        failure = error;
        active.delete(address);
        stop();
      });
      active.set(address, task);
    }

    try {
      locks = watch(dir, (_event, filename) => {
        if (stopping) return;
        const match = /^send-(t[0-9a-z]+)[.]/.exec(filename ?? '');
        const address = match?.[1];
        if (!awaitingLock.has(address)) return;
        const key = `send-${address}`;
        try {
          if (!existsSync(join(dir, `${key}.lock`)) && !liveClaim(dir, key)) schedule(address);
        } catch (error) {
          failure = error;
          stop();
        }
      });
      locks.on('error', stop);
      timer = setTimeout(stop, Math.max(0, record.expiresAt - Date.now()));
      for await (const line of reader) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (Array.isArray(event.terminals) || (event.method === 'event' && event.params?.type === 'missed')) {
          targets.forEach(target => schedule(target.address));
        } else if (event.method === 'event' && wakeEvents.has(event.params?.type)) {
          schedule(event.params.terminal);
        }
      }
    } finally {
      stop();
      await Promise.all(active.values());
      record.targets = projectTargets(record, false);
      save();
    }
    if (failure) throw failure;
  } finally {
    release();
  }
}
