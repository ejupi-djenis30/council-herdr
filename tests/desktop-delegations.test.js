import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { readDelegation } from '../herdr/mods/council/runtime/delegations.mjs';
import { JobManager } from '../lib/jobs.js';

function project(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'council-desktop-jobs-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function record(cwd, id, overrides = {}) {
  const dir = join(cwd, '.agent_workspace', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({
    $schema: 'council.job/v1',
    mode: 'delegate',
    sessionId: id,
    task: 'Inspect parser recovery',
    createdAt: '2026-01-01T12:00:00Z',
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    state: 'starting',
    deliveryState: 'planned',
    participant: { agent: 'codex', address: 't20', canonicalAddress: 't20', ownership: 'borrowed' },
    worker: { status: 'launching' },
    ...overrides
  }));
  return dir;
}

function read(cwd, id) {
  return desktopRequest(cwd, 'delegations', { id }).delegation;
}

test('desktop lists only async jobs and preserves delivery uncertainty after the deadline', t => {
  const cwd = project(t);
  const elapsed = '2000-01-02T00:00:00Z';
  record(cwd, 'late', { state: 'deliberating', deliveryState: 'acknowledged', deadlineAt: elapsed });
  record(cwd, 'ambiguous', { state: 'failed', deliveryState: 'uncertain', deadlineAt: elapsed });
  record(cwd, 'attempting', { deliveryState: 'attempting' });
  const review = join(cwd, '.agent_workspace', 'formal-review');
  mkdirSync(review);
  writeFileSync(join(review, 'session.json'), '{"mode":"review"}');
  const statuses = Object.fromEntries(desktopRequest(cwd, 'delegations', {}).delegations.map(job => [job.id, job.status]));
  assert.deepEqual(statuses, { ambiguous: 'uncertain', attempting: 'attempting', late: 'timed_out' });
  assert.equal(read(cwd, 'ambiguous').expired, true);
  assert.equal(read(cwd, 'ambiguous').output, null);
  assert.throws(() => read(cwd, '../another-project'), /Invalid delegation ID/);
});

test('desktop and CLI honor the dispatch sidecar and ignore it after acknowledgement', async t => {
  const cwd = project(t);
  const dir = record(cwd, 'dispatch');
  writeFileSync(join(dir, 'dispatch-error.json'), '{"error":"Worker launch failed"}');
  const cli = new JobManager({ cwd });
  assert.equal((await cli.getStatus('dispatch')).success, false);
  assert.equal(read(cwd, 'dispatch').status, 'dispatch_failed');
  assert.equal(read(cwd, 'dispatch').error, 'Worker launch failed');

  record(cwd, 'dispatch', { state: 'deliberating', deliveryState: 'acknowledged', worker: { status: 'claimed' } });
  assert.equal((await cli.getStatus('dispatch')).state, 'deliberating');
  assert.equal(read(cwd, 'dispatch').status, 'deliberating');
  assert.equal(read(cwd, 'dispatch').error, null);
});

test('failed jobs offer consistent recovery guidance in the CLI and Desktop', async t => {
  const cwd = project(t);
  const cli = new JobManager({ cwd });
  for (const [outcome, deliveryState, waitDetails, guidance] of [
    ['timed_out', 'acknowledged', { reason: 'timeout', status: 'working' }, /may still be working/],
    ['blocked', 'acknowledged', { reason: 'status', status: 'blocked' }, /resolve any prompt/],
    ['uncertain', 'uncertain', null, /before submitting the task again/],
    ['failed', 'failed', null, /new session ID/]
  ]) {
    const id = outcome.replaceAll('_', '-');
    const dir = record(cwd, id, { state: 'failed', deliveryState, waitDetails });
    const path = join(dir, 'job.json');
    const before = readFileSync(path);
    const status = await cli.getStatus(id);
    const result = await cli.getResult(id);
    const view = read(cwd, id);
    assert.equal(status.state, 'failed');
    assert.equal(status.outcome, outcome);
    assert.deepEqual(status.waitDetails, waitDetails);
    assert.equal(result.outcome, outcome);
    assert.equal(result.deliveryState, deliveryState);
    assert.equal(result.success, false);
    assert.equal(view.status, outcome);
    assert.equal(view.output, null);
    assert.match(view.nextAction, guidance);
    assert.equal(status.nextAction, view.nextAction);
    assert.equal(result.nextAction, view.nextAction);
    assert.deepEqual(readFileSync(path), before);
  }
});

test('a paused delegation appears in Desktop with its original deadline and matches CLI status', async t => {
  const cwd = project(t);
  record(cwd, 'approval', {
    state: 'deliberating', deliveryState: 'acknowledged', awaitingInput: true,
    waitDetails: { reason: 'status', status: 'blocked', turn: 3 }
  });
  const view = read(cwd, 'approval');
  const status = await new JobManager({ cwd }).getStatus('approval');
  assert.equal(view.status, 'awaiting_input');
  assert.equal(view.status, status.outcome);
  assert.equal(view.nextAction, status.nextAction);
  assert.ok(view.remainingSec > 0);
  assert.equal(view.output, null);
});

test('opening a delegation checks its worker while the summary stays disk-only', t => {
  const cwd = project(t);
  const dir = record(cwd, 'stopped', {
    state: 'deliberating', deliveryState: 'acknowledged', worker: { status: 'claimed', address: 't77', pid: 234, label: 'session-worker' }
  });
  const base = join(cwd, '.agent_workspace');
  const lookup = address => {
    assert.equal(address, 't77');
    return { address, state: 'finished', pid: 234, labels: { 'council.worker': 'session-worker' } };
  };
  const before = readFileSync(join(dir, 'job.json'));
  assert.equal(readDelegation(base, 'stopped', false, () => assert.fail('Summary must not query Herdr')).summary.status, 'deliberating');
  const { detail } = readDelegation(base, 'stopped', true, lookup);
  assert.equal(detail.status, 'worker_stopped');
  assert.equal(detail.workerObservation.state, 'stopped');
  assert.equal(detail.deliveryState, 'acknowledged');
  assert.deepEqual(readFileSync(join(dir, 'job.json')), before);
});

test('delegation view reads saved output without rewriting the job or following a stored path', async t => {
  const cwd = project(t);
  const output = 'Parser recovery captured.\n'.repeat(600);
  const dir = record(cwd, 'finished', {
    state: 'completed', deliveryState: 'acknowledged',
    waitDetails: { reason: 'status', status: 'done', turn: 3 },
    result: { output, artifactPath: join(cwd, 'unrelated.txt') }
  });
  const deliverables = join(dir, 'deliverables');
  mkdirSync(deliverables);
  const artifact = join(deliverables, 'output.txt');
  writeFileSync(artifact, output);
  const jobPath = join(dir, 'job.json');
  const before = readFileSync(jobPath);
  const view = read(cwd, 'finished');
  assert.equal(view.status, 'completed');
  assert.equal(view.agent, null, 'a borrowed terminal does not inherit the configured launch agent');
  assert.deepEqual(view.wait, { reason: 'status', status: 'done', turn: 3 });
  assert.equal(view.output, output.slice(0, 12000));
  assert.equal(view.outputTruncated, true);
  assert.equal(view.outputPath, artifact);
  assert.equal((await new JobManager({ cwd }).getResult('finished')).output, output);
  assert.deepEqual(read(cwd, 'finished'), view);
  assert.deepEqual(readFileSync(jobPath), before);
});

test('desktop and CLI reject completion without a saved result and confirmed delivery', async t => {
  const cwd = project(t);
  const cli = new JobManager({ cwd });
  record(cwd, 'broken', { state: 'completed', deliveryState: 'acknowledged' });
  const broken = read(cwd, 'broken');
  assert.equal(broken.status, 'invalid');
  assert.match(broken.error, /missing result/);
  assert.equal(broken.output, null);
  record(cwd, 'unacknowledged', { state: 'completed', result: { output: 'Uncorrelated capture' } });
  assert.equal(read(cwd, 'unacknowledged').status, 'invalid');
  const result = await cli.getResult('unacknowledged');
  assert.equal(result.success, false);
  assert.match(result.error, /missing acknowledged delivery/);
});

test('desktop identifies a borrowed agent using the app reported by Herdr', t => {
  const cwd = project(t);
  record(cwd, 'reported-app', {
    participant: { ownership: 'borrowed', address: 't20', agent: 'codex', reportedApp: 'claude-code' }
  });
  assert.equal(read(cwd, 'reported-app').agent, 'claude-code');
});
