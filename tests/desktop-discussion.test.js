import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentWorkspace } from '../lib/workspace.js';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { checkInvitationAlignment, inviteReadyAgent, prepareInvitations, readInvitations, sendInvitations } from '../herdr/mods/council/runtime/invitations.mjs';
import { alignmentKey, alignmentLabel } from '../herdr/mods/council/runtime/alignment.mjs';
import { discussionType, projectLabels } from '../herdr/mods/council/poll-text.js';

const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));

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

test('Desktop persists launch failures and retries only a confirmed unsent original terminal', async t => {
  const cwd = project(t);
  const { id } = desktopRequest(cwd, 'create', { question: 'Review time?', mode: 'open' });
  const space = 'sp42';
  const ticket = desktopRequest(cwd, 'invite-prepare', { id, space, recipients: [
    { address: 't1', createdAt: 1 }, { address: 't2', createdAt: 2 }, { address: 't3', createdAt: 3 }, { address: 't4' }
  ] });
  const delivery = () => desktopRequest(cwd, 'polls', { id }).poll.invitationDelivery;
  assert.equal(delivery().active, true);
  assert.ok(delivery().expiresAt > Date.now());
  assert.equal(desktopRequest(cwd, 'invite-launch-failed', ticket).recorded, true);
  assert.equal(delivery().active, false);
  assert.deepEqual(delivery().targets.map(target => [target.state, target.retryable]), [
    ['dispatch_failed', true], ['dispatch_failed', true], ['dispatch_failed', true], ['dispatch_failed', false]
  ]);
  const path = join(cwd, '.agent_workspace', '.invites', `${id}.json`);
  const recorded = JSON.parse(readFileSync(path, 'utf8'));
  recorded.targets[0].state = 'sent';
  recorded.targets[1].state = 'uncertain';
  writeFileSync(path, JSON.stringify(recorded));
  for (const address of ['t1', 't2', 't4', 't5']) {
    assert.throws(() => desktopRequest(cwd, 'invite-prepare', { id, space, address }), /confirmed unsent/);
  }
  assert.throws(() => desktopRequest(cwd, 'invite-prepare', { id, space: 'spOther', address: 't3' }), /not ready to retry/);
  const retry = desktopRequest(cwd, 'invite-prepare', { id, space, address: 't3' });
  assert.notEqual(retry.dispatchId, ticket.dispatchId);
  assert.equal(desktopRequest(cwd, 'invite-launch-failed', ticket).recorded, false);
  await sendInvitations(cwd, '/desktop-council.mjs', ticket);
  assert.equal(delivery().active, true);
  assert.deepEqual(delivery().targets.map(target => target.state), ['sent', 'uncertain', 'queued', 'dispatch_failed']);
  assert.throws(() => desktopRequest(cwd, 'invite-prepare', { id, space, address: 't3' }), /not ready to retry/);
});

test('expired setup waits keep their reason and a setup check sends no invitation details', async t => {
  const cwd = project(t);
  const debate = desktopRequest(cwd, 'debate-create', { question: 'Discuss the private launch decision' });
  const { id } = debate;
  const space = 'sp42';
  const { dispatchId } = prepareInvitations(cwd, { id, space, recipients: [
    { address: 't1', createdAt: 20 }, { address: 't2', createdAt: 21 }
  ] }, { lifetime: -1 });
  const path = join(cwd, '.agent_workspace', '.invites', `${id}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.targets[0].state = 'alignment_required';
  record.targets[1].state = 'not_aligned';
  writeFileSync(path, JSON.stringify(record));
  const lock = `${path}.lock`;
  writeFileSync(lock, 'worker');
  const claimed = desktopRequest(cwd, 'debates', { id }).debate.invitationDelivery;
  assert.equal(claimed.claimed, true);
  assert.ok(claimed.targets.every(target => !target.retryable));
  assert.throws(() => prepareInvitations(cwd, { id, space, address: 't1' }), /worker still holds/);
  assert.equal(desktopRequest(cwd, 'invite-launch-failed', { id, dispatchId }).recorded, false);
  unlinkSync(lock);
  await sendInvitations(cwd, '/desktop-council.mjs', { id, space, dispatchId });
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
