import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobManager } from '../lib/jobs.js';
import { JobWorker } from '../lib/job-worker.js';
import { ScheduleManager, runSchedule } from '../lib/schedules.js';
import { AgentWorkspace } from '../lib/workspace.js';
import { nextFormalRound, retallyFormalRound, saveFormalRound } from '../lib/formal-rounds.js';

function project(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'council-workflow-management-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('background pipeline keeps its own job record, executes once, and returns the saved workflow report', async t => {
  const cwd = project(t);
  const launches = [];
  const manager = new JobManager({ cwd, workerLauncher: job => { launches.push(job); return { success: true, address: 't72' }; } });
  const options = { mode: 'pipeline', sessionId: 'background-pipeline', task: 'Review the design', stages: [{ name: 'Draft' }, { name: 'Check' }] };
  const started = await manager.startJob(options);
  assert.equal(started.success, true);
  assert.equal(started.mode, 'pipeline');
  assert.equal((await manager.startJob(options)).reconnect, true);
  assert.equal((await manager.startJob({ ...options, stages: [{ name: 'Different stage' }] })).success, false);
  assert.equal(launches.length, 1);

  let turns = 0;
  const herdr = {
    terminalId: 't72',
    launchAgent() { return { success: true, address: `t${++turns}`, baselineTurn: 0, details: { first_message: { sent: true } } }; },
    wait(address) { return { terminal: address, ended: true, reason: 'status', status: 'done', turn: 1, success: true }; },
    captureTurn(address) { return { success: true, content: 'Verified output for ' + address }; },
    dismiss() {}
  };
  const worker = new JobWorker({ sessionDir: launches[0].sessionDir, herdr });
  assert.equal((await worker.execute()).success, true);
  assert.equal((await worker.execute()).success, false);
  const saved = await manager.getResult(options.sessionId);
  assert.equal(saved.ready, true);
  assert.match(saved.output, /Verified output for t2/);
  assert.equal(saved.workflowSessionId, started.workflowSessionId);
  assert.equal(turns, 2);
});

test('late ballots refresh a background formal decision and a new round keeps the previous digest as context', async t => {
  const cwd = project(t);
  const workspace = new AgentWorkspace(cwd);
  const participants = ['author', 'reviewer', 'simplifier'].map(role => ({ name: `review-${role}`, role, agent: 'codex' }));
  const manager = new JobManager({ cwd, workspace, workerLauncher: () => ({ success: true, address: 't72' }) });
  const started = await manager.startJob({ sessionId: 'proposal', mode: 'review', task: 'Review the parser' });
  const { workflowSessionId } = started;
  let sessionDir;
  let sha256;
  const worker = new JobWorker({ sessionDir: workspace.resolveSessionDir('proposal'), workspace,
    hooks: { runWorkflow({ sessionId, mode, task }) {
      ({ sessionDir } = workspace.initSession({ sessionId, mode, task, participants }));
      ({ sha256 } = workspace.writeArtifact(sessionDir, { phase: 'proposal', author: 'review-author', content: 'A precise proposal' }));
      saveFormalRound(sessionDir, { mode, round: 1, previousSession: null, sha256, representative: 'review-reviewer' });
      return { success: false, status: 'failed_quorum', sessionId, report: 'Awaiting direct ballots' };
    } }
  });
  assert.equal((await worker.execute()).success, false);

  const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));
  const cast = (role, vote) => {
    const result = spawnSync(process.execPath, [cli, 'cast-ballot', '--session', 'proposal', '--voter', `review-${role}`, '--role', role,
      '--agent', 'codex', '--target-sha', sha256, '--vote', vote, '--rationale', 'Reviewed the original proposal'], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(cast('reviewer', 'approve'), /failed_quorum/);
  assert.match(cast('simplifier', 'approve'), /validated/);
  const verified = JSON.parse(readFileSync(join(sessionDir, 'reports', 'verdict.json'), 'utf8'));
  assert.equal(verified.validation.round, 1);
  assert.equal(verified.validation.passed, true);
  assert.equal((await manager.getResult('proposal')).authorized, true);
  assert.equal((await manager.getStatus('proposal')).state, 'completed');
  const next = nextFormalRound(workspace, 'proposal', { task: 'Revise the parser change' });
  assert.equal(next.round, 2);
  assert.equal(next.previousSession, workflowSessionId);
  assert.match(next.context, new RegExp(sha256));
  assert.equal(next.sessionId, `${workflowSessionId}-round-2`);

  assert.match(cast('simplifier', 'reject'), /rejected/);
  assert.equal(existsSync(join(sessionDir, 'reports', 'verdict.json')), false);
  assert.equal((await manager.getResult('proposal')).authorized, false);
  assert.ok(readdirSync(join(sessionDir, 'validation', 'history')).length > 0);
  assert.equal(retallyFormalRound(workspace, 'proposal').authorized, false);
});

test('scheduler dispatches predictable job IDs and cancels future occurrences', async t => {
  const cwd = project(t);
  const launches = [];
  const manager = new ScheduleManager({ cwd, herdr: {
    exec(args) { launches.push(args); return { success: true, stdout: '{"address":"t87"}' }; }, parseJson: JSON.parse
  } });
  assert.equal(manager.create({ id: 'review', count: 2, everySec: 1, job: { mode: 'review', task: 'Scheduled review' } }).success, true);
  const calls = [];
  await runSchedule(manager.path('review'), { startJob(opts) { calls.push(opts); return { success: true }; } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].mode, 'review');
  assert.match(calls[0].sessionId, /-1$/);
  assert.match(calls[1].sessionId, /-2$/);
  assert.equal(manager.status('review').state, 'finished');

  manager.create({ id: 'future', at: new Date(Date.now() + 60_000).toISOString(), job: { task: 'Future delegation' } });
  const worker = runSchedule(manager.path('future'), { startJob() { assert.fail('A cancelled schedule must not dispatch'); } });
  manager.cancel('future');
  await worker;
  assert.equal(manager.status('future').state, 'cancelled');
  assert.equal(launches.length, 2);
});
