// Independent async-delegate contracts. Transport and worker dispatch are mocked;
// the on-disk job and public JobManager/JobWorker interfaces are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentWorkspace } from '../lib/workspace.js';
import { JobManager } from '../lib/jobs.js';
import { JobWorker } from '../lib/job-worker.js';
import { CouncilMcpServer } from '../lib/mcp-server.js';
import { HerdrClient } from '../lib/herdr.js';

const TASK = 'Return the independent acceptance result 42';
const ADDRESS = 't120';
const OUTPUT = 'ACCEPTANCE_RESULT=42';

async function inTemp(run) {
  const root = resolve(mkdtempSync(join(tmpdir(), 'council-jobs-acceptance-')));
  const rel = relative(resolve(tmpdir()), root);
  try {
    return await run(root);
  } finally {
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function snapshot({ address = ADDRESS, turn = 12, status = 'idle', reported = true, state = 'live' } = {}) {
  return { success: true, details: { address, state, reported, turn, status: { state: status }, die_with_parent: true, cwd: 'original', keep: false } };
}

function waitResult({ address = ADDRESS, status = 'done', turn = 13, reason = 'status', ended = true, exitCode = null } = {}) {
  const raw = { children: [], ended, exit_code: exitCode, reason, signal: null, status, terminal: address, turn };
  return { success: status === 'done' && reason === 'status' && ended, target: address, terminal: address,
    ended, exitCode, reason, status, turn, isTimeout: reason === 'timeout', isBlocked: status === 'blocked',
    isError: status === 'error', isDone: status === 'done' && reason === 'status', details: raw, error: null };
}

function transport({ initial = snapshot(), ack = { started: true, status: 'idle', turn: 12 }, wait = waitResult(), read = { success: true, target: ADDRESS, content: OUTPUT, error: null } } = {}) {
  const calls = [];
  const record = (method, args) => calls.push({ method, args });
  const herdr = {
    terminalId: 't121',
    get(...args) { record('get', args); return initial; },
    send(...args) { record('send', args); return { success: true, target: args[0], output: typeof ack === 'string' ? ack : JSON.stringify(ack), error: null }; },
    wait(...args) { record('wait', args); return wait; },
    read(...args) { record('read', args); return read; },
    launchAgent(...args) { record('launchAgent', args); return { success: true, address: 't122', details: { address: 't122', turn: 0, first_message: { sent: true } } }; },
    dismiss(...args) { record('dismiss', args); return { success: true }; },
    interrupt(...args) { record('interrupt', args); return { success: true }; },
    exec(...args) { record('exec', args); throw new Error('unexpected raw hc operation'); }
  };
  return { herdr, calls };
}

function setup(root, opts = {}) {
  const workspace = new AgentWorkspace(root);
  const { herdr, calls } = transport(opts);
  const launches = [];
  const workerLauncher = (...args) => { launches.push(args); return { success: true, address: 't121' }; };
  const manager = new JobManager({ cwd: root, herdr, workspace, workerLauncher });
  const options = { task: TASK, mode: 'delegate', agent: 'codex', adopt: ADDRESS, sessionId: 'acceptance', timeoutSec: 30, callerTerminal: 't123' };
  const sessionDir = join(root, '.agent_workspace', options.sessionId);
  return { workspace, herdr, calls, launches, manager, options, sessionDir };
}

const count = (calls, method) => calls.filter(call => call.method === method).length;
const record = sessionDir => JSON.parse(readFileSync(join(sessionDir, 'job.json'), 'utf8'));

async function start(fixture, overrides = {}) {
  return await fixture.manager.startJob({ ...fixture.options, ...overrides });
}

async function runWorker(fixture, hooks = {}) {
  return await new JobWorker({ sessionDir: fixture.sessionDir, herdr: fixture.herdr, workspace: fixture.workspace, hooks }).execute();
}

async function outcome(fn) {
  try { return await fn(); } catch (error) {
    if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError || error.code === 'ERR_ASSERTION') throw error;
    if (!/invalid|unavailable|not found|unsupported|conflict|corrupt|already|claim|busy|self|timeout|timed out|blocked|incomplete|failed|uncertain|stale|delivery|acknowledg|crash|simulated|not ready|denied|existing|session/i.test(String(error))) throw error;
    return { success: false, error: String(error) };
  }
}

test('borrowed baseline 12 and acknowledged done 13 yield persisted output once without teardown', async () => inTemp(async root => {
  const f = setup(root);
  assert.equal((await start(f)).success, true);
  await runWorker(f);
  const result = await f.manager.getResult(f.options.sessionId);
  assert.equal(result.success, true);
  assert.equal(result.ready, true);
  assert.match(JSON.stringify(result), /ACCEPTANCE_RESULT=42/);
  const job = record(f.sessionDir);
  assert.equal(job.baselineTurn, 12);
  assert.equal(job.deliveryState, 'acknowledged');
  assert.equal(job.participant.ownership, 'borrowed');
  assert.equal(job.participant.address, ADDRESS);
  assert.equal(count(f.calls, 'send'), 1);
  assert.equal(f.calls.find(call => call.method === 'send').args[0], ADDRESS);
  assert.match(f.calls.find(call => call.method === 'send').args[1], /acceptance result 42/);
  assert.equal(count(f.calls, 'dismiss'), 0);
  assert.equal(count(f.calls, 'interrupt'), 0);
  const priorResultCalls = f.calls.length;
  await f.manager.getResult(f.options.sessionId);
  assert.equal(f.calls.length, priorResultCalls, 'repeated result must use persisted output');
  const priorStatusCalls = f.calls.length;
  await f.manager.getStatus(f.options.sessionId);
  assert.ok(f.calls.slice(priorStatusCalls).every(call => call.method === 'get'), 'status must not send, wait, launch or clean up');
}));

for (const [label, wait] of [
  ['stale done 12', waitResult({ turn: 12 })],
  ['startup idle 0', waitResult({ status: 'idle', turn: 0 })],
  ['startup done 0', waitResult({ turn: 0 })],
  ['message', waitResult({ status: 'working', turn: 12, reason: 'message', ended: false })],
  ['timeout', waitResult({ status: 'working', turn: 12, reason: 'timeout', ended: false })],
  ['blocked', waitResult({ status: 'blocked', turn: 12 })],
  ['exit zero', waitResult({ status: null, turn: 13, reason: 'exit', exitCode: 0 })]
]) {
  test(`borrowed ${label} is not evidence of completion`, async () => inTemp(async root => {
    const f = setup(root, { wait });
    assert.equal((await start(f)).success, true);
    // A nonterminal event may be followed by a real deadline; cap the fixture, not the worker's policy.
    const originalWait = f.herdr.wait;
    f.herdr.wait = (...args) => {
      if (count(f.calls, 'wait') >= 2) throw new Error('unexpected extra wait in fixture');
      if (count(f.calls, 'wait') === 1) {
        f.calls.push({ method: 'wait', args });
        return waitResult({ status: 'working', turn: 12, reason: 'timeout', ended: false });
      }
      return originalWait(...args);
    };
    await outcome(() => runWorker(f));
    assert.equal(count(f.calls, 'send'), 1, 'fixture must reach delivery');
    assert.ok(count(f.calls, 'wait') >= 1, 'fixture must observe the specified wait event');
    const result = await outcome(() => f.manager.getResult(f.options.sessionId));
    assert.notEqual(result.ready && result.success, true, label);
    assert.notEqual(record(f.sessionDir).state, 'completed', label);
    assert.equal(count(f.calls, 'dismiss'), 0);
  }));
}

for (const [label, ack] of [
  ['different turn', { started: true, status: 'idle', turn: 13 }],
  ['not started', { started: false, status: 'idle', turn: 12 }],
  ['missing turn', { started: true, status: 'idle' }],
  ['unknown started', { started: null, status: 'idle', turn: 12 }],
  ['malformed JSON', 'not-json']
]) {
  test(`ambiguous acknowledgement ${label} never authorizes or retries`, async () => inTemp(async root => {
    const f = setup(root, { ack });
    assert.equal((await start(f)).success, true);
    await outcome(() => runWorker(f));
    const first = record(f.sessionDir);
    assert.notEqual(first.state, 'completed');
    assert.notEqual(first.deliveryState, 'acknowledged');
    assert.match(JSON.stringify(first), /uncertain|failed|ambiguous/i, 'ambiguous delivery must be reported honestly');
    await outcome(() => start(f));
    assert.equal(f.launches.length, 1);
    assert.equal(count(f.calls, 'send'), 1);
    assert.equal(count(f.calls, 'dismiss'), 0);
  }));
}

test('interruption after delivery intent is never retried on reconnect', async () => inTemp(async root => {
  const f = setup(root);
  assert.equal((await start(f)).success, true);
  let hookCalled = false;
  let stateAtHook;
  let sendsAtHook;
  await outcome(() => runWorker(f, { beforeAttempt() {
    hookCalled = true;
    stateAtHook = record(f.sessionDir).deliveryState;
    sendsAtHook = count(f.calls, 'send');
    throw new Error('simulated crash after intent');
  } }));
  assert.equal(hookCalled, true, 'the intended crash point must actually be reached');
  assert.equal(stateAtHook, 'attempting');
  assert.equal(sendsAtHook, 0);
  const interrupted = record(f.sessionDir);
  assert.notEqual(interrupted.deliveryState, 'planned');
  assert.notEqual(interrupted.state, 'completed');
  assert.equal(count(f.calls, 'send'), 0);
  await outcome(() => start(f));
  assert.equal(f.launches.length, 1);
  assert.equal(count(f.calls, 'send'), 0);
  assert.equal(count(f.calls, 'dismiss'), 0);
}));

test('send side effect followed by lost ACK does not authorize or send twice', async () => inTemp(async root => {
  const f = setup(root);
  assert.equal((await start(f)).success, true);
  let deliveries = 0;
  let hookCalled = false;
  let stateAtSend;
  let stateAtHook;
  let sentTarget;
  let sentMessage;
  let deliveriesAtHook;
  f.herdr.send = (target, message) => {
    sentTarget = target;
    sentMessage = message;
    stateAtSend = record(f.sessionDir).deliveryState;
    deliveries++;
    return { success: true, target, output: JSON.stringify({ started: true, status: 'idle', turn: 12 }), error: null };
  };
  await outcome(() => runWorker(f, { afterAttempt() {
    hookCalled = true;
    deliveriesAtHook = deliveries;
    stateAtHook = record(f.sessionDir).deliveryState;
    throw new Error('simulated crash before acknowledgement persistence');
  } }));
  assert.equal(hookCalled, true);
  assert.equal(sentTarget, ADDRESS);
  assert.ok(sentMessage.includes(TASK));
  assert.equal(stateAtSend, 'attempting', 'intent must be durable before send');
  assert.equal(stateAtHook, 'attempting');
  assert.equal(deliveriesAtHook, 1);
  assert.equal(deliveries, 1);
  assert.notEqual(record(f.sessionDir).state, 'completed');
  assert.notEqual(record(f.sessionDir).deliveryState, 'acknowledged');
  await outcome(() => start(f));
  assert.equal(deliveries, 1);
  assert.equal(f.launches.length, 1);
  assert.equal(count(f.calls, 'dismiss'), 0);
}));

test('interruption after acknowledged delivery never sends or launches again on reconnect', async () => inTemp(async root => {
  const f = setup(root);
  assert.equal((await start(f)).success, true);
  let hookCalled = false;
  await outcome(() => runWorker(f, { beforeWait() { hookCalled = true; throw new Error('simulated crash after acknowledgement'); } }));
  assert.equal(hookCalled, true);
  assert.equal(record(f.sessionDir).deliveryState, 'acknowledged');
  assert.equal(count(f.calls, 'send'), 1);
  await outcome(() => start(f));
  assert.equal(count(f.calls, 'send'), 1);
  assert.equal(f.launches.length, 1);
  assert.notEqual(record(f.sessionDir).state, 'completed');
  assert.equal(count(f.calls, 'dismiss'), 0);
}));

test('same fingerprint reconnect/concurrent starts dispatch once, conflicts do not dispatch', async () => inTemp(async root => {
  const f = setup(root);
  const other = new JobManager({ cwd: root, herdr: f.herdr, workspace: f.workspace,
    workerLauncher: (...args) => { f.launches.push(args); return { success: true, address: 't121' }; } });
  const [a, b] = await Promise.all([outcome(() => start(f)), outcome(() => other.startJob(f.options))]);
  assert.ok(a.success || b.success, 'at least one concurrent start must succeed');
  assert.equal(f.launches.length, 1);
  const jobBefore = record(f.sessionDir);
  const replay = await f.manager.startJob(f.options);
  assert.equal(replay.success, true);
  const conflict = await outcome(() => f.manager.startJob({ ...f.options, task: `${TASK} changed` }));
  assert.equal(conflict.success, false);
  assert.equal(f.launches.length, 1);
  assert.equal(record(f.sessionDir).fingerprint, jobBefore.fingerprint);
  assert.equal(record(f.sessionDir).deadlineAt, jobBefore.deadlineAt);
  assert.equal(count(f.calls, 'send'), 0);
}));

test('reconnect to the same job does not re-check a borrowed terminal now working', async () => inTemp(async root => {
  const f = setup(root);
  const first = await start(f);
  assert.equal(first.success, true);
  const firstDeadline = record(f.sessionDir).deadlineAt;
  const callsBefore = count(f.calls, 'get');
  f.herdr.get = (...args) => {
    f.calls.push({ method: 'get', args });
    return snapshot({ status: 'working', turn: 12 });
  };
  const reconnect = await start(f);
  assert.equal(reconnect.success, true);
  assert.equal(reconnect.sessionId, first.sessionId);
  assert.equal(count(f.calls, 'get'), callsBefore, 'existing job must not be revalidated as a new adoption');
  assert.equal(f.launches.length, 1);
  assert.equal(record(f.sessionDir).deadlineAt, firstDeadline);
  assert.equal(count(f.calls, 'send'), 0);
}));

test('start does not overwrite worker progress persisted before launcher returns', async () => inTemp(async root => {
  const f = setup(root);
  let dispatches = 0;
  const manager = new JobManager({ cwd: root, herdr: f.herdr, workspace: f.workspace,
    workerLauncher: ({ jobPath }) => {
      dispatches++;
      const current = JSON.parse(readFileSync(jobPath, 'utf8'));
      current.state = 'deliberating';
      current.deliveryState = 'acknowledged';
      current.baselineTurn = 12;
      current.expectedTurn = 13;
      current.ackPayload = { started: true, status: 'idle', turn: 12 };
      writeFileSync(jobPath, JSON.stringify(current));
      return { success: true, address: 't121' };
    } });
  const started = await manager.startJob(f.options);
  assert.equal(started.success, true);
  assert.equal(dispatches, 1);
  const persisted = record(f.sessionDir);
  assert.equal(persisted.state, 'deliberating');
  assert.equal(persisted.deliveryState, 'acknowledged');
  assert.equal(persisted.expectedTurn, 13);
  assert.deepEqual(persisted.ackPayload, { started: true, status: 'idle', turn: 12 });
}));

for (const [label, overrides] of [
  ['agent', { agent: 'junie' }],
  ['permission', { permission: 'write' }],
  ['adopted address', { adopt: 't124' }],
  ['timeout', { timeoutSec: 60 }],
  ['keep policy', { keepTerminals: true }]
]) {
  test(`fingerprint conflict on ${label} cannot redispatch`, async () => inTemp(async root => {
    const f = setup(root);
    assert.equal((await start(f)).success, true);
    const original = record(f.sessionDir);
    const conflict = await outcome(() => start(f, overrides));
    assert.equal(conflict.success, false);
    assert.ok(conflict.error, 'conflict must be explained');
    assert.equal(f.launches.length, 1);
    assert.equal(count(f.calls, 'send'), 0);
    assert.equal(record(f.sessionDir).fingerprint, original.fingerprint);
    assert.equal(record(f.sessionDir).deadlineAt, original.deadlineAt);
  }));
}

test('uncertain worker launch is not repeated on reconnect', async () => inTemp(async root => {
  const f = setup(root);
  let dispatches = 0;
  const manager = new JobManager({ cwd: root, herdr: f.herdr, workspace: f.workspace,
    workerLauncher: () => { dispatches++; throw new Error('simulated uncertain worker launch'); } });
  const first = await outcome(() => manager.startJob(f.options));
  assert.equal(first.success, false);
  assert.equal(dispatches, 1);
  const persisted = record(f.sessionDir);
  assert.notEqual(persisted.state, 'completed');
  await outcome(() => manager.startJob(f.options));
  assert.equal(dispatches, 1);
  assert.equal(count(f.calls, 'send'), 0);
  assert.equal(count(f.calls, 'launchAgent'), 0);
}));

test('different sessions cannot concurrently claim the same borrowed address', { timeout: 5000 }, async () => inTemp(async root => {
  const first = setup(root);
  const second = { ...first, options: { ...first.options, sessionId: 'acceptance-second' },
    sessionDir: join(root, '.agent_workspace', 'acceptance-second') };
  assert.equal((await start(first)).success, true);
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const enteredHook = new Promise(resolve => { entered = resolve; });
  const firstWorker = runWorker(first, { async beforeAttempt() { entered(); await held; } });
  try {
    await Promise.race([enteredHook, firstWorker.then(() => { throw new Error('first worker completed before claim overlap'); })]);
    assert.notEqual(record(first.sessionDir).state, 'completed');
    const firstSendCount = count(first.calls, 'send');
    const secondStart = await outcome(() => start(second));
    let evidence = secondStart;
    if (secondStart.success) {
      await outcome(() => runWorker(second));
      assert.notEqual(record(second.sessionDir).state, 'completed');
      const secondResult = await outcome(() => second.manager.getResult(second.options.sessionId));
      assert.notEqual(secondResult.success && secondResult.ready, true);
      evidence = { job: record(second.sessionDir), result: secondResult };
    }
    assert.equal(count(first.calls, 'send'), firstSendCount, 'second session must not deliver to claimed terminal');
    assert.match(JSON.stringify(evidence), /claim|busy|already|in use|uncertain/i);
    assert.equal(count(first.calls, 'dismiss'), 0);
  } finally {
    release();
    await firstWorker;
  }
  assert.equal(count(first.calls, 'send'), 1);
}));

for (const [label, initial] of [
  ['unreported', snapshot({ reported: false, turn: 0 })],
  ['working', snapshot({ status: 'working' })],
  ['blocked', snapshot({ status: 'blocked' })],
  ['error', snapshot({ status: 'error' })],
  ['finished', snapshot({ state: 'finished' })],
  ['nonexistent', { success: false, error: 'terminal not found' }]
]) {
  test(`invalid borrowed ${label} is never sent or torn down`, async () => inTemp(async root => {
    const f = setup(root, { initial });
    const started = await outcome(() => start(f));
    if (started.success) {
      await outcome(() => runWorker(f));
      assert.ok(count(f.calls, 'get') > 0, 'worker must inspect the borrowed terminal');
      assert.notEqual(record(f.sessionDir).state, 'completed');
      const result = await outcome(() => f.manager.getResult(f.options.sessionId));
      assert.notEqual(result.success && result.ready, true);
      assert.match(JSON.stringify({ job: record(f.sessionDir), result }), /unreported|not found|finished|busy|working|blocked|error|invalid|unavailable/i);
    } else {
      assert.ok(started.error, 'rejection must explain the failure');
    }
    assert.equal(count(f.calls, 'send'), 0);
    assert.equal(count(f.calls, 'dismiss'), 0);
    assert.equal(count(f.calls, 'interrupt'), 0);
    assert.equal(count(f.calls, 'exec'), 0);
  }));
}

test('original caller cannot be adopted even when worker has a different terminal id', async () => inTemp(async root => {
  const f = setup(root, { initial: snapshot({ address: 't123' }) });
  const started = await outcome(() => start(f, { adopt: 't123' }));
  if (started.success) await outcome(() => runWorker(f));
  assert.equal(count(f.calls, 'send'), 0);
  assert.equal(count(f.calls, 'dismiss'), 0);
}));

test('read failure cannot become a completed result or dismiss a borrowed terminal', async () => inTemp(async root => {
  const f = setup(root, { read: { success: false, content: OUTPUT, error: 'read failed' } });
  assert.equal((await start(f)).success, true);
  await outcome(() => runWorker(f));
  assert.notEqual(record(f.sessionDir).state, 'completed');
  const result = await outcome(() => f.manager.getResult(f.options.sessionId));
  assert.notEqual(result.success && result.ready, true);
  assert.match(JSON.stringify({ job: record(f.sessionDir), result }), /read/i);
  assert.equal(count(f.calls, 'dismiss'), 0);
}));

for (const [label, keep, wait, shouldDismiss] of [
  ['completed', false, waitResult({ address: 't122', turn: 1 }), true],
  ['completed with keep', true, waitResult({ address: 't122', turn: 1 }), false],
  ['timeout', false, waitResult({ address: 't122', status: 'working', turn: 0, reason: 'timeout', ended: false }), false]
]) {
  test(`spawned terminal cleanup: ${label}`, async () => inTemp(async root => {
    const f = setup(root, { initial: snapshot({ address: 't122', turn: 0 }), ack: { started: true, status: 'idle', turn: 0 }, wait });
    assert.equal((await start(f, { adopt: undefined, keepTerminals: keep })).success, true);
    await outcome(() => runWorker(f));
    assert.equal(count(f.calls, 'launchAgent'), 1);
    assert.ok(count(f.calls, 'wait') >= 1);
    const dismissed = f.calls.filter(call => call.method === 'dismiss');
    assert.equal(dismissed.length, shouldDismiss ? 1 : 0);
    if (shouldDismiss) {
      assert.equal(dismissed[0].args[0], 't122');
      assert.ok(f.calls.indexOf(dismissed[0]) > f.calls.findIndex(call => call.method === 'read'));
      assert.equal((await f.manager.getResult(f.options.sessionId)).ready, true);
    } else if (label === 'completed with keep') {
      assert.equal((await f.manager.getResult(f.options.sessionId)).ready, true);
    } else if (label === 'timeout') {
      assert.notEqual(record(f.sessionDir).state, 'completed');
    }
    await outcome(() => f.manager.getResult(f.options.sessionId));
    assert.equal(count(f.calls, 'dismiss'), shouldDismiss ? 1 : 0);
  }));
}

test('corrupt existing record fails closed without replacement or worker dispatch', async () => inTemp(async root => {
  const f = setup(root);
  mkdirSync(f.sessionDir, { recursive: true });
  const path = join(f.sessionDir, 'job.json');
  writeFileSync(path, '{broken');
  const result = await outcome(() => start(f));
  assert.equal(result.success, false);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  assert.equal(f.launches.length, 0);
  assert.equal(count(f.calls, 'send'), 0);
}));

for (const [label, overrides] of [
  ['unsupported mode', { mode: 'review' }],
  ['empty task', { task: '' }],
  ['unsafe session id', { sessionId: '../outside' }],
  ['invalid permission', { permission: 'admin' }]
]) {
  test(`invalid ${label} is rejected before dispatch or delivery`, async () => inTemp(async root => {
    const f = setup(root);
    const result = await outcome(() => start(f, overrides));
    assert.equal(result.success, false);
    assert.ok(result.error, 'rejection must expose a diagnostic');
    assert.equal(f.launches.length, 0);
    assert.equal(count(f.calls, 'send'), 0);
    assert.equal(count(f.calls, 'launchAgent'), 0);
  }));
}

test('legacy session is not reinitialized or replaced by an async job', async () => inTemp(async root => {
  const f = setup(root);
  mkdirSync(f.sessionDir, { recursive: true });
  const legacy = join(f.sessionDir, 'session.json');
  const bytes = '{"schema":"legacy","task":"keep me"}';
  writeFileSync(legacy, bytes);
  const result = await outcome(() => start(f));
  assert.equal(result.success, false);
  assert.equal(readFileSync(legacy, 'utf8'), bytes);
  assert.equal(f.launches.length, 0);
}));

test('start and status return before deferred worker, result is not ready', async () => inTemp(async root => {
  const f = setup(root);
  const started = await start(f);
  assert.equal(started.success, true);
  assert.equal(f.launches.length, 1);
  assert.equal(count(f.calls, 'send'), 0);
  const status = await f.manager.getStatus(f.options.sessionId);
  const result = await f.manager.getResult(f.options.sessionId);
  assert.equal(status.success, true);
  assert.equal(result.ready, false);
  assert.equal(count(f.calls, 'wait'), 0);
  assert.equal(count(f.calls, 'send'), 0);
}));

test('reconnect preserves the original absolute deadline and cannot extend it', async () => inTemp(async root => {
  const f = setup(root);
  assert.equal((await start(f)).success, true);
  const first = record(f.sessionDir);
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
  assert.ok(Number.isFinite(timestamp(first.deadlineAt)), 'deadline must be an absolute timestamp');
  assert.ok(timestamp(first.deadlineAt) > timestamp(first.createdAt));
  const reconnect = await start(f);
  assert.equal(reconnect.success, true);
  assert.equal(record(f.sessionDir).deadlineAt, first.deadlineAt);
  assert.equal(f.launches.length, 1);
}));

test('an expired persisted deadline prevents task delivery and preserves the terminal', async () => inTemp(async root => {
  const f = setup(root);
  assert.equal((await start(f)).success, true);
  const job = record(f.sessionDir);
  const expired = Date.now() - 60000;
  job.deadlineAt = typeof job.deadlineAt === 'number' ? expired : new Date(expired).toISOString();
  writeFileSync(join(f.sessionDir, 'job.json'), JSON.stringify(job));
  await outcome(() => runWorker(f));
  assert.equal(count(f.calls, 'send'), 0);
  assert.equal(count(f.calls, 'dismiss'), 0);
  assert.notEqual(record(f.sessionDir).state, 'completed');
  const result = await outcome(() => f.manager.getResult(f.options.sessionId));
  assert.notEqual(result.success && result.ready, true);
  assert.match(JSON.stringify({ job: record(f.sessionDir), result }), /deadline|timeout|timed out|expired/i);
}));

test('deadline crossed during borrowed readiness prevents the initial send', async () => inTemp(async root => {
  const f = setup(root);
  assert.equal((await start(f)).success, true);
  const deadline = Date.parse(record(f.sessionDir).deadlineAt);
  const originalNow = Date.now;
  const originalGet = f.herdr.get;
  let now = deadline - 1000;
  let readyChecked = false;
  try {
    Date.now = () => now;
    f.herdr.get = (...args) => {
      const result = originalGet(...args);
      readyChecked = true;
      now = deadline + 1;
      return result;
    };
    await runWorker(f);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(readyChecked, true, 'the readiness check must cross the deadline');
  assert.equal(count(f.calls, 'send'), 0, 'expired job must not deliver the task');
  assert.equal(count(f.calls, 'dismiss'), 0);
  assert.notEqual(record(f.sessionDir).state, 'completed');
}));

test('ambiguous borrowed delivery retains the address claim until deadline', async () => inTemp(async root => {
  const f = setup(root, { ack: { started: null, status: 'idle', turn: 12 } });
  assert.equal((await start(f)).success, true);
  await runWorker(f);
  assert.equal(count(f.calls, 'send'), 1);
  assert.equal(record(f.sessionDir).deliveryState, 'uncertain');
  const second = await outcome(() => start(f, { sessionId: 'acceptance-second', task: 'Different task' }));
  assert.equal(second.success, false, 'a second job must not claim a terminal with uncertain delivery');
  assert.match(JSON.stringify(second), /claim|busy|already|in use|uncertain/i);
  assert.equal(f.launches.length, 1);
  assert.equal(count(f.calls, 'send'), 1);
}));

test('spawned process exit zero alone cannot complete a delegate job', async () => inTemp(async root => {
  const client = new HerdrClient({ cwd: root });
  client.exec = () => ({ success: true, stdout: JSON.stringify({
    terminal: 't122', status: null, reason: 'exit', ended: true, exit_code: 0, turn: 0
  }) });
  const realWrapperResult = client.wait('t122');
  assert.equal(realWrapperResult.success, true, 'real HerdrClient permits clean process exit');
  const f = setup(root, { wait: realWrapperResult });
  assert.equal((await start(f, { adopt: undefined })).success, true);
  await runWorker(f);
  assert.equal(count(f.calls, 'wait'), 1);
  assert.equal(count(f.calls, 'read'), 0, 'exit without a completed agent turn must not collect output');
  assert.equal(count(f.calls, 'dismiss'), 0);
  assert.notEqual(record(f.sessionDir).state, 'completed');
}));

test('owned message event through the Herdr adapter is followed by fresh done', async () => inTemp(async root => {
  const f = setup(root);
  const client = new HerdrClient({ cwd: root });
  const events = [
    { terminal: 't122', status: 'working', reason: 'message', ended: false, turn: 0, exit_code: null },
    { terminal: 't122', status: 'done', reason: 'status', ended: true, turn: 1, exit_code: null }
  ];
  let observed = 0;
  client.exec = () => {
    observed++;
    const event = events.shift();
    return { success: Boolean(event), stdout: event ? JSON.stringify(event) : '', stderr: '' };
  };
  f.herdr.wait = client.wait.bind(client);
  assert.equal((await start(f, { adopt: undefined })).success, true);
  await runWorker(f);
  assert.equal(observed, 2, 'must consume message and then fresh done');
  const result = await f.manager.getResult(f.options.sessionId);
  assert.equal(result.success && result.ready, true);
  assert.match(result.output, /ACCEPTANCE_RESULT=42/);
}));

test('owned startup idle through the Herdr adapter is followed by fresh done', async () => inTemp(async root => {
  const f = setup(root);
  const client = new HerdrClient({ cwd: root });
  const events = [
    { terminal: 't122', status: 'idle', reason: 'status', ended: true, turn: 0, exit_code: null },
    { terminal: 't122', status: 'done', reason: 'status', ended: true, turn: 1, exit_code: null }
  ];
  let observed = 0;
  client.exec = () => {
    observed++;
    const event = events.shift();
    return { success: Boolean(event), stdout: event ? JSON.stringify(event) : '', stderr: '' };
  };
  f.herdr.wait = client.wait.bind(client);
  assert.equal((await start(f, { adopt: undefined })).success, true);
  await runWorker(f);
  assert.equal(observed, 2);
  const result = await f.manager.getResult(f.options.sessionId);
  assert.equal(result.success && result.ready, true);
  assert.match(result.output, /ACCEPTANCE_RESULT=42/);
}));

test('borrowed failed wait wrapper cannot authorize fresh-looking done payload', async () => inTemp(async root => {
  const wait = { ...waitResult(), success: false, error: 'hc subprocess failed' };
  const f = setup(root, { wait });
  assert.equal((await start(f)).success, true);
  await runWorker(f);
  const result = await f.manager.getResult(f.options.sessionId);
  assert.notEqual(result.success && result.ready, true);
  assert.match(JSON.stringify(result), /hc subprocess failed/);
  assert.equal(count(f.calls, 'read'), 0);
  assert.equal(count(f.calls, 'dismiss'), 0);
}));

test('long valid session id produces an acceptable owned terminal name', async () => inTemp(async root => {
  const f = setup(root);
  const sessionId = 'a-valid-council-session-id-for-a-long-running-task';
  let launchName;
  const originalLaunch = f.herdr.launchAgent;
  f.herdr.launchAgent = args => { launchName = args.name; return originalLaunch(args); };
  assert.equal((await start(f, { adopt: undefined, sessionId })).success, true);
  await new JobWorker({ sessionDir: join(root, '.agent_workspace', sessionId), herdr: f.herdr, workspace: f.workspace }).execute();
  assert.equal(typeof launchName, 'string');
  assert.ok(launchName.length <= 32, `Herdr terminal name exceeds 32 characters: ${launchName}`);
}));

test('failed first-message delivery preserves the spawned participant address', async () => inTemp(async root => {
  const f = setup(root);
  f.herdr.launchAgent = args => {
    f.calls.push({ method: 'launchAgent', args: [args] });
    return { success: true, address: 't122', details: { address: 't122', first_message: { sent: false } } };
  };
  assert.equal((await start(f, { adopt: undefined })).success, true);
  await runWorker(f);
  const result = await f.manager.getResult(f.options.sessionId);
  assert.equal(result.success, false);
  assert.equal(result.participant?.address, 't122', 'operator must be able to inspect the spawned terminal');
  assert.equal(count(f.calls, 'read'), 0);
  assert.equal(count(f.calls, 'dismiss'), 0);
}));

test('failed worker dispatch remains visible after status and reconnect', async () => inTemp(async root => {
  const f = setup(root);
  let dispatches = 0;
  const manager = new JobManager({ cwd: root, herdr: f.herdr, workspace: f.workspace,
    workerLauncher: () => { dispatches++; return { success: false, error: 'hc rejected worker launch' }; } });
  const first = await manager.startJob(f.options);
  const status = await manager.getStatus(f.options.sessionId);
  const replay = await manager.startJob(f.options);
  assert.equal(first.success, false);
  assert.match(first.error, /rejected worker launch/);
  assert.equal(replay.success, false, 'failed dispatch must not reconnect as a healthy start');
  assert.match(JSON.stringify(status), /rejected worker launch/);
  assert.equal(dispatches, 1);
}));

test('truncated completed job record fails closed through result API', async () => inTemp(async root => {
  const f = setup(root);
  assert.equal((await start(f)).success, true);
  writeFileSync(join(f.sessionDir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', state: 'completed' }));
  const result = await f.manager.getResult(f.options.sessionId);
  assert.equal(result.success, false);
  assert.notEqual(result.ready && result.success, true);
  assert.match(JSON.stringify(result), /corrupt|invalid|incomplete|missing|schema/i);
}));

test('async MCP reports pending, ready and failed results with consistent tool errors', async () => inTemp(async root => {
  const f = setup(root);
  const server = new CouncilMcpServer({ cwd: root });
  server.jobManager = f.manager;
  let response;
  server.send = value => { response = value; };
  const call = async (name, args) => {
    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return { isError: response.result.isError === true, body: JSON.parse(response.result.content[0].text) };
  };
  const started = await call('council_start', f.options);
  assert.equal(started.isError, false);
  assert.equal(started.body.success, true);
  const pending = await call('council_result', { sessionId: f.options.sessionId });
  assert.equal(pending.isError, false);
  assert.equal(pending.body.ready, false);
  await runWorker(f);
  const ready = await call('council_result', { sessionId: f.options.sessionId });
  assert.equal(ready.isError, false);
  assert.equal(ready.body.success && ready.body.ready, true);
  assert.match(ready.body.output, /ACCEPTANCE_RESULT=42/);
  const missing = await call('council_session_status', { sessionId: 'missing' });
  assert.equal(missing.isError, true);
  assert.equal(missing.body.success, false);
  const invalid = await call('council_start', { mode: 'review', task: TASK });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.body.success, false);
}));

test('async CLI result exposes pending and ready JSON and fails for missing sessions', async () => inTemp(async root => {
  const f = setup(root);
  const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal((await start(f)).success, true);
  const pending = invoke('result', '--session', f.options.sessionId);
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).ready, false);
  await runWorker(f);
  const ready = invoke('result', '--session', f.options.sessionId);
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(JSON.parse(ready.stdout).output, /ACCEPTANCE_RESULT=42/);
  const missing = invoke('result', '--session', 'missing');
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).success, false);
}));

test('MCP read remains usable during a deferred job and does not send its initial task', async () => inTemp(async root => {
  const f = setup(root);
  assert.equal((await start(f)).success, true);
  const server = new CouncilMcpServer({ cwd: root });
  server.herdr = f.herdr;
  let response;
  server.send = value => { response = value; };
  await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'council_read', arguments: { target: ADDRESS } } });
  assert.equal(response.id, 1);
  assert.notEqual(response.result.isError, true);
  assert.match(JSON.stringify(response.result), /ACCEPTANCE_RESULT=42/);
  assert.equal(count(f.calls, 'read'), 1);
  assert.equal(count(f.calls, 'send'), 0);
  assert.equal(count(f.calls, 'wait'), 0);
  assert.equal(count(f.calls, 'dismiss'), 0);
}));

test('async MCP tools are discoverable alongside existing delegate and read tools', () => {
  const server = new CouncilMcpServer();
  const names = server.getToolsList().map(tool => tool.name);
  for (const name of ['council_start', 'council_session_status', 'council_result', 'council_delegate', 'council_read']) {
    assert.ok(names.includes(name), `missing public MCP tool ${name}`);
  }
});