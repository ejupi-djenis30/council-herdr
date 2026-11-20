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
const waiting = new Set(['queued', 'sending', 'alignment_required', 'not_aligned']);
const wakeEvents = new Set(['status', 'labels', 'created', 'restarted', 'finished', 'removed', 'lost']);

function recordPath(cwd, id, create = false) {
  if (typeof id !== 'string' || !recordId.test(id)) return null;
  const base = join(cwd, '.agent_workspace');
  const dir = join(base, '.invites');
  if (!isDirectory(base) || !isDirectory(dir, { create })) return null;
  return join(dir, `${id}.json`);
}

export function readInvitations(cwd, id) {
  try {
    const path = recordPath(cwd, id);
    const raw = path && readText(path, 1024 * 1024);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (record?.id !== id || !Array.isArray(record.targets)) return null;
    const targets = record.targets.filter(target => typeof target?.address === 'string' && terminalId.test(target.address));
    if (Date.now() < record.expiresAt) return targets;
    return targets.map(target => target.state === 'sending'
      ? { ...target, state: 'uncertain' }
      : target.state === 'queued' ? { ...target, state: 'expired' } : target);
  } catch { return null; }
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

export async function sendInvitations(cwd, entry, { id, space, recipients }, { lifetime = 15 * 60 * 1000 } = {}) {
  if (typeof space !== 'string' || !spaceId.test(space) || !Array.isArray(recipients)) throw new Error('Invalid invitation recipients.');
  const path = recordPath(cwd, id, true);
  if (!path) throw new Error('Invalid invitation destination.');
  const poll = id.startsWith('poll-');
  const open = () => {
    try {
      return poll ? !new PollStore(cwd).show(id).closedAt : Boolean(readDebateRoom(cwd, id));
    } catch { return false; }
  };
  if (!open()) throw new Error('The poll or debate is unavailable.');

  const targets = [...new Map(recipients.filter(person => typeof person?.address === 'string' && terminalId.test(person.address))
    .map(person => [person.address, {
      address: person.address, label: typeof person.label === 'string' ? person.label.slice(0, 120) : person.address,
      createdAt: Number.isSafeInteger(person.createdAt) ? person.createdAt : null,
      state: 'queued'
    }])).values()];
  if (!targets.length) return;
  const record = { id, expiresAt: Date.now() + lifetime, targets };
  const claim = `${path}.lock`;
  const awaitingLock = new Set();
  try { writeFileSync(claim, '', { flag: 'wx' }); } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }

  function save() {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(record), { flag: 'wx' });
      renameSync(temp, path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }

  async function deliver(target) {
    const lock = join(dirname(path), `send-${target.address}.lock`);
    try { writeFileSync(lock, '', { flag: 'wx' }); } catch (error) {
      if (error.code === 'EEXIST') {
        awaitingLock.add(target.address);
        return 'queued';
      }
      throw error;
    }
    awaitingLock.delete(target.address);
    try {
      return await inviteReadyAgent({ ...target, space, entry, message: messageFor({ id, cwd, entry, target, poll }), markProbe: () => { target.probeSent = true; },
        deadline: record.expiresAt, stillOpen: open });
    } finally {
      unlinkSync(lock);
    }
  }

  try {
    if (existsSync(path)) return;
    save();
    const feed = spawn('hc', ['events', '--json', '--label', `herdr.space=${space}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const reader = createInterface({ input: feed.stdout });
    const active = new Map();
    const changed = new Set();
    const byId = new Map(targets.map(target => [target.address, target]));
    const locks = watch(dirname(path), (_event, file) => {
      const match = /^send-(t[0-9a-z]+)\.lock$/.exec(file ?? '');
      if (match && awaitingLock.has(match[1]) && !existsSync(join(dirname(path), file))) {
        awaitingLock.delete(match[1]);
        schedule(match[1]);
      }
    });
    let stopping = false;
    const stop = () => { stopping = true; locks.close(); reader.close(); feed.kill(); };
    const deadline = setTimeout(stop, lifetime);
    feed.on('error', stop);
    locks.on('error', stop);

    function schedule(address) {
      const target = byId.get(address);
      if (stopping || !target || !waiting.has(target.state) || Date.now() >= record.expiresAt) return;
      if (active.has(address)) return void changed.add(address);
      target.state = 'sending';
      save();
      const task = deliver(target)
        .then(state => { target.state = state; }, () => { target.state = 'uncertain'; })
        .finally(() => {
          active.delete(address);
          save();
          if (changed.delete(address)) schedule(address);
          if (targets.every(item => !waiting.has(item.state))) stop();
        });
      active.set(address, task);
    }

    try {
      for await (const line of reader) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (Array.isArray(event.terminals)) targets.forEach(target => schedule(target.address));
        else if (event.method === 'event' && wakeEvents.has(event.params?.type)) schedule(event.params.terminal);
      }
    } finally {
      clearTimeout(deadline);
      stop();
      await Promise.all(active.values());
      for (const target of targets) {
        if (target.state === 'queued') target.state = Date.now() >= record.expiresAt ? 'expired' : 'unavailable';
      }
      save();
    }
  } finally {
    unlinkSync(claim);
  }
}
