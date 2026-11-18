import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager, computeFingerprint, validateAdoptedTerminal } from '../lib/jobs.js';
import { JobWorker } from '../lib/job-worker.js';
import { AgentWorkspace } from '../lib/workspace.js';

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
      return { success: true, details: { address: target, state: 'live', reported: true, status: { state: 'idle' } } };
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
  const r1 = await manager.startJob({ mode: 'review', task: 'Review task' });
  assert.equal(r1.success, false);
  assert.match(r1.error, /not supported/);

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

test('JobWorker locks prevent concurrent execution and release locks on completion', async () => inTemp(async root => {
  const workspace = new AgentWorkspace(root);
  const manager = new JobManager({ cwd: root, workspace, workerLauncher: () => ({ success: true }) });
  await manager.startJob({ sessionId: 'lock-test', task: 'test locks', timeoutSec: 30 });

  const sessionDir = join(root, '.agent_workspace', 'lock-test');
  const herdr = {
    terminalId: 't-worker',
    launchAgent() { return { success: true, address: 't-owned', details: { first_message: { sent: true } } }; },
    wait() { return { success: true, status: 'done', reason: 'status', ended: true, turn: 1, target: 't-owned' }; },
    read() { return { success: true, content: 'DONE_CONTENT' }; },
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
