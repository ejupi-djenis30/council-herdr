import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeEngine } from '../herdr/mods/council/machine-engine.js';
import { WorkItems, newWorkItemId, workItemInput, workItemScreenVisible } from '../herdr/mods/council/work-item-actions.js';

// Verbatim wire examples from the frozen COU-2 revision b5efd465.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/work-item-workspace.json', import.meta.url), 'utf8'));
const example = fixtures.createInput;
const scope = (project, machine = null, space = 'workspace') => ({
  project, space, anchor: project, engine: { machine, node: 'node', cli: '/installed engine/bin/council.js', entry: '/installed mod/runtime/council.mjs' }
});
const local = scope(fixtures.create.project);
const peer = scope('D:\\Shared Workspace\\Example', 'herdr-peer', 'remote-workspace');
const roster = [{ id: 'verifier', role: 'Verifier' }];
const team = { members: roster };
const wire = (fixture, project = local.project) => ({ code: fixture.success ? 0 : 1, stdout: JSON.stringify({ ...fixture, project }), stderr: '' });
const failure = (code, project = local.project) => wire({ success: false, error: { code, message: `Fixture error ${code}` } }, project);
const form = { title: example.title, criteria: example.criteria.join('\n') };

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function harness(responses, teamResponse = team) {
  const calls = [];
  let active = { space: { id: local.space, machine: null }, target: local.anchor, workspaceActive: true };
  const exec = async (program, args, options) => {
    calls.push({ program, args, ...options });
    assert.ok(responses.length, `Unexpected command ${args.join(' ')}`);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  const work = new WorkItems({
    runCli: (cwd, args, engine) => executeEngine(exec, engine, 'cli', args, cwd, 30000),
    readTeam: (cwd, engine) => executeEngine(async (program, args, options) => {
      calls.push({ program, args, ...options });
      return teamResponse;
    }, engine, 'entry', ['desktop', 'team', '{}'], cwd, 10000),
    visible: screen => workItemScreenVisible(screen, active),
    createId: () => example.id
  });
  const focus = (next, target = next.anchor) => {
    active = { space: { id: next.space, machine: next.engine.machine }, target, workspaceActive: true };
  };
  return { work, calls, focus };
}

async function createScreen(work, origin = local) {
  await work.showList(origin);
  await work.startCreate(work.current);
  const screen = work.current;
  screen.roleId = example.roleId;
  return screen;
}

async function detailScreen(work, origin = local) {
  await work.showList(origin);
  await work.open(work.current, example.id);
  return work.current;
}

const operations = calls => calls.map(call => call.args.slice(1, 3).join(' '));

test('Work items preserve valid rows, individual read issues and exact project-machine arguments', async () => {
  const { work, calls, focus } = harness([wire(fixtures.list, 'd:/shared workspace/example'), wire(fixtures.list, peer.project)]);
  focus(peer);
  await work.showList(peer);
  assert.deepEqual(work.current.items, fixtures.list.items);
  assert.deepEqual(work.current.errors, fixtures.list.errors);
  await work.refresh(work.current);
  assert.deepEqual(calls, Array(2).fill({
    program: 'node', args: [peer.engine.cli, 'work-item', 'list'], cwd: peer.project, on: peer.engine.machine, timeout: 30000
  }));
});

test('Work items show old engine and typed nonzero failures without accepting foreign or malformed bytes', async () => {
  const { work } = harness([
    { code: 1, stdout: 'Council CLI 3.7.1', stderr: 'Unknown command: work-item' },
    failure('storage_error'),
    wire(fixtures.list, peer.project),
    { ...wire(fixtures.list), code: 1 },
    wire({ ...fixtures.list, items: [{ ...fixtures.list.items[0], canDelegate: 'yes' }] })
  ]);
  await work.showList(local);
  assert.match(work.current.error, /update Council/);
  await work.refresh(work.current);
  assert.match(work.current.error, /Fixture error storage_error/);
  for (let retry = 0; retry < 3; retry++) {
    await work.refresh(work.current);
    assert.equal(work.current.items, undefined);
    assert.match(work.current.error, /unreadable work item response/);
  }
});

test('Work items keep criteria in review order and reject interior blank lines and control characters', () => {
  assert.deepEqual(workItemInput(example.id, {
    ...form, criteria: '\r\n  First criterion. \r\nSecond criterion.\r\n', roleId: 'verifier'
  }).criteria, ['First criterion.', 'Second criterion.']);
  for (const fields of [
    { ...form, criteria: 'First\n\nThird' }, { ...form, criteria: 'bad\tcriterion' },
    { ...form, title: 'first\nsecond' }, { ...form, title: 'a'.repeat(161) }, { ...form, roleId: undefined }
  ]) assert.throws(() => workItemInput(example.id, { roleId: 'verifier', ...fields }), { code: 'invalid_input' });
  assert.match(newWorkItemId(), /^wi-[a-z0-9][a-z0-9-]{0,59}$/);
});

test('Work items read Team from the same peer and cannot save without a role from that roster', async () => {
  const { work, calls, focus } = harness([wire(fixtures.list, peer.project)], { members: [] });
  focus(peer);
  const screen = await createScreen(work, peer);
  assert.deepEqual(screen.roles, []);
  await work.save(screen, form);
  assert.match(screen.error, /from this project/);
  assert.deepEqual(calls[1], {
    program: 'node', args: [peer.engine.entry, 'desktop', 'team', '{}'], cwd: peer.project, on: peer.engine.machine, timeout: 10000
  });
  assert.deepEqual(operations(calls), ['work-item list', 'desktop team']);
});

test('a delayed list cannot replace data after terminal focus changes projects or machines', async () => {
  const late = deferred();
  const newer = deferred();
  const sameMachine = scope('/another project');
  const { work, calls, focus } = harness([late.promise, newer.promise, wire(fixtures.list, peer.project)]);
  const first = work.showList(local);
  const firstScreen = work.current;
  focus(sameMachine);
  late.release(wire(fixtures.list));
  await first;
  assert.equal(firstScreen.items, undefined);
  const second = work.showList(sameMachine);
  const secondScreen = work.current;
  focus(peer);
  await work.showList(peer);
  newer.release(wire(fixtures.list, sameMachine.project));
  await second;
  assert.equal(secondScreen.items, undefined);
  assert.equal(work.current.scope, peer);
  assert.deepEqual(calls.map(call => [call.cwd, call.on]), [[local.project, null], [sameMachine.project, null], [peer.project, 'herdr-peer']]);
});

test('a late roster cannot be applied to a form on another machine', async () => {
  const oldTeam = deferred();
  const { work, focus } = harness([wire(fixtures.list), wire(fixtures.list, peer.project)], oldTeam.promise);
  await work.showList(local);
  const pending = work.startCreate(work.current);
  const oldForm = work.current;
  focus(peer);
  await work.showList(peer);
  oldTeam.release(team);
  await pending;
  assert.equal(oldForm.roles, undefined);
  assert.equal(work.current.scope, peer);
  assert.equal(work.current.kind, 'list');
});

test('a lost create response is reconciled with a show of the same ID and exact ordered content', async () => {
  const submission = deferred();
  const { work, calls } = harness([wire(fixtures.list), submission.promise, wire(fixtures.create)]);
  const screen = await createScreen(work);
  const pending = work.save(screen, form);
  await work.save(screen, form);
  submission.release({ code: 0, stdout: 'invalid acknowledgement', stderr: '' });
  await pending;
  assert.deepEqual(operations(calls), ['work-item list', 'desktop team', 'work-item create', 'work-item show']);
  assert.deepEqual(calls[2].args.slice(1), ['work-item', 'create', '--input-json', JSON.stringify(example)]);
  assert.deepEqual(calls[3].args.slice(1), ['work-item', 'show', '--id', example.id]);
  assert.equal(work.current.kind, 'detail');
  assert.deepEqual(work.current.item, fixtures.create.item);
});

test('create retry requires a successful same-project not-found read and replays the frozen input only by request', async () => {
  const { work, calls } = harness([
    wire(fixtures.list), new Error('Lost exec reply'), failure('not_found', null), failure('not_found'), wire(fixtures.create)
  ]);
  const screen = await createScreen(work);
  await work.save(screen, form);
  assert.equal(work.createAttempt(screen).phase, 'unresolved');
  await work.save(screen, form);
  assert.equal(operations(calls).filter(operation => operation === 'work-item create').length, 1);
  await work.refresh(screen);
  assert.equal(work.createAttempt(screen).phase, 'missing');
  await work.save(screen, { title: 'Edited during retry', criteria: 'Changed' });
  assert.deepEqual(calls[2].args, calls[5].args);
  assert.equal(work.current.kind, 'detail');
});

test('create reconciliation holds a conflicting ID without dispatching a replacement draft', async () => {
  const different = { ...fixtures.create, item: { ...fixtures.create.item, criteria: [...example.criteria].reverse() } };
  const { work, calls } = harness([wire(fixtures.list), wire(different), wire(different), wire(fixtures.list)]);
  const screen = await createScreen(work);
  await work.save(screen, form);
  assert.equal(work.createAttempt(screen).phase, 'conflict');
  assert.match(work.createAttempt(screen).message, /different saved inputs/);
  await work.save(screen, form);
  await work.discardCreate(screen);
  assert.equal(work.current.kind, 'list');
  assert.deepEqual(operations(calls), ['work-item list', 'desktop team', 'work-item create', 'work-item show', 'work-item list']);
});

test('switching machines during create keeps reconciliation on the original engine and cannot navigate the new workspace', async () => {
  const submission = deferred();
  const { work, calls, focus } = harness([
    wire(fixtures.list), submission.promise, wire(fixtures.list, peer.project), wire(fixtures.create), wire(fixtures.list), wire(fixtures.create)
  ]);
  const screen = await createScreen(work);
  const pending = work.save(screen, form);
  focus(peer);
  await work.showList(peer);
  submission.release({ code: 0, stdout: '', stderr: '' });
  await pending;
  assert.equal(work.current.scope, peer);
  assert.equal(work.current.kind, 'list');
  assert.equal(calls[4].cwd, local.project);
  assert.equal(calls[4].on, null);
  focus(local);
  await work.showList(local);
  await work.startCreate(work.current);
  assert.equal(work.createAttempt(work.current).phase, 'saved');
  await work.refresh(work.current);
  assert.equal(work.current.kind, 'detail');
  assert.equal(operations(calls).filter(operation => operation === 'work-item create').length, 1);
});

test('delegate sends only the ID once and a lost receipt uses show on the same engine', async () => {
  const wait = deferred();
  const { work, calls, focus } = harness([wire(fixtures.list), wire(fixtures.create), wait.promise, wire(fixtures.unconfirmed)]);
  const screen = await detailScreen(work);
  const pending = work.delegate(screen);
  assert.equal(work.delegationPending(screen), 'writing');
  await work.delegate(screen);
  focus(local, '/focus moved within this space');
  wait.release({ code: 0, stdout: '', stderr: '' });
  await pending;
  assert.equal(screen.item.state, 'needs_attention');
  assert.equal(work.delegationPending(screen), undefined);
  assert.equal(work.delegationLink(screen), null);
  assert.deepEqual(calls[2].args.slice(1), ['work-item', 'delegate', '--id', example.id]);
  assert.deepEqual(calls[3].args.slice(1), ['work-item', 'show', '--id', example.id]);
  assert.equal(calls[3].cwd, local.project);
});

test('draft or unavailable reconciliation holds delegate until an explicit successful refresh', async () => {
  const { work, calls } = harness([
    wire(fixtures.list), wire(fixtures.create), new Error('Lost reply'), wire(fixtures.create),
    failure('storage_error'), wire(fixtures.create), wire(fixtures.delegating)
  ]);
  const screen = await detailScreen(work);
  await work.delegate(screen);
  assert.equal(work.delegationPending(screen), 'unresolved');
  await work.refresh(screen);
  assert.equal(work.delegationPending(screen), 'unresolved');
  await work.delegate(screen);
  assert.equal(operations(calls).filter(operation => operation === 'work-item delegate').length, 1);
  await work.refresh(screen);
  assert.equal(work.delegationPending(screen), undefined);
  await work.delegate(screen);
  assert.equal(screen.item.state, 'in_progress');
});

test('verified delegation handoff keeps the saved project, machine and source and ignores stale selection', async () => {
  const { work, calls, focus } = harness([
    wire(fixtures.list, peer.project), wire(fixtures.resultReady, peer.project), wire(fixtures.unconfirmed, peer.project)
  ]);
  focus(peer);
  const screen = await detailScreen(work, peer);
  focus(peer, 'D:\\other folder');
  assert.deepEqual(work.delegationLink(screen), {
    tab: 'delegations', id: fixtures.resultReady.item.job.sessionId, project: peer.project, machine: peer.engine.machine
  });
  assert.equal(screen.item.result.source, 'terminal_screen');
  assert.equal(screen.item.nextAction, fixtures.resultReady.item.nextAction);
  await work.refresh(screen);
  assert.equal(work.delegationLink(screen), null);
  assert.equal(calls.at(-1).cwd, peer.project);
  focus(local);
  await work.refresh(screen);
  assert.equal(calls.length, 3);
});

test('a delegation finishing after reopening the same draft forces a new authoritative read', async () => {
  const waiting = deferred();
  const { work, calls } = harness([
    wire(fixtures.list), wire(fixtures.create), waiting.promise, wire(fixtures.list), wire(fixtures.create), wire(fixtures.delegating)
  ]);
  const oldDetail = await detailScreen(work);
  const pending = work.delegate(oldDetail);
  const newDetail = await detailScreen(work);
  waiting.release(wire(fixtures.delegating));
  await pending;
  assert.equal(newDetail.item.state, 'draft');
  assert.equal(work.delegationPending(newDetail), 'unresolved');
  await work.delegate(newDetail);
  assert.equal(operations(calls).filter(operation => operation === 'work-item delegate').length, 1);
  await work.refresh(newDetail);
  assert.equal(newDetail.item.state, 'in_progress');
});
