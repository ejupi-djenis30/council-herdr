import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentWorkspace } from '../lib/workspace.js';
import { CouncilOrchestrator } from '../lib/modes.js';
import { JobManager } from '../lib/jobs.js';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { checkInvitationAlignment, inviteReadyAgent, publishWithInvitations, readInvitations, sendInvitations } from '../herdr/mods/council/runtime/invitations.mjs';
import { createDebate } from '../herdr/mods/council/runtime/debate-room.mjs';
import { alignmentKey, alignmentLabel } from '../herdr/mods/council/runtime/alignment.mjs';
import { discussionType, projectLabels } from '../herdr/mods/council/poll-text.js';

const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));
const runtime = fileURLToPath(new URL('../herdr/mods/council/runtime/council.mjs', import.meta.url));
const run = promisify(execFile);

function project(t) {
  const path = mkdtempSync(join(tmpdir(), 'council discussion '));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return realpathSync.native(path);
}

function command(cwd, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, input, encoding: 'utf8', timeout: 10000, env: { ...process.env, HC_TERMINAL_ID: 't17' }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function invoke(cwd, name, args) {
  const input = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name, arguments: args } }) + '\n';
  const { result } = command(cwd, ['mcp'], input);
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

test('failed direct CLI and MCP delegations are visible as incomplete in Desktop', t => {
  const cwd = project(t);
  // The empty PATH makes Herdr unconditionally unavailable without touching any real agent.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = cwd;
  const options = { cwd, env, encoding: 'utf8', timeout: 10000 };
  const direct = spawnSync(process.execPath, [cli, 'delegate', '--session', 'from-cli', '--task', 'Inspect'], options);
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /Delegation failed \(from-cli\)/);
  const request = { id: 1, method: 'tools/call', params: { name: 'council_delegate',
    arguments: { project: cwd, sessionId: 'from-mcp', agent: 'codex', task: 'Inspect' } } };
  const mcp = spawnSync(process.execPath, [cli, 'mcp'], { ...options, input: JSON.stringify(request) + '\n' });
  assert.equal(JSON.parse(mcp.stdout).result.isError, true);
  for (const id of ['from-cli', 'from-mcp']) {
    const job = desktopRequest(cwd, 'delegations', { id }).delegation;
    assert.equal(job.status, 'incomplete');
    assert.ok(job.error);
  }
});

test('an agent can find, link, manage and close a discussion across CLI, MCP and Desktop', t => {
  const cwd = project(t);
  const outside = project(t);
  const { sessionId: debateId } = command(cwd, ['debate', 'create', '--question', 'Which rollout?']);
  assert.equal(invoke(outside, 'council_debate_read', { project: cwd }).debates[0].id, debateId);
  assert.equal(command(cwd, ['debate', 'list']).debates[0].id, debateId);
  const { id: pollId } = invoke(outside, 'council_poll_create', { project: cwd, sourceDebateId: debateId,
    question: 'When?', options: ['Monday', 'Tuesday'] });
  const manage = (action, fields) => invoke(outside, 'council_poll_manage', { action, project: cwd, pollId, ...fields });
  assert.equal(manage('add-option', { label: 'Friday' }).options.at(-1).label, 'Friday');
  assert.equal(manage('track', { voter: 't20' }).participants[0].voter, 't20');
  assert.deepEqual(manage('untrack', { voter: 't20' }).participants, []);
  assert.equal(manage('close', { outcome: 'Friday' }).outcome, 'Friday');
  assert.equal(command(cwd, ['debate', 'show', debateId]).polls[0].id, pollId);
  const decision = { decision: 'Ship Friday', owner: 'QA', nextStep: 'Verify the build' };
  const closed = invoke(outside, 'council_debate_close', { project: cwd, debateId, ...decision, author: 'operator' });
  assert.equal(closed.closedBy, 't17');
  assert.deepEqual(command(cwd, ['debate', 'close', debateId, '--decision', decision.decision, '--owner', 'QA', '--next-step', decision.nextStep]), closed);
  assert.deepEqual(desktopRequest(cwd, 'debates', { id: debateId }).debate.decision, closed);
});

test('agent invitations bind explicit recipients before publication and preserve queues on a lost worker acknowledgement', async t => {
  const space = project(t);
  const cwd = join(space, 'packages', 'parser');
  mkdirSync(cwd, { recursive: true });
  const calls = [];
  const transport = async args => {
    calls.push(args);
    const address = args.at(-1);
    return args[0] === 'get' ? { ok: true, details: { address, state: 'live', reported: true, status: { app: 'junie' },
      labels: { 'herdr.space': address === 't3' ? 'other' : 'space' }, created_ms: 17 } } : { ok: false };
  };
  const publish = ({ beforePublish }) => createDebate(cwd, { question: 'Check the migration' }, { beforePublish });
  await assert.rejects(publishWithInvitations(cwd, ['t2', 't3'], publish, transport), /one Herdr space/);
  assert.equal(desktopRequest(cwd, 'debates', {}).debates.length, 0);
  const room = await publishWithInvitations(cwd, ['t2', 't2'], publish, transport);
  assert.equal(room.workerAddress, null);
  assert.match(room.nextAction, /saved/);
  assert.equal(calls.filter(args => args[0] === 'run').length, 1);
  assert.deepEqual(room.invitationDelivery.targets.map(({ address, createdAt, state }) => [address, createdAt, state]), [['t2', 17, 'queued']]);
  assert.deepEqual(command(cwd, ['debate', 'show', room.sessionId]).invitationDelivery.targets, room.invitationDelivery.targets);
  assert.deepEqual(desktopRequest(cwd, 'pending-invitations', { space: 'space' }).ids, [room.sessionId]);
  assert.deepEqual(desktopRequest(space, 'pending-invitations', { space: 'space', projects: [space], spaceFolders: [space] })
    ['pending-invitations'], [{ id: room.sessionId, project: cwd }]);
});

test('desktop discovers agent polls across projects and edits only the selected origin', t => {
  const operator = project(t);
  const agent = project(t);
  const local = desktopRequest(operator, 'create', { question: 'Desktop question', mode: 'open' });
  const byCli = command(agent, ['poll', 'create', '--question', 'CLI question', '--mode', 'open']);
  const byMcp = invoke(operator, 'council_poll_create', { project: agent, question: 'MCP question', mode: 'open' });
  const list = desktopRequest(operator, 'polls', { projects: [agent, join(agent, '.'), join(agent, 'missing')] });
  assert.deepEqual(list.errors.map(error => error.project), [join(agent, 'missing')]);
  assert.deepEqual(new Map(list.polls.map(poll => [poll.id, [poll.project, poll.createdBy]])), new Map([
    [local.id, [operator, 'operator']], [byCli.id, [agent, 't17']], [byMcp.id, [agent, 't17']]
  ]));

  const detail = list.polls.find(poll => poll.id === byMcp.id);
  desktopRequest(detail.project, 'vote', { id: detail.id, answer: 'Reply from Desktop' });
  const remote = invoke(operator, 'council_poll_read', { project: agent, pollId: detail.id });
  assert.equal(remote.responses[0].answer, 'Reply from Desktop');
  assert.throws(() => desktopRequest(operator, 'polls', { id: detail.id }), /not found/);
});

test('agents can open debate threads through CLI and MCP and see them in their Herdr space', t => {
  const space = project(t);
  const repository = join(space, 'repo');
  const terminalFolder = join(repository, 'src', 'parser');
  mkdirSync(terminalFolder, { recursive: true });
  const viaCli = command(repository, ['debate', 'create', '--question', 'Parser rollout', '--context', 'Opening from the CLI']);
  const viaMcp = invoke(space, 'council_debate_create', {
    project: repository, question: 'Parser tests', context: 'Opening from MCP'
  });
  assert.equal(viaMcp.project, repository);
  invoke(space, 'council_debate_reply', { project: repository, debateId: viaMcp.sessionId, text: 'Test recovery.' });

  const scope = { projects: [terminalFolder], spaceFolder: space };
  const { debates, errors } = desktopRequest(space, 'debates', scope);
  assert.deepEqual(errors, []);
  assert.deepEqual(new Set(debates.map(item => item.id)), new Set([viaCli.sessionId, viaMcp.sessionId]));
  assert.ok(debates.every(item => item.project === repository && item.createdBy === 't17' && item.status === 'open'));
  const { debate } = desktopRequest(repository, 'debates', { id: viaMcp.sessionId });
  assert.deepEqual(debate.messages.map(message => [message.author, message.body]),
    [['t17', 'Opening from MCP'], ['t17', 'Test recovery.']]);
  const { decisions } = desktopRequest(space, 'activity', scope);
  assert.ok(decisions.some(item => item.id === viaMcp.sessionId && item.tab === 'debates' && item.project === repository));
  const containerScope = { projects: [space], spaceFolder: space };
  assert.equal(desktopRequest(space, 'debates', containerScope).debates.length, 2, 'explicit child project with no terminal pane');
  assert.ok(desktopRequest(space, 'activity', containerScope).projects.includes(repository));
  assert.equal(desktopRequest(space, 'activity', { followFocus: false }).decisions.length, 0, 'pinning keeps the exact scope');
});

test('Desktop shows synchronous workflow runs and their saved contributions before and after completion', t => {
  const cwd = project(t);
  const workspace = new AgentWorkspace(cwd);
  const expected = [
    ['debate', 'debate-side-a', 'arguments', 'argument', 'debates', 'debate'],
    ['parallel', 'parallel-worker-1', 'subtasks', 'result', 'delegations', 'delegation'],
    ['pipeline', 'pipeline-stage-1', 'stage-1', 'result', 'delegations', 'delegation'],
    ['delegate', 'delegate-codex-1234', 'delegation', 'result', 'delegations', 'delegation']
  ];
  for (const [mode, name, phase, kind, tab, detailKey] of expected) {
    const { sid, sessionDir } = workspace.initSession({
      sessionId: `agent-${mode}`, mode, task: `Agent ${mode}`, participants: [{ name, agent: 'codex', role: 'author' }]
    });
    const inspect = () => desktopRequest(cwd, tab, { id: sid })[detailKey];
    const running = desktopRequest(cwd, 'activity', {}).runs.find(item => item.id === sid);
    assert.equal(running.group, 'active');
    assert.equal(inspect().status, 'pending_result');
    workspace.writeArtifact(sessionDir, { phase, author: name, agent: 'codex', content: 'Saved evidence', metadata: { source: 'terminal' } });
    assert.deepEqual(inspect().messages.map(item => [item.kind, item.body, item.source]), [[kind, 'Saved evidence', 'terminal']]);
    const output = workspace.saveFinalDeliverables(sessionDir, {
      markdownReport: 'Result', verdictJson: { sessionId: sid, mode, status: 'completed', completedAt: new Date().toISOString() },
      validationPassed: mode === 'delegate'
    });
    assert.equal(inspect().reportPath, output.reportPath);
    assert.equal(desktopRequest(cwd, 'activity', {}).runs.find(item => item.id === sid).group, 'ready');
  }
});

test('Workspace links background workflow jobs to their contributions without duplicating runs', async t => {
  const cwd = project(t);
  const manager = new JobManager({ cwd, herdr: {}, workerLauncher: () => ({ success: true }) });
  await manager.startJob({ sessionId: 'compare-options', task: 'Compare options', mode: 'debate' });
  const job = manager.readJobRecord('compare-options').job;
  const workflowSessionId = job.workflow.sessionId;
  new AgentWorkspace(cwd).initSession({ sessionId: workflowSessionId, task: job.task, mode: 'debate' });
  const { runs } = desktopRequest(cwd, 'activity', {});
  assert.deepEqual(runs.map(item => [item.id, item.workflowSessionId]), [['compare-options', workflowSessionId]]);
  assert.equal(desktopRequest(cwd, 'delegations', { id: job.sessionId }).delegation.workflowTab, 'debates');
  assert.equal(desktopRequest(cwd, 'debates', { id: workflowSessionId }).debate.status, 'pending_result');
});

test('an agent-started workflow that fails before any contributions is visible in Needs attention', async t => {
  const cwd = project(t);
  const orchestrator = new CouncilOrchestrator({ cwd, herdr: {
    launchAgent: () => ({ success: false, error: 'Fixture rejected launch' })
  } });
  await orchestrator.runMode({ mode: 'delegate', task: 'Inspect the parser', sessionId: 'agent-blocked' });
  const { runs } = desktopRequest(cwd, 'activity', {});
  assert.deepEqual(runs.map(item => [item.id, item.group]), [['agent-blocked', 'attention']]);
  const { delegation } = desktopRequest(cwd, 'delegations', { id: 'agent-blocked' });
  assert.equal(delegation.status, 'incomplete');
  assert.equal(delegation.error, 'Fixture rejected launch');
});

test('Debate shows current proposals, replies and ballots before a verdict', t => {
  const primary = project(t);
  const secondary = project(t);
  const workspace = new AgentWorkspace(secondary);
  const sessionId = 'design-review';
  new AgentWorkspace(primary).initSession({ sessionId, mode: 'review', task: 'Primary design' });
  const { sessionDir, sessionMeta } = workspace.initSession({ sessionId, mode: 'review', task: 'Agent design', participants: [
    { name: 'review-author', agent: 'claude', role: 'author' },
    { name: 'review-reviewer', agent: 'codex', role: 'reviewer' },
    { name: 'review-simplifier', agent: 'junie', role: 'simplifier' }
  ] });
  const origin = '2025-11-20T09:00:00.000Z';
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ ...sessionMeta, createdAt: origin }));
  const proposal = workspace.writeArtifact(sessionDir, {
    phase: 'proposal', author: 'review-author', agent: 'claude', content: 'Add a retry limit.',
    metadata: { createdAt: '2025-11-20T09:03:00.000Z', source: 'direct_artifact' }
  });
  const response = workspace.writeArtifact(sessionDir, {
    phase: 'review', author: 'review-reviewer', agent: 'codex', content: 'Record discarded attempts.',
    metadata: { createdAt: '2025-11-20T09:04:00.000Z', source: 'terminal_screen_fallback' }
  });
  workspace.writeArtifact(sessionDir, {
    phase: 'review', author: 'review-simplifier', agent: 'junie', content: 'Contribution from a previous run.',
    metadata: { createdAt: '2025-11-20T08:04:00.000Z', source: 'direct_artifact' }
  });
  const good = workspace.castBallot(sessionDir, {
    voter: 'review-reviewer', role: 'reviewer', agent: 'codex', vote: 'amend', score: 7,
    rationale: 'Add a metric.', amendments: ['Count failed attempts.'], targetArtifactSha256: proposal.sha256
  });
  writeFileSync(join(dirname(good.ballotPath), 'invalid-voter.json'), JSON.stringify({
    ...good.ballot, voter: 'invalid-voter', sessionId: 'different-run'
  }));

  const list = desktopRequest(primary, 'debates', { projects: [secondary] });
  assert.deepEqual(list.errors, []);
  assert.equal(list.debates.length, 2);
  const match = list.debates.find(item => item.question === 'Agent design');
  assert.equal(match.project, secondary);
  const debate = desktopRequest(match.project, 'debates', { id: sessionId }).debate;
  assert.equal(debate.status, 'pending');
  assert.deepEqual(debate.messages.map(message => [message.kind, message.agent]), [
    ['proposal', 'claude'], ['reply', 'codex'], ['ballot', 'codex']
  ]);
  assert.equal(debate.messages[1].source, 'terminal');
  assert.equal(debate.messages[2].ballot.rationale, 'Add a metric.');
  const review = desktopRequest(match.project, 'reviews', { id: sessionId }).review;
  assert.equal(review.tally, null);
  assert.equal(review.ballots[0].assigned, true);
  assert.equal(review.ballots[0].bound, true);
  assert.equal(review.ballots.length, 1);

  writeFileSync(response.artifactPath, `${readFileSync(response.artifactPath, 'utf8')} Modified after submission.`);
  assert.deepEqual(desktopRequest(match.project, 'debates', { id: sessionId }).debate.messages.map(message => message.kind),
    ['proposal', 'ballot']);
});

test('new Desktop debates accept replies from the CLI, MCP, and Desktop in their project', t => {
  const cwd = project(t);
  const outside = project(t);
  const debate = desktopRequest(cwd, 'debate-create', { question: 'How should we roll out?', context: 'We have two deployment windows.' });
  assert.equal(debate.interactive, true);
  assert.equal(debate.status, 'open');
  assert.equal(debate.messages[0].author, 'operator');
  const first = command(cwd, ['debate', 'reply', debate.id, '--text', 'Use the early window.']);
  const second = invoke(outside, 'council_debate_reply', { project: cwd, debateId: debate.id, text: 'Keep the later window for rollback.' });
  assert.equal(first.author, 't17');
  assert.equal(second.author, 't17');
  assert.notEqual(first.id, second.id);
  const updated = desktopRequest(cwd, 'debate-reply', { id: debate.id, text: 'Keep both on the calendar.' });
  const read = invoke(outside, 'council_debate_read', { project: cwd, debateId: debate.id });
  assert.deepEqual(updated.messages.map(message => message.body), read.messages.map(message => message.body));
  assert.equal(read.messages.length, 4);
  assert.equal(updated.messages.find(message => message.body === 'Keep both on the calendar.').author, 'operator');
  assert.equal(desktopRequest(cwd, 'reviews', { id: debate.id }).review, null);
});

test('Review and Debate compare each direct ballot with the exact proposal handed to the round', t => {
  const cwd = project(t);
  const workspace = new AgentWorkspace(cwd);
  const id = 'rollout-review';
  const { sessionDir, sessionMeta } = workspace.initSession({ sessionId: id, mode: 'review', task: 'Review the rollout',
    participants: [{ name: 'review-author', role: 'author', agent: 'claude' }] });
  const proposal = workspace.writeArtifact(sessionDir, {
    phase: 'proposal', author: 'review-author', agent: 'claude', content: 'First proposal.\r\n',
    metadata: { source: 'direct_artifact' }
  });
  const targetPath = join(sessionDir, 'task', 'proposal-target.json');
  writeFileSync(targetPath, JSON.stringify({ sessionId: id, createdAt: sessionMeta.createdAt, round: 1, sha256: proposal.sha256 }));
  const different = 'a'.repeat(64);
  for (const [voter, targetArtifactSha256, round = 1] of [
    ['matching', proposal.sha256], ['different', different], ['missing', ''], ['invalid', 'bad-digest'],
    ['other-round', proposal.sha256, 2]
  ]) workspace.castBallot(sessionDir, { voter, agent: 'codex', role: 'reviewer', vote: 'approve', score: 8, round, targetArtifactSha256 });

  writeFileSync(proposal.artifactPath, 'The artifact was edited.');
  const expected = { matching: 'match', different: 'mismatch', missing: 'missing', invalid: 'invalid', 'other-round': 'unavailable' };
  const matches = ballots => Object.fromEntries(ballots.map(ballot => [ballot.voter, ballot.proposalMatch]));
  const review = desktopRequest(cwd, 'reviews', { id }).review;
  assert.equal(review.proposal.sha256, proposal.sha256);
  assert.equal(review.proposal.source, 'handoff');
  assert.equal(review.status, 'pending');
  assert.equal(review.tally, null);
  assert.deepEqual(matches(review.ballots), expected);
  assert.deepEqual(matches(desktopRequest(cwd, 'debates', { id }).debate.messages
    .filter(message => message.ballot).map(message => message.ballot)), expected);

  unlinkSync(targetPath);
  const withoutTarget = desktopRequest(cwd, 'reviews', { id }).review;
  assert.equal(withoutTarget.proposal, null);
  assert.equal(matches(withoutTarget.ballots).matching, 'unavailable');
  writeFileSync(join(sessionDir, 'validation', 'verdict.json'), JSON.stringify({
    sessionId: id, mode: 'review', tally: { passed: false }, validation: {
      $schema: 'council.validation/v1', round: 1, verdict: 'vetoed', validatedAt: new Date().toISOString(),
      expectedSha256: proposal.sha256, verifiedSha256: different, artifactIntegrity: false, mutationDetected: true
    }
  }));
  const saved = desktopRequest(cwd, 'reviews', { id }).review;
  assert.equal(saved.proposal.source, 'saved');
  assert.deepEqual(matches(saved.ballots), expected);
  assert.equal(saved.status, 'vetoed');
});

test('a linked poll and a closed debate keep the source, decision and queued delivery in their original project', async t => {
  const operator = project(t);
  const cwd = project(t);
  const selection = { space: 'sp42', recipients: [{ address: 't17', label: 'Reviewer', createdAt: 17 }] };
  const debate = desktopRequest(cwd, 'debate-create', { ...selection, question: 'Decide the pilot scope' });
  const legacyId = '00000000-0000-4000-8000-000000000010';
  const legacyDir = join(cwd, '.agent_workspace', debate.id, 'messages');
  writeFileSync(join(legacyDir, `${legacyId}.json`), JSON.stringify({
    id: legacyId, sessionId: debate.id, author: 't17', body: 'Legacy reply',
    timestamp: debate.createdAt
  }));
  const pollInput = { ...selection, question: 'Which pilot?', mode: 'open', sourceDebateId: debate.id };
  assert.throws(() => desktopRequest(operator, 'create', pollInput), /not found/);
  const poll = desktopRequest(cwd, 'create', pollInput);
  assert.equal(command(cwd, ['poll', 'show', poll.id]).sourceDebateId, debate.id);
  assert.deepEqual(desktopRequest(cwd, 'debates', { id: debate.id }).debate.polls.map(item => item.id), [poll.id]);
  assert.deepEqual(desktopRequest(operator, 'pending-invitations', { projects: [cwd, cwd], space: selection.space })
    ['pending-invitations'].map(item => item.id).sort(), [debate.id, poll.id].sort());

  const input = { id: debate.id, decision: 'Start with one team', owner: 'Release lead', nextStep: 'Confirm rollback' };
  assert.throws(() => desktopRequest(cwd, 'debate-close', { ...input, owner: '' }), /Owner/);
  const closed = desktopRequest(cwd, 'debate-close', input);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.decision.closedAt, closed.closedAt);
  assert.equal(closed.decision.owner, input.owner);
  assert.equal(closed.decision.nextStep, input.nextStep);
  assert.equal(closed.messages[0].body, 'Legacy reply');
  assert.equal(closed.invitations[0].state, 'cancelled');
  assert.equal(closed.polls[0].id, poll.id);
  assert.deepEqual(desktopRequest(cwd, 'debate-close', input).decision, closed.decision);
  assert.throws(() => desktopRequest(cwd, 'debate-close', { ...input, owner: 'Another owner' }), /recorded decision/);
  assert.throws(() => desktopRequest(cwd, 'debate-reply', { id: debate.id, text: 'Late reply' }), /closed/);
  const fromCli = command(cwd, ['debate', 'show', debate.id]);
  const fromMcp = invoke(operator, 'council_debate_read', { project: cwd, debateId: debate.id });
  assert.deepEqual(fromCli.decision, closed.decision);
  assert.deepEqual(fromMcp.decision, closed.decision);
  await sendInvitations(cwd, runtime, { id: debate.id }, { events: () => assert.fail('closed debate started a feed') });
  assert.deepEqual(desktopRequest(operator, 'pending-invitations', { projects: [cwd], space: selection.space })
    ['pending-invitations'], [{ id: poll.id, project: cwd }]);
  assert.equal(desktopRequest(cwd, 'vote', { id: poll.id, answer: 'Use the existing pilot' }).responseCount, 1);
});

test('concurrent replies and competing closes have a single ordered outcome', async t => {
  const cwd = project(t);
  const debate = desktopRequest(cwd, 'debate-create', { question: 'Record one decision' });
  const call = async (action, fields) => JSON.parse((await run(process.execPath,
    [runtime, 'desktop', action, JSON.stringify({ id: debate.id, ...fields })], { cwd })).stdout);
  const attempts = await Promise.allSettled([
    ...Array.from({ length: 8 }, (_, i) => call('debate-reply', { text: `Reply ${i}` })),
    call('debate-close', { decision: 'Start pilot', owner: 'A', nextStep: 'Measure latency' }),
    call('debate-close', { decision: 'Hold pilot', owner: 'B', nextStep: 'Review burn-in' })
  ]);
  const accepted = attempts.slice(0, 8).flatMap((result, i) => result.status === 'fulfilled' ? [`Reply ${i}`] : []);
  const closes = attempts.slice(8).filter(result => result.status === 'fulfilled');
  assert.equal(closes.length, 1);
  for (const result of attempts.filter(r => r.status === 'rejected')) assert.match(result.reason.stderr, /closed|recorded decision/);
  const closed = desktopRequest(cwd, 'debates', { id: debate.id }).debate;
  assert.deepEqual(closed.decision, closes[0].value.decision);
  assert.deepEqual(closed.messages.map(message => message.body).sort(), accepted.sort());
});

test('dispatch defers busy and blocked terminals and never retries ambiguous delivery', async () => {
  const terminal = { state: 'live', reported: true, created_ms: 20, pid: 12,
    status: { state: 'idle', app: 'codex' }, labels: { 'herdr.space': 'sp42' } };
  terminal.labels[alignmentKey] = alignmentLabel(terminal, 'aligned').split('=')[1];
  const options = { space: 'sp42', address: 't5', createdAt: 20, message: 'Council invitation' };
  const commands = [];
  let status = 'working';
  let details = { started: true };
  const command = async args => {
    commands.push(args);
    return args[0] === 'get'
      ? { ok: true, details: { ...terminal, status: { ...terminal.status, state: status } } }
      : { ok: true, details };
  };
  for (const state of ['working', 'blocked']) {
    status = state;
    assert.equal(await inviteReadyAgent({ ...options, command }), 'queued');
  }
  assert.equal(await inviteReadyAgent({ ...options, space: 'other', command }), 'unavailable');
  assert.equal(await inviteReadyAgent({ ...options, createdAt: 21, command }), 'unavailable');
  assert.ok(commands.every(args => args[0] === 'get'));
  status = 'idle';
  assert.equal(await inviteReadyAgent({ ...options, command }), 'sent');
  assert.deepEqual(commands.at(-1), ['send', '--json', '--if', 'idle', 't5', 'Council invitation']);
  status = 'done';
  details = { started: false };
  assert.equal(await inviteReadyAgent({ ...options, command }), 'uncertain');
  assert.deepEqual(commands.at(-1), ['send', '--json', 't5', 'Council invitation']);
  assert.equal(await inviteReadyAgent({ ...options, command, stillOpen: () => false }), 'cancelled');
  assert.equal(commands.filter(args => args[0] === 'send').length, 2);
});

test('an unknown agent receives a neutral check without the poll or debate details', async () => {
  const terminal = { address: 't7', state: 'live', reported: true, created_ms: 20, pid: 12,
    status: { state: 'idle', app: 'codex' }, labels: { 'herdr.space': 'sp42' } };
  const actions = [];
  const text = 'Private project: C:/hidden; debate-secret-id';
  const command = async argv => {
    actions.push(argv);
    if (argv[0] === 'get') return { ok: true, details: terminal };
    return { ok: true, details: { started: true } };
  };
  let probeSent = false;
  const options = { address: 't7', space: 'sp42', message: text, command, markProbe: () => { probeSent = true; } };
  assert.equal(await inviteReadyAgent(options), 'alignment_required');
  assert.deepEqual(actions.map(args => args[0]), ['get', 'label', 'send']);
  assert.match(actions[2].at(-1), /alignment check/);
  assert.doesNotMatch(actions[2].at(-1), /hidden|debate-secret-id/);
  assert.equal(probeSent, true);
  assert.equal(await inviteReadyAgent({ ...options, probeSent }), 'alignment_required');
  terminal.labels[alignmentKey] = alignmentLabel(terminal, 'not_aligned').split('=')[1];
  assert.equal(await inviteReadyAgent({ ...options, probeSent }), 'not_aligned');
  assert.equal(actions.filter(args => args[0] === 'send').length, 1);
  terminal.labels[alignmentKey] = alignmentLabel(terminal, 'aligned').split('=')[1];
  assert.equal(await inviteReadyAgent({ ...options, probeSent }), 'sent');
  assert.equal(actions.at(-1).at(-1), text);
});

test('Desktop tracks the invited poll roster and projects persisted delivery uncertainty', t => {
  const cwd = project(t);
  const poll = desktopRequest(cwd, 'create', {
    question: 'When should we review?', mode: 'open', participants: [
      { address: 't7', label: 'Agent one' }, { address: 't8', label: 'Agent two' }, { address: 't7', label: 'Agent one' }
    ]
  });
  assert.deepEqual(poll.participants.map(person => person.voter), ['t7', 't8']);
  const inviteDir = join(cwd, '.agent_workspace', '.invites');
  mkdirSync(inviteDir);
  writeFileSync(join(inviteDir, `${poll.id}.json`), JSON.stringify({ id: poll.id, expiresAt: 1,
    targets: [{ address: 't7', state: 'sending' }, { address: 't8', state: 'queued' }] }));
  assert.deepEqual(readInvitations(cwd, poll.id).map(target => target.state), ['uncertain', 'expired']);
  const detail = desktopRequest(cwd, 'polls', { id: poll.id }).poll;
  assert.deepEqual(detail.invitations.map(target => target.state), ['uncertain', 'expired']);
  assert.equal(detail.invitationDelivery.expiresAt, 1);
  assert.ok(detail.invitations.every(target => !target.retryable));
});

test('Desktop retries only a confirmed unsent invitation in its original space', t => {
  const cwd = project(t);
  const space = 'sp42';
  const { id } = desktopRequest(cwd, 'create', { question: 'Review time?', mode: 'open', space, recipients: [
    { address: 't1', createdAt: 1 }, { address: 't2', createdAt: 2 }, { address: 't3', createdAt: 3 }, { address: 't4', createdAt: 4 }
  ] });
  const path = join(cwd, '.agent_workspace', '.invites', id + '.json');
  const queue = JSON.parse(readFileSync(path, 'utf8'));
  queue.expiresAt = 1;
  queue.targets[0].state = 'sent';
  queue.targets[1].state = 'sending';
  writeFileSync(path, JSON.stringify(queue));
  const delivery = () => desktopRequest(cwd, 'polls', { id }).poll.invitationDelivery;
  assert.deepEqual(delivery().targets.map(target => [target.state, target.retryable]), [
    ['sent', false], ['uncertain', false], ['expired', true], ['expired', true]
  ]);
  for (const address of ['t1', 't2', 't5']) {
    assert.throws(() => desktopRequest(cwd, 'invite-retry', { id, space, address }), /confirmed unsent/);
  }
  assert.throws(() => desktopRequest(cwd, 'invite-retry', { id, space: 'spOther', address: 't3' }), /original space/);
  const retry = desktopRequest(cwd, 'invite-retry', { id, space, address: 't3' });
  assert.ok(retry.expiresAt > Date.now());
  assert.equal(delivery().active, true);
  assert.deepEqual(delivery().targets.map(target => target.state), ['sent', 'uncertain', 'queued', 'expired']);
});

test('expired setup waits keep their reason and a setup check sends no invitation details', async t => {
  const cwd = project(t);
  const space = 'sp42';
  const { id } = desktopRequest(cwd, 'debate-create', { question: 'Discuss the private launch decision', space, recipients: [
    { address: 't1', createdAt: 20 }, { address: 't2', createdAt: 21 }
  ] });
  const path = join(cwd, '.agent_workspace', '.invites', `${id}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.expiresAt = 1;
  record.targets[0].state = 'alignment_required';
  record.targets[1].state = 'not_aligned';
  writeFileSync(path, JSON.stringify(record));
  const lock = `${path}.lock`;
  writeFileSync(lock, 'worker');
  const claimed = desktopRequest(cwd, 'debates', { id }).debate.invitationDelivery;
  assert.equal(claimed.claimed, true);
  assert.ok(claimed.targets.every(target => !target.retryable));
  assert.throws(() => desktopRequest(cwd, 'invite-retry', { id, space, address: 't1' }), /worker still holds/);
  unlinkSync(lock);
  const delivery = desktopRequest(cwd, 'debates', { id }).debate.invitationDelivery;
  assert.equal(delivery.active, false);
  assert.equal(delivery.claimed, false);
  assert.deepEqual(delivery.targets.map(({ state, reason, retryable }) => [state, reason, retryable]), [
    ['expired', 'alignment_required', true], ['expired', 'not_aligned', true]
  ]);
  const terminal = { address: 't1', state: 'live', reported: true, created_ms: 20, pid: 12,
    status: { state: 'idle', app: 'codex' }, labels: { 'herdr.space': space } };
  const calls = [];
  const command = async argv => { calls.push(argv); return { ok: true, details: argv[0] === 'get' ? terminal : { started: true } }; };
  assert.deepEqual(await checkInvitationAlignment(cwd, '/desktop-council.mjs', { id, space, address: 't1' }, command), { state: 'sent' });
  assert.deepEqual(calls.map(args => args[0]), ['get', 'label', 'send']);
  assert.match(calls.at(-1).at(-1), /alignment check/);
  assert.ok(!calls.at(-1).at(-1).includes(id));
  terminal.created_ms++;
  await assert.rejects(checkInvitationAlignment(cwd, '/desktop-council.mjs', { id, space, address: 't1' }, command), /original terminal/);
  assert.equal(calls.filter(args => args[0] === 'send').length, 1);
});

test('mixed conversation lists distinguish formal reviews and same-named project origins', t => {
  const cwd = project(t);
  const alpha = join(cwd, 'alpha', 'project');
  const beta = join(cwd, 'beta', 'project');
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  const { id } = desktopRequest(alpha, 'debate-create', { question: 'Team discussion' });
  const workspace = new AgentWorkspace(beta);
  workspace.initSession({ sessionId: 'review-proposal', mode: 'review', task: 'Review the proposal' });
  const list = desktopRequest(alpha, 'debates', { projects: [beta] }).debates;
  const labels = projectLabels([alpha, beta, cwd, alpha]);
  assert.equal(labels.get(alpha), alpha);
  assert.equal(labels.get(beta), beta);
  assert.equal(discussionType(list.find(item => item.id === id)), 'Debate thread');
  assert.equal(discussionType(list.find(item => item.id === 'review-proposal')), 'Formal review');
});
