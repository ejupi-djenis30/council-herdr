import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { CouncilMcpServer } from '../lib/mcp-server.js';
import { PollStore } from '../herdr/mods/council/runtime/polls.mjs';
import { decisionSummary, invitation } from '../herdr/mods/council/poll-text.js';

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL('../bin/council.js', import.meta.url));

function project(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'council-polls-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('mixed polls share one response per voter, options and the final decision', t => {
  const cwd = project(t);
  const store = new PollStore(cwd);
  const { id } = desktopRequest(cwd, 'create', {
    question: 'Which handoff?', mode: 'mixed', options: ['Diff', 'Checklist']
  });
  store.addOption(id, 'Pair review');
  assert.throws(() => store.addOption(id, 'PAIR   review'), /already exists/);
  desktopRequest(cwd, 'vote', { id, optionId: 'option-1', voter: 'someone-else' });
  store.vote(id, { voter: 't17', optionId: 'option-2', note: 'Easy to scan.' });
  store.vote(id, { voter: 'T17', answer: 'Link the diff from the checklist.' });

  const poll = desktopRequest(cwd, 'polls', { id }).poll;
  assert.deepEqual(poll.options.map(option => option.count), [1, 0, 0]);
  assert.equal(poll.freeCount, 1);
  assert.deepEqual(poll.responses.map(response => response.voter), ['operator', 't17']);
  assert.equal(store.close(id, 'Trial the combined handoff.').outcome, 'Trial the combined handoff.');
  assert.throws(() => store.addOption(id, 'Another'), /closed/);
  assert.throws(() => store.vote(id, { voter: 't18', optionId: 'option-2' }), /closed/);
  assert.throws(() => new PollStore(project(t)).show(id), /not found/);
});

test('response validation respects the chosen format', t => {
  const store = new PollStore(project(t));
  const open = store.create({ question: 'What did we miss?', mode: 'open' });
  const choice = store.create({ question: 'Proceed?', options: ['Yes', 'No'] });
  assert.throws(() => store.addOption(open.id, 'Later'), /free responses only/);
  assert.throws(() => store.vote(choice.id, { voter: 't1', optionId: 'option-9' }), /Unknown option/);
  assert.throws(() => store.vote(choice.id, { voter: 'operator', optionId: 'option-1' }), /reserved/);
  assert.throws(() => store.vote(choice.id, { voter: 't1', answer: 'Maybe' }), /listed options only/);
  assert.throws(() => store.vote(choice.id, { voter: 't1', optionId: 'option-1', answer: 'Maybe' }), /one option/);
  assert.equal(store.vote(open.id, { voter: 't1', answer: 'Check startup.' }).freeCount, 1);
  assert.throws(() => store.show('../reviews'), /Invalid poll ID/);
});

test('linked workspace directories and corrupt poll records fail closed', t => {
  const cwd = project(t);
  const other = project(t);
  symlinkSync(other, join(cwd, '.agent_workspace'), process.platform === 'win32' ? 'junction' : 'dir');
  const store = new PollStore(cwd);
  assert.throws(() => store.create({ question: 'Ready?', mode: 'open' }), /regular directory/);
  assert.throws(() => desktopRequest(cwd, 'reviews', {}), /regular directory/);
  assert.equal(existsSync(join(other, '.polls')), false);

  const valid = new PollStore(other);
  const { id } = valid.create({ question: 'Ready?', mode: 'open' });
  const first = join(other, '.agent_workspace', '.polls', id, '00000001.json');
  writeFileSync(first, Buffer.alloc(33 * 1024, 32));
  assert.throws(() => valid.show(id), /oversized file/);
  assert.deepEqual(valid.list().polls, []);
  assert.equal(valid.list().errors[0].id, id);
});
test('pre-roster polls replay and track participation without changing vote counts', t => {
  const cwd = project(t);
  const id = 'poll-54b163e2-cf4a-439e-ac72-82a74312ced2';
  const directory = join(cwd, '.agent_workspace', '.polls', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '00000001.json'), JSON.stringify({
    type: 'create',
    poll: {
      schema: 'council.poll/v1', id, question: 'What should we check?', mode: 'open', options: [],
      createdAt: '2026-11-18T11:00:00Z'
    }
  }));
  const store = new PollStore(cwd);
  assert.deepEqual(store.show(id).participants, []);
  desktopRequest(cwd, 'track', { id, voter: 'T18', label: 'Reviewer' });
  store.track(id, { voter: 't18', label: 'Ignored duplicate' });
  store.track(id, { voter: 't19', label: 'Simplifier' });
  store.vote(id, { voter: 'extra', answer: 'Check retries.' });
  assert.deepEqual(store.list().polls[0].participation, { expected: 2, received: 0 });
  store.vote(id, { voter: 't18', answer: 'Check startup.' });
  const poll = store.show(id);
  assert.deepEqual(poll.participants, [
    { voter: 't18', label: 'Reviewer' }, { voter: 't19', label: 'Simplifier' }
  ]);
  assert.equal(poll.responseCount, 2);
  assert.deepEqual(poll.participation, { expected: 2, received: 1 });
  const afterRemoval = desktopRequest(cwd, 'untrack', { id, voter: 't18' });
  assert.equal(afterRemoval.responseCount, 2);
  assert.deepEqual(afterRemoval.participation, { expected: 1, received: 0 });
  store.close(id, 'Start with retry and startup checks.');
  assert.throws(() => store.track(id, { voter: 't20' }), /closed/);
  assert.throws(() => store.untrack(id, 't19'), /closed/);
});

test('invitations and decision summaries reflect the response format and pending agents', t => {
  const cwd = project(t);
  const store = new PollStore(cwd);
  const { id } = store.create({ question: 'Which risks remain?', mode: 'open', context: 'Parser retry design' });
  store.track(id, { voter: 't1', label: 'Skeptic' });
  const open = store.track(id, { voter: 't2', label: 'Simplifier' });
  const invite = invitation(open, { folder: cwd, cli: cliPath, participant: open.participants[0] });
  assert.match(invite, /Which risks remain\?/);
  assert.match(invite, /--voter t1 --answer/);
  assert.doesNotMatch(invite, /--option/);
  store.vote(id, { voter: 't1', answer: 'Retry budget.', note: 'A cap keeps failures bounded.' });
  const closed = store.close(id, 'Cap retries at three.');
  const summary = decisionSummary(closed, cwd);
  assert.match(summary, /Closed · 1 response/);
  assert.match(summary, /Tracked agents responded: 1\/2/);
  assert.match(summary, /No response: Simplifier \(t2\)/);
  assert.match(summary, /Skeptic \(t1\): Retry budget\./);
  assert.match(summary, /Rationale: A cap keeps failures bounded\./);
  assert.match(summary, /Cap retries at three\./);
});

test('parallel CLI writers preserve all responses for the desktop and MCP', async t => {
  const cwd = project(t);
  const call = async (...args) => JSON.parse((await run(process.execPath, [cliPath, 'poll', ...args], { cwd })).stdout);
  const poll = await call('create', '--question', 'Which default?', '--option', 'A', '--option', 'B');
  await Promise.all([
    call('track', poll.id, '--voter', 'agent-0', '--label', 'Reviewer'),
    ...Array.from({ length: 8 }, (_, index) =>
      call('vote', poll.id, '--voter', `agent-${index}`, '--option', 'option-2'))
  ]);
  const server = new CouncilMcpServer({ cwd });
  const replies = [];
  server.sendResult = (_id, result) => replies.push(result);
  await server.handleToolCall(1, {
    name: 'council_poll_vote', arguments: { pollId: poll.id, voter: 'mcp-agent', optionId: 'option-1' }
  });
  const view = desktopRequest(cwd, 'polls', { id: poll.id }).poll;
  assert.deepEqual(view.options.map(option => option.count), [1, 8]);
  assert.deepEqual(view.participation, { expected: 1, received: 1 });
  assert.equal(JSON.parse(replies[0].content[0].text).responseCount, 9);
  await server.handleToolCall(2, { name: 'council_poll_read', arguments: { pollId: poll.id } });
  assert.equal(JSON.parse(replies[1].content[0].text).responseCount, 9);
  await call('close', poll.id);
  await server.handleToolCall(3, {
    name: 'council_poll_vote', arguments: { pollId: poll.id, voter: 'mcp-agent', optionId: 'option-2' }
  });
  assert.equal(replies[2].isError, true);
});

test('review projection requires a current saved, validated result for approval', t => {
  const cwd = project(t);
  const id = 'parser-review';
  const dir = join(cwd, '.agent_workspace', id);
  const write = (relative, value) => {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value));
  };
  const verdict = {
    mode: 'review', sessionId: id,
    tally: { passed: true, quorumMet: true, invalidCount: 0 },
    validation: {
      $schema: 'council.validation/v1', verdict: 'validated', passed: true,
      artifactIntegrity: true, mutationDetected: false, validatedAt: '2026-11-18T12:00:00Z'
    }
  };
  const status = () => desktopRequest(cwd, 'reviews', { id }).review.status;
  write('session.json', { mode: 'review', sessionId: id, createdAt: '2026-11-18T11:00:00Z' });
  write('validation/verdict.json', verdict);
  assert.equal(status(), 'unconfirmed');
  verdict.validation.validatedAt = '2026-11-18T12:01:00Z';
  write('reports/verdict.json', verdict);
  assert.equal(status(), 'approved');
  write('session.json', { mode: 'review', sessionId: id, createdAt: '2026-11-18T13:00:00Z' });
  assert.equal(status(), 'pending');
  verdict.validation = { ...verdict.validation, validatedAt: '2026-11-18T13:02:00Z', verdict: 'provisional', passed: false };
  write('validation/verdict.json', verdict);
  assert.equal(status(), 'provisional');
});
