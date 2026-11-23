import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CouncilMcpServer } from '../lib/mcp-server.js';
import { JobWorker } from '../lib/job-worker.js';
import { nextFormalRound, readFormalDecision } from '../lib/formal-rounds.js';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';

const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function project(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'council-linked-round-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function participants(onLaunch = () => {}) {
  let count = 0;
  return {
    launchAgent(options) {
      const address = `t${++count}`;
      onLaunch(options, count);
      return { success: true, address, baselineTurn: 0, details: { first_message: { sent: true } } };
    },
    wait(terminal) { return { success: true, terminal, ended: true, reason: 'status', status: 'done', turn: 1 }; },
    read(address) { return { success: true, content: 'Reviewed proposal ' + address }; },
    dismiss() {}
  };
}

for (const mode of ['review', 'council']) {
  test(`public linked ${mode} round shows direct ballots against its own handoff while voting is in progress`, async t => {
    const cwd = project(t);
    const server = new CouncilMcpServer({ cwd });
    server.orchestrator.herdr = participants();
    const first = await server.orchestrator.runMode({ mode, sessionId: 'first', task: 'Review the change' });
    assert.equal(first.status, 'failed_quorum');
    if (mode === 'review') {
      // Observe the CLI's saved request while keeping the worker process out of this fixture.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
      const command = spawnSync(process.execPath, [cli, 'round', '--session', 'first', '--new-session', 'command-round',
        '--task', 'Revise the command path'], { cwd, env: { ...env, PATH: cwd }, encoding: 'utf8' });
      assert.equal(command.status, 1);
      assert.equal(JSON.parse(command.stdout).success, false);
      const cliJob = readJson(join(server.workspace.resolveSessionDir('command-round'), 'job.json'));
      assert.equal(cliJob.workflow.round, 2);
      assert.equal(cliJob.workflow.previousSession, 'first');
      assert.equal(cliJob.task, 'Revise the command path');
    }
    server.jobManager.workerLauncher = () => ({ success: true, address: 't90' });
    server.sendResult = (_id, result) => result;
    const reply = await server.handleToolCall(1, { name: 'council_round',
      arguments: { project: cwd, sessionId: 'first', newSessionId: 'second', task: 'Review the revision' } });
    assert.equal(reply.isError, false);
    const { workflowSessionId } = JSON.parse(reply.content[0].text);
    const parentDir = server.workspace.resolveSessionDir('second');
    const job = readJson(join(parentDir, 'job.json'));
    assert.equal(job.workflow.round, 2);
    assert.equal(job.workflow.previousSession, 'first');
    const herdr = participants(({ sessionDir, task }, index) => {
      if (index !== 2) return;
      const target = readJson(join(sessionDir, 'task', 'proposal-target.json'));
      assert.equal(target.round, 2);
      assert.ok(task.includes(target.sha256));
      const voter = mode === 'review' ? 'review-reviewer' : 'council-skeptic';
      for (const round of ['1', '2']) {
        const cast = spawnSync(process.execPath, [cli, 'cast-ballot', '--session', 'second', '--round', round,
          '--voter', voter, '--role', mode === 'review' ? 'reviewer' : 'skeptic', '--agent', 'codex',
          '--vote', 'approve', '--target-sha', target.sha256, '--rationale', 'Reviewed this proposal.'], { cwd, encoding: 'utf8' });
        assert.equal(cast.status, 0, cast.stderr);
      }
      const active = desktopRequest(cwd, 'reviews', { id: workflowSessionId }).review;
      assert.equal(active.status, 'pending');
      assert.deepEqual(active.proposal, { round: 2, sha256: target.sha256, source: 'handoff' });
      assert.deepEqual(active.ballots.map(({ round, proposalMatch }) => [round, proposalMatch]), [[1, 'unavailable'], [2, 'match']]);
      const debate = desktopRequest(cwd, 'debates', { id: workflowSessionId }).debate;
      assert.equal(debate.messages.find(message => message.ballot?.round === 2).ballot.bound, true);
    });
    const result = await new JobWorker({ sessionDir: parentDir, herdr }).execute();
    assert.equal(result.workflowStatus, 'failed_quorum');
    const next = nextFormalRound(server.workspace, 'second', {});
    assert.equal(next.round, 3);
    assert.equal(next.previousSession, workflowSessionId);
  });
}

test('formal result and next round ignore an older approval under a reused ID', async t => {
  const cwd = project(t);
  const server = new CouncilMcpServer({ cwd });
  server.orchestrator.herdr = participants();
  const result = await server.orchestrator.runMode({ mode: 'review', sessionId: 'duplicate', task: 'Current review' });
  const dir = result.sessionDir;
  const active = readJson(join(dir, 'validation', 'verdict.json'));
  const old = structuredClone(active);
  Object.assign(old.validation, { validatedAt: '2000-01-01T00:00:00Z', passed: true, verdict: 'validated' });
  Object.assign(old.tally, { passed: true, quorumMet: true, invalidCount: 0 });
  writeFileSync(join(dir, 'reports', 'verdict.json'), JSON.stringify(old));
  writeFileSync(join(dir, 'reports', 'report.md'), 'Old approved work');
  const decision = readFormalDecision(server.workspace, 'duplicate');
  assert.equal(decision.authorized, false);
  assert.equal(decision.workflowStatus, 'failed_quorum');
  assert.notEqual(decision.output, 'Old approved work');
  const roundPath = join(dir, 'validation', 'round.json');
  const legacy = readJson(roundPath);
  delete legacy.sessionCreatedAt;
  writeFileSync(roundPath, JSON.stringify(legacy));
  assert.equal(nextFormalRound(server.workspace, 'duplicate', {}).round, 2);

  // Simulate files left by older releases after the manifest acquired a new generation.
  const session = readJson(join(dir, 'session.json'));
  session.createdAt = new Date(Date.parse(active.validation.validatedAt) + 1000).toISOString();
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session));
  assert.equal(readFormalDecision(server.workspace, 'duplicate'), null);
  assert.throws(() => nextFormalRound(server.workspace, 'duplicate', {}), /saved formal review/);
  server.jobManager.workerLauncher = () => ({ success: true, address: 't91' });
  await server.jobManager.startJob({ mode: 'review', sessionId: 'earlier-job', task: 'Prior generation' });
  const jobPath = join(server.workspace.resolveSessionDir('earlier-job'), 'job.json');
  const job = readJson(jobPath);
  job.state = 'completed';
  job.deliveryState = 'acknowledged';
  job.workflow.sessionId = 'duplicate';
  job.result = { ready: true, success: true, authorized: true, output: 'Old approved work', completedAt: old.validation.validatedAt };
  writeFileSync(jobPath, JSON.stringify(job));
  assert.equal((await server.jobManager.getStatus('earlier-job')).authorized, false);
  const projected = await server.jobManager.getResult('earlier-job');
  assert.equal(projected.authorized, false);
  assert.equal(projected.workflowStatus, 'unconfirmed');
  assert.notEqual(projected.output, 'Old approved work');
});
