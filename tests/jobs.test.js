import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobManager, computeFingerprint, validateAdoptedTerminal } from '../lib/jobs.js';
import { JobWorker } from '../lib/job-worker.js';
import { HerdrClient } from '../lib/herdr.js';
import { AgentWorkspace } from '../lib/workspace.js';
import { alignmentKey, alignmentLabel } from '../herdr/mods/council/runtime/alignment.mjs';

async function inTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'council-jobs-unit-'));
  try {
    return await fn(root);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

test('computeFingerprint is deterministic and sensitive to input changes', () => {
  const base = {
    mode: 'delegate',
    task: 'compute hash',
    agent: 'codex',
    adopt: 't120',
    permission: 'read',
    timeoutSec: 180,
    keepTerminals: false
  };

  const fp1 = computeFingerprint(base);
  const fp2 = computeFingerprint({ ...base });
  assert.equal(fp1, fp2);

  const fpDifferentTask = computeFingerprint({ ...base, task: 'different task' });
  assert.notEqual(fp1, fpDifferentTask);

  const fpDifferentAgent = computeFingerprint({ ...base, agent: 'claude' });
  assert.notEqual(fp1, fpDifferentAgent);

  const fpDifferentAdopt = computeFingerprint({ ...base, adopt: 't121' });
  assert.notEqual(fp1, fpDifferentAdopt);
});

test('validateAdoptedTerminal detects caller address self-adoption', () => {
  const caller = 't120';
  const herdr = {
    terminalId: caller,
    get(target) {
      const details = { address: target, state: 'live', reported: true, status: { state: 'idle', app: 'codex' }, pid: 42, created_ms: 9001 };
      details.labels = { [alignmentKey]: alignmentLabel(details, 'aligned').split('=')[1] };
      return { success: true, details };
    }
  };

  const res1 = validateAdoptedTerminal({ adopt: caller, callerTerminal: caller, herdr });
  assert.equal(res1.valid, false);
  assert.match(res1.error, /caller terminal/);

  const res2 = validateAdoptedTerminal({ adopt: 't121', callerTerminal: caller, herdr });
  assert.equal(res2.valid, true);
  assert.equal(res2.canonicalAddress, 't121');
});

test('JobManager startJob input validation rejects invalid inputs', async () => inTemp(async root => {
  const workspace = new AgentWorkspace(root);
  const manager = new JobManager({ cwd: root, workspace });

  // Unsupported mode
  const r1 = await manager.startJob({ mode: 'unknown-mode', task: 'Review task' });
  assert.equal(r1.success, false);
  assert.match(r1.error, /Unsupported mode/);

  // Missing task
  const r2 = await manager.startJob({ mode: 'delegate', task: '' });
  assert.equal(r2.success, false);
  assert.match(r2.error, /required/);

  // Invalid permission
  const r3 = await manager.startJob({ mode: 'delegate', task: 'Task', permission: 'superuser' });
  assert.equal(r3.success, false);
  assert.match(r3.error, /permission/);

  // Unsafe session ID
  const r4 = await manager.startJob({ mode: 'delegate', task: 'Task', sessionId: '../../etc' });
  assert.equal(r4.success, false);
  assert.match(r4.error, /unsafe/i);

  // Non-positive timeout
  const r5 = await manager.startJob({ mode: 'delegate', task: 'Task', timeoutSec: -10 });
  assert.equal(r5.success, false);
  assert.match(r5.error, /timeoutSec/);
}));

test('JobManager startJob and result machine contract returns JSON snapshot', async () => inTemp(async root => {
  const workspace = new AgentWorkspace(root);
  let launched = 0;
  const workerLauncher = () => { launched++; return { success: true, address: 't-worker' }; };
  const manager = new JobManager({ cwd: root, workspace, workerLauncher });

  const started = await manager.startJob({
    mode: 'delegate',
    task: 'Sample delegation',
    agent: 'codex',
    sessionId: 'test-session',
    timeoutSec: 60
  });

  assert.equal(started.success, true);
  assert.equal(started.sessionId, 'test-session');
  assert.equal(started.state, 'starting');
  assert.equal(started.participant.agent, 'codex');
  assert.equal(started.participant.permission, 'read');
  assert.equal(launched, 1);

  // Status check
  const status = await manager.getStatus('test-session');
  assert.equal(status.success, true);
  assert.equal(status.state, 'starting');
  assert.equal(status.deliveryState, 'planned');
  assert.equal(status.isExpired, false);

  // Result before completion
  const result = await manager.getResult('test-session');
  assert.equal(result.success, true);
  assert.equal(result.ready, false);
  assert.equal(result.state, 'starting');
}));

test('start --task-file reconnects by the UTF-8 brief content', async () => inTemp(async root => {
  const task = 'Review Unicode and Windows paths.\n    C:\\测试\\π.js\n'.repeat(1500).trim();
  const file = join(root, 'task brief.md');
  writeFileSync(file, task, 'utf8');
  const manager = new JobManager({ cwd: root, workerLauncher: () => ({ success: true, address: 't-worker' }) });
  await manager.startJob({ sessionId: 'from-file', task });
  const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));
  const start = (...args) => spawnSync(process.execPath, [cli, 'start', '--session', 'from-file', '--task-file', file, ...args], {
    cwd: root, encoding: 'utf8', timeout: 5000
  });

  const reconnected = start();
  assert.equal(reconnected.status, 0, reconnected.stderr);
  assert.equal(JSON.parse(reconnected.stdout).reconnect, true);
  assert.match(start('--task', 'different source').stderr, /one task source/);

  writeFileSync(file, 'A different brief', 'utf8');
  assert.match(start().stderr, /conflicting parameters/);
  writeFileSync(file, Buffer.from([0xff]));
  assert.match(start().stderr, /valid UTF-8/);
}));

test('status verifies a claimed worker and reports a retained claim without changing delivery', async () => inTemp(async root => {
  const address = 't120';
  const pid = 1234;
  let terminal;
  let launches = 0;
  const herdr = {
    get(target, { timeout }) {
      assert.equal(target, address);
      assert.ok(timeout <= 1000);
      return { success: Boolean(terminal), details: terminal };
    }
  };
  const manager = new JobManager({ cwd: root, herdr, workerLauncher: () => {
    launches++;
    return { success: true, address };
  } });
  const options = { sessionId: 'worker-health', task: 'Review a parser change' };
  const started = await manager.startJob(options);
  const dir = join(root, '.agent_workspace', started.sessionId);
  const file = join(dir, 'job.json');
  const job = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(job.worker, { status: 'claimed', address, pid });
  Object.assign(job, { state: 'deliberating', deliveryState: 'acknowledged', awaitingInput: true });
  writeFileSync(file, JSON.stringify(job));
  const lock = join(dir, '.locks', 'worker.lock');
  mkdirSync(join(dir, '.locks'));
  writeFileSync(lock, JSON.stringify({ pid }));

  terminal = { address, pid, state: 'live', labels: { 'council.worker': job.worker.label } };
  const active = await manager.getStatus(started.sessionId);
  assert.equal(active.worker.observation.state, 'live');
  assert.equal(active.outcome, 'awaiting_input');

  terminal = { ...terminal, state: 'finished', reason: 'killed', exit_code: 1 };
  const stopped = await manager.getStatus(started.sessionId);
  assert.equal(stopped.outcome, 'worker_stopped');
  assert.equal(stopped.deliveryState, 'acknowledged');
  assert.deepEqual(stopped.worker.observation, { state: 'stopped', reason: 'killed', exitCode: 1, retainedClaim: true });
  const result = await manager.getResult(started.sessionId);
  assert.equal(result.success, false);
  assert.equal(result.ready, false);
  assert.equal(result.outcome, 'worker_stopped');
  assert.match(result.nextAction, /existing task and its answer/);
  assert.equal((await manager.startJob(options)).reconnect, true);
  assert.equal(launches, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), job);
  assert.equal(existsSync(lock), true);

  for (const unverified of [{ ...terminal, pid: pid + 1 }, { ...terminal, labels: {} }, null]) {
    terminal = unverified;
    const unverifiedStatus = await manager.getStatus(started.sessionId);
    assert.deepEqual(unverifiedStatus.worker.observation, { state: 'unknown' });
    assert.equal(unverifiedStatus.outcome, 'awaiting_input');
  }

  herdr.get = () => {
    const completed = { ...job, state: 'completed', result: { output: 'Saved just before exit' } };
    writeFileSync(file, JSON.stringify(completed));
    return { success: true, details: { address, pid, state: 'finished', labels: { 'council.worker': job.worker.label } } };
  };
  const complete = await manager.getResult(started.sessionId);
  assert.equal(complete.outcome, 'completed');
  assert.equal(complete.output, 'Saved just before exit');
}));

test('borrowed job responses identify the observed app and leave permissions unspecified', async () => inTemp(async root => {
  const details = {
    address: 't121', state: 'live', reported: true, pid: 42, created_ms: 9001,
    status: { state: 'idle', app: 'junie' }
  };
  details.labels = { [alignmentKey]: alignmentLabel(details, 'aligned').split('=')[1] };
  const manager = new JobManager({
    cwd: root,
    herdr: { get: () => ({ success: true, details }) },
    workerLauncher: () => ({ success: true, address: 't122' })
  });
  const options = { adopt: 't121', sessionId: 'borrowed', task: 'Review the change' };
  const started = await manager.startJob(options);
  assert.equal(started.participant.agent, 'junie');
  assert.equal(started.participant.permission, null);

  const jobPath = join(root, '.agent_workspace', options.sessionId, 'job.json');
  const legacy = JSON.parse(readFileSync(jobPath, 'utf8'));
  Object.assign(legacy.participant, { agent: 'codex', permission: 'read' });
  writeFileSync(jobPath, JSON.stringify(legacy));

  const reconnected = await manager.startJob(options);
  assert.equal(reconnected.reconnect, true);
  const status = await manager.getStatus(options.sessionId);
  const result = await manager.getResult(options.sessionId);
  for (const response of [reconnected, status, result]) {
    assert.deepEqual(response.participant, started.participant);
  }
  assert.deepEqual(JSON.parse(readFileSync(jobPath, 'utf8')), legacy);
}));

test('unconfirmed delegation reports how to follow up on the readiness notice without creating a job', async () => inTemp(async root => {
  const address = 't121';
  const details = {
    address, state: 'live', reported: true, pid: 42, created_ms: 9001,
    status: { state: 'idle', app: 'junie' }
  };
  let status = 'sent';
  const manager = new JobManager({
    cwd: root,
    herdr: {
      get: () => ({ success: true, details }),
      requestAlignment(target) {
        assert.equal(target, address);
        return { state: 'unconfirmed', request: { status } };
      }
    },
    workerLauncher: () => assert.fail('readiness must not launch a job')
  });
  const options = { adopt: address, sessionId: 'unconfirmed', task: 'Review the change' };
  const sent = await manager.startJob(options);
  assert.equal(sent.success, false);
  assert.equal(sent.alignmentRequest.status, 'sent');
  assert.match(sent.nextAction, /council alignment status t121/);

  status = 'uncertain';
  const uncertain = await manager.startJob(options);
  assert.equal(uncertain.alignmentRequest.status, 'uncertain');
  assert.match(uncertain.nextAction, /hc read t121 before requesting another check/);
  assert.equal(existsSync(join(root, '.agent_workspace', options.sessionId)), false);
}));

test('a changed borrowed turn prevents sending and releases its claim as a confirmed delivery failure', async () => inTemp(async root => {
  const details = {
    address: 't121', state: 'live', reported: true, pid: 42, created_ms: 9001, turn: 12,
    status: { state: 'done', app: 'junie' }
  };
  details.labels = { [alignmentKey]: alignmentLabel(details, 'aligned').split('=')[1] };
  const herdr = new HerdrClient({ cwd: root });
  herdr.get = () => ({ success: true, details });
  herdr.exec = () => assert.fail('a changed turn must prevent the hc send call');
  const manager = new JobManager({ cwd: root, herdr, workerLauncher: () => ({ success: true, address: 't122' }) });
  const options = { adopt: 't121', sessionId: 'first', task: 'Review the change' };
  assert.equal((await manager.startJob(options)).success, true);

  await new JobWorker({
    sessionDir: join(root, '.agent_workspace', options.sessionId), herdr,
    hooks: { beforeDelivery: () => { details.turn++; } }
  }).execute();

  const result = await manager.getResult(options.sessionId);
  assert.equal(result.success, false);
  assert.equal(result.deliveryState, 'failed');
  assert.match(result.error, /changed turns/);
  assert.match(result.nextAction, /new session ID/);
  const retry = await manager.startJob(options);
  assert.equal(retry.success, false);
  assert.equal(retry.nextAction, result.nextAction);
  assert.equal((await manager.startJob({ ...options, sessionId: 'second' })).success, true);
}));

test('an aligned replacement at the selected address cannot receive the borrowed assignment', async () => inTemp(async root => {
  const details = { address: 't121', state: 'live', reported: true, pid: 42, created_ms: 9001, turn: 12,
    status: { state: 'done', app: 'junie' } };
  const label = () => { details.labels = { [alignmentKey]: alignmentLabel(details, 'aligned').split('=')[1] }; };
  const replace = () => { details.pid++; details.created_ms++; label(); };
  label();
  const herdr = new HerdrClient({ cwd: root });
  herdr.get = () => ({ success: true, details });
  herdr.exec = () => assert.fail('the original assignment must not be sent to the replacement');
  const manager = new JobManager({ cwd: root, herdr, workerLauncher: () => ({ success: true, address: 't122' }) });
  for (const sessionId of ['before-worker', 'before-send']) {
    const start = await manager.startJob({ adopt: details.address, sessionId, task: 'Review build checks' });
    assert.equal(start.success, true);
    const hooks = {};
    if (sessionId === 'before-worker') replace();
    else hooks.beforeDelivery = replace;
    const sessionDir = join(root, '.agent_workspace', sessionId);
    const result = await new JobWorker({ sessionDir, herdr, hooks }).execute();
    assert.equal(result.success, false);
    assert.match(result.error, /agent in t121 changed before delivery/);
  }
}));

test('JobWorker locks prevent concurrent execution and release locks on completion', async () => inTemp(async root => {
  const workspace = new AgentWorkspace(root);
  const manager = new JobManager({ cwd: root, workspace, workerLauncher: () => ({ success: true }) });
  await manager.startJob({ sessionId: 'lock-test', task: 'test locks', timeoutSec: 30 });

  const sessionDir = join(root, '.agent_workspace', 'lock-test');
  const herdr = {
    terminalId: 't-worker',
    launchAgent() { return { success: true, address: 't-owned', details: { first_message: { sent: true } } }; },
    wait() { return { success: true, status: 'done', reason: 'status', ended: true, turn: 1, target: 't-owned' }; },
    captureTurn() { return { success: true, content: 'DONE_CONTENT', captureScope: 'screen' }; },
    dismiss() { return { success: true }; }
  };

  const worker = new JobWorker({ sessionDir, herdr, workspace });
  const execPromise = worker.execute();

  const finished = await execPromise;
  assert.equal(finished.success, true);
  assert.equal(finished.output, 'DONE_CONTENT');

  // Verify worker lock was cleaned up after execution
  const lockFile = join(sessionDir, '.locks', 'worker.lock');
  assert.equal(existsSync(lockFile), false, 'worker.lock should be cleaned up on completion');
}));

test('an acknowledged borrowed job exposes the approval pause and captures the resumed turn once', async () => inTemp(async root => {
  const address = 't121';
  const identity = '9001:42:junie';
  const details = {
    address, state: 'live', reported: true, pid: 42, created_ms: 9001, turn: 12,
    status: { state: 'idle', app: 'junie' }
  };
  details.labels = { [alignmentKey]: alignmentLabel(details, 'aligned').split('=')[1] };
  let approve;
  const approved = new Promise(resolve => { approve = resolve; });
  let sends = 0;
  let captures = 0;
  const herdr = {
    get: () => ({ success: true, details }),
    send() {
      sends++;
      return { success: true, terminalIdentity: identity, output: JSON.stringify({ started: true, turn: 12 }) };
    },
    wait() {
      return { success: false, isBlocked: true, ended: true, terminal: address, reason: 'status', status: 'blocked', turn: 13 };
    },
    async waitForApproval(target, turn, options) {
      assert.equal(target, address);
      assert.equal(turn, 13);
      assert.equal(options.identity, identity);
      options.onProgress({ status: 'blocked', turn });
      await approved;
      options.onProgress({ status: 'working', turn });
      return { success: true, turn: 14, status: 'done' };
    },
    captureTurn(target, turn, options) {
      captures++;
      assert.equal(target, address);
      assert.equal(turn, 14);
      assert.equal(options.identity, identity);
      return { success: true, content: 'Approved and completed' };
    },
    dismiss() { assert.fail('A borrowed terminal must stay open'); }
  };
  const manager = new JobManager({ cwd: root, herdr, workerLauncher: () => ({ success: true, address: 't122' }) });
  const options = { adopt: address, sessionId: 'approval', task: 'Review the change' };
  const started = await manager.startJob(options);
  const worker = new JobWorker({ sessionDir: join(root, '.agent_workspace', started.sessionId), herdr });
  const execution = worker.execute();
  const status = await manager.getStatus(started.sessionId);
  const pending = await manager.getResult(started.sessionId);
  assert.equal(status.outcome, 'awaiting_input');
  assert.equal(pending.ready, false);
  assert.equal(pending.outcome, 'awaiting_input');
  assert.match(pending.nextAction, /address the prompt/);
  assert.equal((await manager.startJob(options)).reconnect, true);
  assert.equal(captures, 0);

  approve();
  assert.equal((await execution).success, true);
  const result = await manager.getResult(started.sessionId);
  assert.equal(result.turn, 14);
  assert.equal(result.output, 'Approved and completed');
  assert.equal(sends, 1);
  assert.equal(captures, 1);
}));
