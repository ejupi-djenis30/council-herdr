import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { alignmentKey, alignmentLabel } from '../herdr/mods/council/runtime/alignment.mjs';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { pendingInvitationIds, readInvitations, sendInvitations } from '../herdr/mods/council/runtime/invitations.mjs';

const space = 'sp42';
const recipients = [
  { address: 't2', label: 'Reviewer', createdAt: 2 },
  { address: 't3', label: 'Implementer', createdAt: 3 }
];

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'council invitations '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function create(cwd, action, selection = recipients) {
  return desktopRequest(cwd, action, { question: 'Which change comes next?', mode: 'open', space, recipients: selection });
}

function queuePath(cwd, id, suffix = '.json') {
  return join(cwd, '.agent_workspace', '.invites', id + suffix);
}

function readQueue(cwd, id) {
  return JSON.parse(readFileSync(queuePath(cwd, id), 'utf8'));
}

function snapshot() {
  const feed = new EventEmitter();
  feed.stdout = Readable.from(['{"terminals":[]}\n']);
  feed.kill = () => feed.stdout.destroy();
  return feed;
}

function liveAgent(address, state) {
  const terminal = { address, state: 'live', reported: true, pid: 8, created_ms: Number(address.slice(1)),
    status: { state, app: 'codex' }, labels: { 'herdr.space': space } };
  terminal.labels[alignmentKey] = alignmentLabel(terminal, 'aligned').split('=')[1];
  return terminal;
}

test('Desktop persists only the selected recipients and accepts creating either item with zero invites', t => {
  const cwd = project(t);
  const uninvited = create(cwd, 'create', []);
  const emptyDebate = create(cwd, 'debate-create', []);
  assert.deepEqual(uninvited.participants, []);
  assert.equal(emptyDebate.invitations, null);
  assert.equal(existsSync(join(cwd, '.agent_workspace', '.invites')), false);
  const poll = create(cwd, 'create', recipients.slice(1));
  const debate = create(cwd, 'debate-create', recipients.slice(0, 1));
  assert.deepEqual(poll.participants, [{ voter: 't3', label: 'Implementer' }]);
  assert.deepEqual(readQueue(cwd, poll.id).targets.map(target => target.address), ['t3']);
  assert.deepEqual(readQueue(cwd, debate.id).targets.map(target => target.address), ['t2']);
  assert.deepEqual(pendingInvitationIds(cwd, space).sort(), [poll.id, debate.id].sort());
  assert.deepEqual(pendingInvitationIds(cwd, 'sp99'), []);
});

test('a stopped worker leaves queued targets resumable and resumes without changing the deadline', async t => {
  const cwd = project(t);
  const poll = create(cwd, 'create');
  const originalDeadline = readQueue(cwd, poll.id).expiresAt;
  const calls = [];
  let online = false;
  const command = async (args, timeout) => {
    calls.push(args);
    assert.ok(timeout <= originalDeadline - Date.now() + 30);
    if (args[0] === 'get') return { ok: true, details: liveAgent(args[2], online ? 'idle' : 'working') };
    const target = readQueue(cwd, poll.id).targets.find(item => item.address === args[4]);
    assert.equal(target.state, 'sending', 'sending is published before touching the terminal');
    return { ok: true, details: { started: true } };
  };
  const options = { command, events: snapshot };
  await sendInvitations(cwd, 'worker.mjs', { id: poll.id }, options);
  assert.deepEqual(readInvitations(cwd, poll.id).map(target => target.state), ['queued', 'queued']);
  assert.deepEqual(pendingInvitationIds(cwd, space), [poll.id]);
  online = true;
  await sendInvitations(cwd, 'worker.mjs', { id: poll.id }, options);
  await sendInvitations(cwd, 'worker.mjs', { id: poll.id }, options);
  assert.deepEqual(readInvitations(cwd, poll.id).map(target => target.state), ['sent', 'sent']);
  assert.deepEqual(calls.filter(args => args[0] === 'send').map(args => args[4]).sort(), ['t2', 't3']);
  assert.equal(readQueue(cwd, poll.id).expiresAt, originalDeadline);
  assert.deepEqual(pendingInvitationIds(cwd, space), []);
});

test('a resumed queue can reclaim a dead worker and never retries sending, uncertain, or sent targets', async t => {
  const cwd = project(t);
  const debate = create(cwd, 'debate-create', [
    ...recipients, { address: 't4', createdAt: 4 }, { address: 't5', createdAt: 5 }
  ]);
  const record = readQueue(cwd, debate.id);
  record.targets[1].state = 'sending';
  record.targets[2].state = 'uncertain';
  record.targets[3].state = 'sent';
  writeFileSync(queuePath(cwd, debate.id), JSON.stringify(record));

  const suffix = pid => `.${pid}.00000000-0000-4000-8000-000000000000.lock`;
  const livingClaim = queuePath(cwd, debate.id, suffix(process.pid));
  writeFileSync(livingClaim, '');
  assert.deepEqual(pendingInvitationIds(cwd, space), []);
  await sendInvitations(cwd, 'worker.mjs', { id: debate.id }, { events: () => assert.fail('second owner') });
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const staleClaim = queuePath(cwd, debate.id, suffix(child.stdout));
  writeFileSync(staleClaim, '');
  unlinkSync(livingClaim);
  assert.deepEqual(pendingInvitationIds(cwd, space), [debate.id]);
  const calls = [];
  await sendInvitations(cwd, 'worker.mjs', { id: debate.id }, {
    events: snapshot,
    command: async args => {
      calls.push(args);
      return args[0] === 'get' ? { ok: true, details: liveAgent(args[2], 'idle') } : { ok: true, details: { started: true } };
    }
  });
  assert.equal(existsSync(staleClaim), false);
  assert.deepEqual(calls.map(args => args[0] === 'get' ? args[2] : args[4]), ['t2', 't2']);
  const resumed = readQueue(cwd, debate.id);
  assert.deepEqual(resumed.targets.map(target => target.state), ['sent', 'uncertain', 'uncertain', 'sent']);
  assert.equal(resumed.expiresAt, record.expiresAt);
});

test('the original deadline also expires waiting alignment and closed polls cannot dispatch', async t => {
  const cwd = project(t);
  const debate = create(cwd, 'debate-create');
  const queue = readQueue(cwd, debate.id);
  queue.expiresAt = Date.now() - 1;
  queue.targets[0].state = 'alignment_required';
  queue.targets[1].state = 'not_aligned';
  writeFileSync(queuePath(cwd, debate.id), JSON.stringify(queue));
  const poll = create(cwd, 'create');
  desktopRequest(cwd, 'close', { id: poll.id });
  assert.deepEqual(pendingInvitationIds(cwd, space), []);
  const neverStarts = { events: () => assert.fail('expired or closed queue started') };
  await sendInvitations(cwd, 'worker.mjs', { id: debate.id }, neverStarts);
  await sendInvitations(cwd, 'worker.mjs', { id: poll.id }, neverStarts);
  assert.deepEqual(readQueue(cwd, debate.id).targets.map(target => target.state), ['expired', 'expired']);
  assert.deepEqual(readInvitations(cwd, poll.id).map(target => target.state), ['cancelled', 'cancelled']);
  assert.equal(readQueue(cwd, debate.id).expiresAt, queue.expiresAt);
});
