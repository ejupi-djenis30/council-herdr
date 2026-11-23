import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshFormalTally, startFormalRound } from '../herdr/mods/council/round-actions.js';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { nextFormalRound } from '../lib/formal-rounds.js';
import { JobManager } from '../lib/jobs.js';
import { CouncilOrchestrator } from '../lib/modes.js';
import { AgentWorkspace } from '../lib/workspace.js';

const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));

async function fixture(t, mode) {
  const cwd = mkdtempSync(join(tmpdir(), 'council-desktop-round-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const detail = () => desktopRequest(cwd, 'reviews', { id: 'prior' }).review;
  let turns = 0;
  const herdr = {
    launchAgent() {
      assert.equal(detail().roundActions, null);
      return { success: true, address: `t${++turns}`, baselineTurn: 0, details: { first_message: { sent: true } } };
    },
    wait(terminal) { return { success: true, terminal, ended: true, reason: 'status', status: 'done', turn: 1 }; },
    read() { return { success: true, content: 'Reviewed details.\n[VOTE: approve] [SCORE: 9]' }; },
    dismiss() {}
  };
  const engine = new CouncilOrchestrator({ cwd, herdr });
  const round = await engine.runMode({ mode, sessionId: 'prior', task: 'Assess the proposal' });
  assert.equal(round.status, 'provisional');
  // Permit real CLI reads and reconnects, with no Herdr executable available to dispatch a worker.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const dispatch = args => {
    const cmd = spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...env, PATH: cwd }, encoding: 'utf8' });
    return { code: cmd.status, stdout: cmd.stdout, stderr: cmd.stderr };
  };
  return { cwd, detail, dir: round.sessionDir, workspace: engine.workspace, dispatch };
}

test('desktop refresh preserves provisional evidence and only current direct ballots authorize a decision', async t => {
  const { detail, dir, workspace, dispatch } = await fixture(t, 'review');
  const review = detail();
  assert.deepEqual(review.roundActions, { round: 1, nextSessionId: 'prior-round-2', canStartNext: true, nextJobId: null });
  const refresh = () => refreshFormalTally(detail(), dispatch);
  const provisional = await refresh();
  assert.equal(provisional.authorized, false);
  assert.equal(provisional.status, 'provisional');
  const submit = (voter, vote) => workspace.castBallot(dir, {
    voter, vote, round: 1, score: 8, targetArtifactSha256: review.proposal.sha256
  });
  const first = submit('review-reviewer', 'approve');
  writeFileSync(first.ballotPath, JSON.stringify({ ...first.ballot, submittedAt: '2000-01-01T00:00:00Z' }));
  submit('review-simplifier', 'approve');
  const stale = await refresh();
  assert.equal(stale.authorized, false);
  assert.equal(stale.tally.invalidCount, 1);
  assert.deepEqual(detail().ballots.map(ballot => ballot.voter), ['review-simplifier']);
  submit('review-reviewer', 'reject');
  assert.equal((await refresh()).status, 'rejected');
  submit('review-reviewer', 'approve');
  assert.equal((await refresh()).authorized, true);
  writeFileSync(join(dir, 'artifacts', 'proposal', 'review-author', 'artifact.md'), 'Changed proposal');
  assert.equal(detail().roundActions.canStartNext, false);
  assert.equal((await refresh()).status, 'vetoed');
  await assert.rejects(() => startFormalRound(detail(), () => assert.fail('unexpected launch')), /original proposal/);
});

test('desktop opens the exact linked job after reconnecting or losing a launch acknowledgement', async t => {
  const { cwd, detail, workspace, dispatch } = await fixture(t, 'council');
  const review = detail();
  const id = review.roundActions.nextSessionId;
  const manager = new JobManager({ cwd, workerLauncher: () => ({ success: true, address: 't99' }) });
  assert.equal((await manager.startJob(nextFormalRound(workspace, review.id, {}))).success, true);
  assert.equal(detail().roundActions.nextJobId, id);
  assert.equal(await startFormalRound(review, dispatch), id);
  const calls = [];
  const lost = args => {
    calls.push(args);
    if (!args.includes('--inspect')) throw new Error('Desktop timed out.');
    return dispatch(args);
  };
  assert.equal(await startFormalRound(review, lost), id);
  assert.equal(calls.length, 2);
  const jobPath = join(workspace.resolveSessionDir(id), 'job.json');
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  job.fingerprint = 'conflicting parameters';
  job.workflow.previousSession = 'another-source';
  writeFileSync(jobPath, JSON.stringify(job));
  assert.equal(detail().roundActions.nextJobId, null);
  await assert.rejects(() => startFormalRound(review, lost), /Check session prior-round-2 in Activity/);
  await assert.rejects(() => startFormalRound(review, dispatch), /conflicting parameters/);
});

test('a project alias identifies the same round for new and previously saved jobs', async t => {
  const { cwd, workspace, dispatch } = await fixture(t, 'review');
  const alias = cwd + '-alias';
  symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => unlinkSync(alias));
  const other = new AgentWorkspace(alias);
  const newId = 'aliased-round';
  const request = { sessionId: newId, context: 'Keep the previous scope.' };
  const canonical = nextFormalRound(workspace, 'prior', request);
  const throughAlias = nextFormalRound(other, 'prior', request);
  assert.deepEqual(throughAlias, canonical);
  const suffix = join('.agent_workspace', 'prior', 'artifacts', 'proposal', 'review-author', 'artifact.md');
  const formerContext = canonical.context.replace(realpathSync.native(join(cwd, suffix)), join(alias, suffix));
  assert.notEqual(formerContext, canonical.context);
  const manager = new JobManager({ cwd, workerLauncher: () => ({ success: true, address: 't99' }) });
  assert.equal((await manager.startJob({ ...canonical, context: formerContext })).success, true);
  const args = ['round', '--session', 'prior', '--new-session', newId, '--context', request.context];
  assert.equal(JSON.parse(dispatch([...args, '--inspect']).stdout).matches, true);
  assert.equal(JSON.parse(dispatch(args).stdout).reconnect, true);
  assert.equal(JSON.parse(dispatch([...args, '--task', 'A different task', '--inspect']).stdout).matches, false);
  assert.equal(JSON.parse(dispatch([...args, '--context', 'Different context', '--inspect']).stdout).matches, false);
});
