import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
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

test('a completion marker without a saved result never becomes ready', t => {
  const cwd = project(t);
  record(cwd, 'broken', { state: 'completed', deliveryState: 'acknowledged' });
  const broken = read(cwd, 'broken');
  assert.equal(broken.status, 'invalid');
  assert.match(broken.error, /missing result/);
  assert.equal(broken.output, null);
  record(cwd, 'unacknowledged', { state: 'completed', result: { output: 'Uncorrelated capture' } });
  assert.equal(read(cwd, 'unacknowledged').status, 'invalid');
});
