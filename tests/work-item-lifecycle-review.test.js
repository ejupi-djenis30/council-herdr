import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentWorkspace } from '../lib/workspace.js';

test('read-only formal tally preserves the same rules and never publishes or rewrites a tally', t => {
  const project = mkdtempSync(join(tmpdir(), 'council-readonly-tally-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const workspace = new AgentWorkspace(project);
  const { sessionDir } = workspace.initSession({ sessionId: 'test-review', mode: 'review', task: 'Review' });
  workspace.castBallot(sessionDir, { voter: 'reviewer', role: 'reviewer', agent: 'codex', vote: 'approve', score: 8 });
  const path = join(sessionDir, 'ballots', 'round-1', 'tally.json');
  const readonly = workspace.tallyBallots(sessionDir, 1, ['reviewer'], { readOnly: true });
  assert.equal(existsSync(path), false);
  const ordinary = workspace.tallyBallots(sessionDir, 1, ['reviewer']);
  assert.equal(existsSync(path), true);
  const bytes = readFileSync(path);
  const modified = statSync(path).mtimeMs;
  const again = workspace.tallyBallots(sessionDir, 1, ['reviewer'], { readOnly: true });
  const comparable = ({ talliedAt, ...value }) => value;
  assert.deepEqual(comparable(readonly), comparable(ordinary));
  assert.deepEqual(comparable(again), comparable(ordinary));
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(statSync(path).mtimeMs, modified);
});
import { mkdirSync, writeFileSync } from 'node:fs';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { workItemOperation } from '../lib/work-items.js';
import { saveFormalRound, retallyFormalRound } from '../lib/formal-rounds.js';

async function formalFixture(t, votes, options = {}) {
  const project = mkdtempSync(join(tmpdir(), 'council-formal-item-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const item = { id: 'wi-formal', title: 'Review release', roleId: 'dev', criteria: ['Check release.'] };
  new TeamStore(project).set({ id: 'dev', agent: 'codex', role: 'Developer' });
  await workItemOperation('create', item, { project });
  await workItemOperation('delegate', { id: item.id }, { project, callTeamMember: async (_manager, call) => {
    const dir = join(project, '.agent_workspace', call.sessionId);
    mkdirSync(dir);
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
      mode: 'delegate', workItemId: item.id, participant: { team: { id: 'dev' } }, state: 'completed',
      deliveryState: 'acknowledged', deadlineAt: new Date(Date.now() + 60000).toISOString(),
      result: { output: 'Completed work', turn: 2, captureScope: 'history', completedAt: new Date().toISOString() } }));
  } });
  const started = await workItemOperation('review', { action: 'start', id: item.id, ifRevision: 2, requestId: 'start',
    actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'formal' }, { project });
  assert.equal(started.success, true, JSON.stringify(started));
  const review = started.item.lifecycle.review;
  const workspace = new AgentWorkspace(project);
  const participants = ['author', 'reviewer', 'simplifier'].map(role => ({ name: `review-${role}`, role, agent: 'codex' }));
  const { sessionDir } = workspace.initSession({ sessionId: 'formal-test', mode: 'review', task: 'Formal review', participants });
  const proposal = workspace.writeArtifact(sessionDir, { phase: 'proposal', author: 'review-author',
    content: `${options.bomBinding ? '\ufeff' : ''}Council-Work-Item-Review: sha256:${options.wrongBinding ? '0'.repeat(64) : review.snapshotSha256}\nFormal assessment.` });
  saveFormalRound(sessionDir, { mode: 'review', round: 1, previousSession: null, sha256: proposal.sha256, representative: 'review-reviewer' });
  for (const [voter, vote] of votes) workspace.castBallot(sessionDir, { voter, role: voter, agent: 'codex', vote,
    rationale: `${vote} evidence`, targetArtifactSha256: proposal.sha256, round: 1, score: 8 });
  if (options.provisional) {
    const tally = workspace.tallyBallots(sessionDir, 1, ['review-reviewer', 'review-simplifier'], {
      expectedArtifactSha256: proposal.sha256, readOnly: true
    });
    const validation = workspace.validateChoice(sessionDir, { round: 1, representative: 'review-reviewer',
      targetArtifact: { phase: 'proposal', author: 'review-author' }, expectedSha256: proposal.sha256, tally, screenEvidence: true });
    workspace.saveFinalDeliverables(sessionDir, { markdownReport: 'Provisional review',
      verdictJson: { sessionId: 'formal-test', mode: 'review', tally, validation: validation.record }, validationPassed: false });
  } else retallyFormalRound(workspace, 'formal-test');
  const attached = await workItemOperation('review', { action: 'attach', id: item.id, ifRevision: 3, requestId: 'attach',
    actor: 'Lead', reviewId: review.id, formalSessionId: 'formal-test', round: 1 }, { project });
  return { project, item, review, attached, sessionDir, workspace };
}

test('a bound persisted formal approval still requires explicit lead acceptance', async t => {
  const f = await formalFixture(t, [['review-reviewer', 'approve'], ['review-simplifier', 'approve']]);
  assert.equal(f.attached.success, true, JSON.stringify(f.attached));
  assert.equal(f.attached.item.lifecycle.review.formal.state, 'approved');
  assert.equal(f.attached.item.lifecycle.state, 'in_review');
  const review = f.attached.item.lifecycle.review;
  const closed = await workItemOperation('close', { id: f.item.id, ifRevision: 4, requestId: 'close', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Reviewed.', nextAction: 'Ship.' }, { project: f.project });
  assert.equal(closed.success, true, JSON.stringify(closed));
  assert.equal(closed.item.lifecycle.state, 'closed');
  assert.equal(closed.item.lifecycle.decision.formal.state, 'approved');
});

test('a rejected formal round cannot close and its dissent remains after rework', async t => {
  const f = await formalFixture(t, [['review-reviewer', 'reject'], ['review-simplifier', 'reject']]);
  assert.equal(f.attached.success, true, JSON.stringify(f.attached));
  const review = f.attached.item.lifecycle.review;
  assert.equal(review.formal.state, 'rejected');
  assert.equal(review.formal.dissent.length, 2);
  const closed = await workItemOperation('close', { id: f.item.id, ifRevision: 4, requestId: 'close', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Reviewed.', nextAction: 'Ship.' }, { project: f.project });
  assert.equal(closed.error.code, 'review_not_authorized');
  const returned = await workItemOperation('review', { action: 'return', id: f.item.id, ifRevision: 4, requestId: 'return', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, reason: 'Fix it.', roleId: 'dev', nextAction: 'Revise.' }, { project: f.project });
  assert.equal(returned.success, true, JSON.stringify(returned));
  const archived = await workItemOperation('show', { id: f.item.id, reviewId: review.id }, { project: f.project });
  assert.equal(archived.archivedReview.formal.state, 'rejected');
  assert.equal(archived.archivedReview.formal.dissent.length, 2);
  const delegated = await workItemOperation('delegate', { id: f.item.id, ifRevision: 5, requestId: 'second', actor: 'Lead' }, {
    project: f.project, callTeamMember: async (_manager, call) => {
      const dir = join(f.project, '.agent_workspace', call.sessionId);
      mkdirSync(dir);
      writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
        mode: 'delegate', workItemId: f.item.id, workItemBinding: call.workItemBinding, participant: { team: { id: 'dev' } },
        state: 'completed', deliveryState: 'acknowledged', deadlineAt: new Date(Date.now() + 60000).toISOString(), result: { output: 'Reworked' } }));
    }
  });
  assert.equal(delegated.success, true, JSON.stringify(delegated));
  const downgrade = await workItemOperation('review', { action: 'start', id: f.item.id, ifRevision: 6, requestId: 'downgrade',
    actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'operator' }, { project: f.project });
  assert.equal(downgrade.error.code, 'review_not_authorized');
});

test('provisional screen evidence is readable, cannot close, and can be returned for rework', async t => {
  const f = await formalFixture(t, [], { provisional: true });
  assert.equal(f.attached.success, true, JSON.stringify(f.attached));
  const review = f.attached.item.lifecycle.review;
  assert.equal(review.formal.state, 'provisional');
  const decision = await workItemOperation('close', { id: f.item.id, ifRevision: 4, requestId: 'close', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Review.', nextAction: 'Ship.' }, { project: f.project });
  assert.equal(decision.error.code, 'review_not_authorized');
  const returned = await workItemOperation('review', { action: 'return', id: f.item.id, ifRevision: 4, requestId: 'return', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, reason: 'More work.', roleId: 'dev', nextAction: 'Revise.' }, { project: f.project });
  assert.equal(returned.success, true, JSON.stringify(returned));
  const archived = await workItemOperation('show', { id: f.item.id, reviewId: review.id }, { project: f.project });
  assert.equal(archived.archivedReview.formal.state, 'provisional');
});

test('wrong formal binding cannot be attached', async t => {
  const f = await formalFixture(t, [['review-reviewer', 'approve'], ['review-simplifier', 'approve']], { wrongBinding: true });
  assert.equal(f.attached.error.code, 'integrity_error');
});

test('changed formal evidence invalidates a previously displayed confirmation', async t => {
  const f = await formalFixture(t, [['review-reviewer', 'approve'], ['review-simplifier', 'approve']]);
  const review = f.attached.item.lifecycle.review;
  writeFileSync(join(f.sessionDir, 'reports', 'report.md'), 'Changed report');
  const closed = await workItemOperation('close', { id: f.item.id, ifRevision: 4, requestId: 'close', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Reviewed.', nextAction: 'Ship.' }, { project: f.project });
  assert.equal(closed.error.code, 'stale_evidence');
});

test('a historical formal decision survives with an integrity issue when its original evidence changes', async t => {
  const f = await formalFixture(t, [['review-reviewer', 'approve'], ['review-simplifier', 'approve']]);
  const review = f.attached.item.lifecycle.review;
  const closed = await workItemOperation('close', { id: f.item.id, ifRevision: 4, requestId: 'close', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Reviewed.', nextAction: 'Ship.' }, { project: f.project });
  assert.equal(closed.success, true, JSON.stringify(closed));
  writeFileSync(join(f.sessionDir, 'reports', 'report.md'), 'Changed report');
  const shown = await workItemOperation('show', { id: f.item.id, reviewId: review.id }, { project: f.project });
  assert.equal(shown.item.lifecycle.decision.formal.state, 'approved');
  assert.equal(shown.item.lifecycle.integrity.code, 'integrity_error');
  assert.equal(shown.archivedReview.formal.state, 'approved');
});

test('missing or invalid direct ballots cannot authorize a stale saved approval', async t => {
  const { observeFormal } = await import('../lib/work-item-review.js');
  const { WorkItemStore } = await import('../herdr/mods/council/runtime/work-item-store.mjs');
  for (const corruption of ['missing', 'invalid', 'unexpected', 'retally', 'round']) {
    const f = await formalFixture(t, [['review-reviewer', 'approve'], ['review-simplifier', 'approve']]);
    const digest = f.review.snapshotSha256;
    if (corruption === 'missing') rmSync(join(f.sessionDir, 'ballots', 'round-1', 'review-reviewer.json'));
    if (corruption === 'invalid') writeFileSync(join(f.sessionDir, 'ballots', 'round-1', 'review-reviewer.json'), '{');
    if (corruption === 'unexpected') writeFileSync(join(f.sessionDir, 'ballots', 'round-1', 'unassigned.json'), '{}');
    if (corruption === 'retally') writeFileSync(join(f.sessionDir, 'validation', 'retally.lock'), '');
    if (corruption === 'round') writeFileSync(join(f.sessionDir, 'validation', 'round.json'), '{}');
    const current = observeFormal(new WorkItemStore(f.project), 'formal-test', 1, digest);
    assert.equal(current.state, 'unverified', corruption);
    const review = f.attached.item.lifecycle.review;
    const close = await workItemOperation('close', { id: f.item.id, ifRevision: 4, requestId: `close-${corruption}`, actor: 'Lead',
      reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Reviewed.', nextAction: 'Ship.' }, { project: f.project });
    assert.notEqual(close.success, true, corruption);
  }
});

test('tampered frozen capture blocks acceptance and leaves the review in place', async t => {
  const f = await formalFixture(t, [['review-reviewer', 'approve'], ['review-simplifier', 'approve']]);
  const review = f.attached.item.lifecycle.review;
  writeFileSync(join(f.project, '.agent_workspace', '.work-items', f.item.id, 'evidence', `${review.capture.sha256}.blob`), 'changed');
  const shown = await workItemOperation('show', { id: f.item.id }, { project: f.project });
  assert.equal(shown.item.lifecycle.review.capture.verified, false);
  assert.equal(shown.item.lifecycle.integrity.code, 'integrity_error');
  const close = await workItemOperation('close', { id: f.item.id, ifRevision: 4, requestId: 'close', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Reviewed.', nextAction: 'Ship.' }, { project: f.project });
  assert.equal(close.error.code, 'stale_evidence');
});

test('completed Council reviewer turns and direct ballots authorize only the bound frozen handoff', async t => {
  const { CouncilOrchestrator } = await import('../lib/modes.js');
  const f = await formalFixture(t, [], { wrongBinding: true });
  const proposal = `Council-Work-Item-Review: sha256:${f.review.snapshotSha256}\nReviewed the saved handoff.`;
  const workspace = new AgentWorkspace(f.project);
  const launched = [];
  const herdr = {
    launchAgent(options) {
      const address = `t${launched.length + 1}`;
      launched.push({ ...options, address });
      const voter = options.name.endsWith('-simp') ? 'review-simplifier' : options.name.endsWith('-rev') ? 'review-reviewer' : null;
      if (voter) workspace.castBallot(options.sessionDir, { voter, role: voter, agent: 'codex', vote: 'approve',
        rationale: 'Reviewed.', targetArtifactSha256: workspace.sha256(proposal), score: 8, round: 1 });
      return { success: true, address, baselineTurn: 0, details: { first_message: { sent: true } } };
    },
    wait(address) { return { success: true, terminal: address, ended: true, reason: 'status', status: 'done', turn: 1 }; },
    read(address) {
      const record = launched.find(entry => entry.address === address);
      return { success: true, content: record.name.endsWith('-auth') ? proposal : 'Reviewed.' };
    },
    dismiss() { return { success: true }; }
  };
  const orchestrator = new CouncilOrchestrator({ cwd: f.project, herdr });
  const result = await orchestrator.runMode({ mode: 'review', sessionId: 'actual-review', task: 'Review the frozen handoff', agents: ['codex', 'codex', 'codex'] });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(launched.length, 3);
  const attached = await workItemOperation('review', { action: 'attach', id: f.item.id, ifRevision: 3, requestId: 'real-formal',
    actor: 'Lead', reviewId: f.review.id, formalSessionId: 'actual-review', round: 1 }, { project: f.project });
  assert.equal(attached.item.lifecycle.review.formal.state, 'approved', JSON.stringify(attached));
  assert.equal(attached.item.lifecycle.state, 'in_review');
});

test('an unverified current observation can be returned while retaining the prior rejected verdict', async t => {
  const f = await formalFixture(t, [['review-reviewer', 'reject'], ['review-simplifier', 'reject']]);
  rmSync(join(f.sessionDir, 'validation', 'report.md'));
  const shown = await workItemOperation('show', { id: f.item.id }, { project: f.project });
  const review = shown.item.lifecycle.review;
  assert.equal(review.formal.state, 'unverified');
  assert.equal(review.formal.verdict, 'rejected');
  assert.equal(review.formal.dissent.length, 2);
  assert.ok(review.evidenceToken);
  const returned = await workItemOperation('review', { action: 'return', id: f.item.id, ifRevision: 4, requestId: 'return-unverified', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, reason: 'Inspect and revise.', roleId: 'dev', nextAction: 'Investigate.' }, { project: f.project });
  assert.equal(returned.success, true, JSON.stringify(returned));
  const history = await workItemOperation('history', { id: f.item.id }, { project: f.project });
  const attachment = history.events.find(event => event.type === 'formal_attached');
  assert.equal(attachment.references.formal.state, 'rejected');
  assert.equal(attachment.references.formal.dissent.length, 2);
});

test('direct ballots from an incomplete reviewer turn cannot authorize the item', async t => {
  const { CouncilOrchestrator } = await import('../lib/modes.js');
  const f = await formalFixture(t, [], { wrongBinding: true });
  const proposal = `Council-Work-Item-Review: sha256:${f.review.snapshotSha256}\nReview.`;
  const workspace = new AgentWorkspace(f.project);
  const launched = [];
  const herdr = {
    launchAgent(options) {
      const address = `t${launched.length + 1}`;
      launched.push({ ...options, address });
      const voter = options.name.endsWith('-simp') ? 'review-simplifier' : options.name.endsWith('-rev') ? 'review-reviewer' : null;
      if (voter) workspace.castBallot(options.sessionDir, { voter, role: voter, agent: 'codex', vote: 'approve',
        rationale: 'Recorded.', targetArtifactSha256: workspace.sha256(proposal), score: 8, round: 1 });
      return { success: true, address, baselineTurn: 0, details: { first_message: { sent: true } } };
    },
    wait(address) { return address === 't2' ? { success: false, terminal: address, reason: 'blocked', status: 'blocked', ended: true, turn: 1 }
      : { success: true, terminal: address, ended: true, reason: 'status', status: 'done', turn: 1 }; },
    read(address) { const entry = launched.find(item => item.address === address); return { success: true, content: entry.name.endsWith('-auth') ? proposal : 'Review.' }; },
    dismiss() { return { success: true }; }
  };
  const engine = new CouncilOrchestrator({ cwd: f.project, herdr });
  const run = await engine.runMode({ mode: 'review', sessionId: 'incomplete', task: 'Review', agents: ['codex', 'codex', 'codex'] });
  assert.equal(run.success, false);
  const attached = await workItemOperation('review', { action: 'attach', id: f.item.id, ifRevision: 3, requestId: 'incomplete', actor: 'Lead',
    reviewId: f.review.id, formalSessionId: 'incomplete', round: 1 }, { project: f.project });
  assert.equal(attached.error.code, 'integrity_error');
});

test('a persisted artifact that differs from the job capture cannot be frozen', async t => {
  const project = mkdtempSync(join(tmpdir(), 'council-capture-mismatch-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const item = { id: 'wi-mismatch', title: 'Check', roleId: 'dev', criteria: ['Check'] };
  new TeamStore(project).set({ id: 'dev', agent: 'codex', role: 'Developer' });
  await workItemOperation('create', item, { project });
  await workItemOperation('delegate', { id: item.id }, { project, callTeamMember: async (_manager, call) => {
    const dir = join(project, '.agent_workspace', call.sessionId); mkdirSync(dir);
    const artifact = join(dir, 'output.txt'); writeFileSync(artifact, 'changed');
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
      mode: 'delegate', workItemId: item.id, participant: { team: { id: 'dev' } }, state: 'completed',
      deliveryState: 'acknowledged', deadlineAt: new Date(Date.now() + 60000).toISOString(), result: { output: 'original', artifactPath: artifact } }));
  } });
  const result = await workItemOperation('review', { action: 'start', id: item.id, ifRevision: 2, requestId: 'review',
    actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'operator' }, { project });
  assert.equal(result.error.code, 'integrity_error');
  assert.equal((await workItemOperation('show', { id: item.id }, { project })).item.lifecycle.state, 'open');
});


test('a leading BOM cannot silently alter the exact formal proposal binding line', async t => {
  const f = await formalFixture(t, [['review-reviewer', 'approve'], ['review-simplifier', 'approve']], { bomBinding: true });
  assert.equal(f.attached.error.code, 'integrity_error');
});
