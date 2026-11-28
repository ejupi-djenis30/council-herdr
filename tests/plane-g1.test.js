import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { WorkItemStore } from '../herdr/mods/council/runtime/work-item-store.mjs';
import { createFixtureOperator, parseEvidenceUrl, assessFixtureAdmission } from '../herdr/mods/council/runtime/plane-fixture.mjs';
import { workItemOperation } from '../lib/work-items.js';
import { profile, installationId, fixtureTransport, issueIds, github } from './fixtures/plane-g1.mjs';

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'plane-g1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'one', 'Council'), other = join(root, 'two', 'Council'), privateRoot = join(root, 'private');
  for (const dir of [project, other, privateRoot]) mkdirSync(dir, { recursive: true });
  for (const p of [project, other]) {
    new TeamStore(p).set({ id:'dev', agent:'codex', role:'Dev' });
    assert.equal((await workItemOperation('create', { id:'wi-shared', title:'Work', roleId:'dev', criteria:['Done'] }, { project:p })).success, true);
  }
  const make = (p = project, overrides = {}) => createFixtureOperator({ project:p, privateRoot, installationId, profile,
    transport: fixtureTransport(), itemExists: (r, id) => Boolean(new WorkItemStore(r).read(id, 1)), ...overrides });
  return { root, project, other, privateRoot, make };
}

test('legacy item has disabled additive offline projection and ordinary surfaces cannot write', async t => {
  const { project } = await setup(t);
  const before = JSON.stringify((await workItemOperation('show', { id:'wi-shared' }, { project })).item);
  const events = join(project, '.agent_workspace', '.work-items', 'wi-shared');
  const snapshot = () => readdirSync(events).sort().map(name => [name, readFileSync(join(events, name)).toString('hex')]);
  const initialEvents = snapshot();
  const cli = resolve('bin/council.js');
  const run = (...args) => spawnSync(process.execPath, [cli, 'work-item', ...args, '--project', project], { encoding:'utf8' });
  let p = run('plane', 'show', '--id', 'wi-shared');
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).installationId, null);
  assert.deepEqual(JSON.parse(p.stdout).plane, { availability:'disabled', freshness:'unavailable', link:null, operation:null });
  p = run('plane', 'open', '--id', 'wi-shared');
  assert.equal(JSON.parse(p.stdout).installationId, null);
  assert.deepEqual(JSON.parse(p.stdout).planeHandoff, { disposition:'unavailable', localRef:null, operationId:null });
  p = spawnSync(process.execPath, [cli, 'work-item', 'plane', 'show', '--id', 'wi-shared', '--project', project],
    {encoding:'utf8', env:{...process.env, COUNCIL_INSTALLATION_ID:installationId}});
  assert.equal(JSON.parse(p.stdout).installationId, null);
  for (const args of [['plane','confirm','--id','wi-shared'], ['plane','show','--id','wi-shared','--profile','x'], ['plane','show','--id','wi-shared','--operation-id','bad'], ['plane','show','--id','wi-shared','--installation-id',installationId], ['plane','open','--id','wi-shared','--installation-id',installationId]]) assert.notEqual(run(...args).status, 0);
  const frames = [
    {jsonrpc:'2.0', id:1, method:'tools/list'},
    {jsonrpc:'2.0', id:2, method:'tools/call', params:{name:'council_work_item_plane_show',arguments:{project,id:'wi-shared'}}},
    {jsonrpc:'2.0', id:3, method:'tools/call', params:{name:'council_work_item_plane_show',arguments:[]}},
    {jsonrpc:'2.0', id:4, method:'tools/call', params:{name:'council_work_item_plane_show',arguments:{project,id:'wi-shared',profile:'x'}}},
    {jsonrpc:'2.0', id:5, method:'tools/call', params:{name:'council_work_item_plane_show',arguments:{project,id:'wi-shared',installationId}}}
  ];
  p = spawnSync(process.execPath, [cli,'mcp'], { cwd:project, input:frames.map(JSON.stringify).join('\n')+'\n', encoding:'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const replies = new Map(p.stdout.trim().split(/\r?\n/).map(JSON.parse).map(r => [r.id, r.result]));
  const names = replies.get(1).tools.map(x => x.name);
  assert.ok(names.includes('council_work_item_plane_show'));
  assert.ok(!names.some(n => /council_work_item_plane_(publish|confirm|link|open)/.test(n)));
  assert.equal(JSON.parse(replies.get(2).content[0].text).plane.availability, 'disabled');
  assert.equal(JSON.parse(replies.get(2).content[0].text).installationId, null);
  assert.equal(replies.get(3).isError, true); assert.equal(replies.get(4).isError, true);
  assert.equal(replies.get(5).isError, true);
  assert.equal(JSON.stringify((await workItemOperation('show', { id:'wi-shared' }, { project })).item), before);
  assert.deepEqual(snapshot(), initialEvents);
});

test('fixture links are scope bound, persist offline and do not change COU-8', async t => {
  const { project, other, privateRoot, make } = await setup(t);
  const transport = fixtureTransport();
  const one = make(project, {transport});
  const two = make(other);
  const before = await workItemOperation('show', {id:'wi-shared'}, {project});
  const a = await one.resolve('wi-shared', 'COU-12');
  await assert.rejects(two.confirm('wi-shared', a.candidateId, a.localRef), {code:'scope_conflict'});
  const link = await one.confirm('wi-shared', a.candidateId, a.localRef);
  assert.equal(link.itemId, issueIds[0]);
  assert.deepEqual(await one.confirm('wi-shared', a.candidateId, a.localRef), link);
  assert.equal(two.inspect('wi-shared').link, null);
  const offline = make(project, { transport: { get() { throw Error('offline'); } } });
  assert.deepEqual(offline.inspect('wi-shared').link, link);
  const projected = await workItemOperation('plane_show', {id:'wi-shared'}, {project, planeFixture:offline});
  assert.equal(projected.installationId, installationId);
  assert.equal(projected.plane.freshness, 'cached'); assert.deepEqual(projected.plane.link, link);
  assert.equal((await workItemOperation('plane_open', {id:'wi-shared'}, {project, planeFixture:offline})).installationId, installationId);
  assert.equal((await workItemOperation('plane_show', {id:'wi-shared'}, {project:other, planeFixture:offline})).error.code, 'scope_conflict');
  const after = await workItemOperation('show', {id:'wi-shared'}, {project});
  assert.deepEqual(after.item, before.item);
  assert.equal(transport.posts, 0); assert.equal(transport.planningWrites, 0);
  assert.ok(transport.calls.every(([method, route]) => method === 'GET' && route.startsWith('/api/v1/')));
  assert.equal(readdirSync(privateRoot).length, 1);
});

test('v1 fixture rejects scope, role, item, status and transport mismatches before writing', async t => {
  const { make, privateRoot } = await setup(t);
  const cases = [
    (route,r) => { if (route === '/api/v1/users/me/') r.body.id = issueIds[1]; },
    (route,r) => { if (route.endsWith(`/projects/${profile.projectId}/`)) r.body.identifier = 'OTHER'; },
    (route,r) => { if (route.endsWith(`/projects/${profile.projectId}/`)) r.body.member_role = 10; },
    (route,r) => { if (route.endsWith(`/projects/${profile.projectId}/`)) r.body.member_role = '20'; },
    (route,r) => { if (route.endsWith(`/projects/${profile.projectId}/`)) r.body.is_member = false; },
    (route,r) => { if (route.endsWith(`/projects/${profile.projectId}/`)) delete r.body.is_member; },
    (route,r) => { if (route.endsWith(`/projects/${profile.projectId}/`)) r.body.deleted_at = '2020-01-01'; },
    (route,r) => { if (route.endsWith(`/projects/${profile.projectId}/`)) r.body.archived_at = '2020-01-01'; },
    (route,r) => { if (route.endsWith('/COU-12/')) r.body.workspace = issueIds[1]; },
    (route,r) => { if (route.endsWith('/COU-12/')) r.body.sequence_id = 13; },
    (route,r) => { if (route.endsWith(`/work-items/${issueIds[0]}/`)) r.body.project = issueIds[1]; },
    (route,r) => { if (route.endsWith(`/work-items/${issueIds[0]}/`)) r.body.is_draft = true; },
    (route,r) => { if (route.endsWith(`/work-items/${issueIds[0]}/`)) r.body.archived_at = '2020-01-01'; },
    (route,r) => { if (route.endsWith(`/work-items/${issueIds[0]}/`)) r.body.deleted_at = '2020-01-01'; },
    (route,r) => { if (route === '/api/v1/users/me/') r.status = 401; },
    (route,r) => { if (route === '/api/v1/users/me/') r.redirected = true; },
  ];
  for (const mutate of cases) await assert.rejects(make(undefined, {transport:fixtureTransport(profile, mutate)}).resolve('wi-shared','COU-12'));
  await assert.rejects(make(undefined, {transport:{get(){throw Error('TLS failure with private details');}}}).resolve('wi-shared','COU-12'), {code:'offline'});
  assert.deepEqual(readdirSync(privateRoot), []);
});

test('profile pins and item references reject invalid scope and support exact UUID lookup', async t => {
  const { make, privateRoot } = await setup(t);
  for (const replacement of [
    {origin:'http://example.test:4321'}, {origin:'https://example.test/path'}, {workspaceSlug:'../other'},
    {projectKey:'cou'}, {projectId:issueIds[0].toUpperCase()}, {principalId:'bad'}, {allowedRoles:[]},
    {allowedRoles:['20']}, {allowedRoles:[-1]}, {allowedRoles:[20.5]}
  ]) assert.throws(() => make(undefined, {profile:{...profile,...replacement}}), {code:'invalid_input'});
  const operator = make();
  for (const reference of ['COU-012', 'OTHER-12', '../COU-12', 'COU-9007199254740992']) await assert.rejects(operator.resolve('wi-shared', reference));
  const result = await operator.resolve('wi-shared', issueIds[0]);
  assert.equal(result.link.itemIdentifier, 'COU-12');
  assert.deepEqual(readdirSync(privateRoot), []);
});

test('URL forms and registry pins fail closed without provider access', () => {
  const registry = github.registry;
  assert.equal(github.repository.id, registry.id);
  assert.equal(github.repository.private, false);
  assert.equal(github.pull.base.repo.id, registry.id);
  assert.equal(parseEvidenceUrl(github.pull.html_url, registry).reference, String(github.pull.number));
  assert.equal(parseEvidenceUrl(github.commit.html_url, registry).reference, github.commit.sha);
  assert.equal(parseEvidenceUrl('https://github.com/example/council/pull/31', registry).kind, 'pull');
  assert.equal(parseEvidenceUrl(`https://github.com/example/council/commit/${'a'.repeat(40)}`, registry).kind, 'commit');
  for (const value of ['https://github.com/example/council/pull/01','https://github.com/example/council/pull/31/', 'https://github.com/example/council/pull/31?x=1', 'https://github.com:443/example/council/pull/31', 'https://github.com/example/council/commit/abc', 'https://github.com/example%2fcouncil/pull/31', 'https://github.com/other/council/pull/31']) assert.throws(() => parseEvidenceUrl(value, registry), {code:'evidence_unverified'});
  assert.throws(() => parseEvidenceUrl('https://github.com/example/council/pull/31', {...registry, public:false}), {code:'evidence_unverified'});
});

test('fixture gate cannot enable an installed publisher', () => {
  const gates = { operatorBoundary:true, principal:true, credentialBoundary:true, durableFence:true, providerRole:true };
  assert.deepEqual(assessFixtureAdmission(gates), { fixtureEligible:true, missing:[], publisherAvailable:false });
  assert.deepEqual(assessFixtureAdmission({...gates, durableFence:false}), { fixtureEligible:false, missing:['durableFence'], publisherAvailable:false });
  assert.throws(() => assessFixtureAdmission({...gates, trusted:true}), {code:'invalid_input'});
});

test('confirmation rechecks target, time, local item and scope before writing', async t => {
  const { make, privateRoot } = await setup(t);
  let clock = 1000;
  let changed = false;
  let exists = true;
  const transport = fixtureTransport(profile, (route, response) => {
    if (changed && route.endsWith(`/work-items/${issueIds[0]}/`)) response.body.is_draft = true;
  });
  const operator = make(undefined, { transport, now: () => clock, itemExists: () => exists });
  const candidate = await operator.resolve('wi-shared', 'COU-12');
  changed = true;
  await assert.rejects(operator.confirm('wi-shared', candidate.candidateId, candidate.localRef), {code:'scope_conflict'});
  changed = false;
  exists = false;
  await assert.rejects(operator.confirm('wi-shared', candidate.candidateId, candidate.localRef), {code:'scope_conflict'});
  exists = true;
  clock = 301001;
  await assert.rejects(operator.confirm('wi-shared', candidate.candidateId, candidate.localRef), {code:'scope_conflict'});
  clock = 999;
  await assert.rejects(operator.confirm('wi-shared', candidate.candidateId, candidate.localRef), {code:'scope_conflict'});
  assert.deepEqual(readdirSync(privateRoot), []);
});

test('numeric v1 membership is required at confirmation before any link write', async t => {
  for (const membership of [false, undefined]) {
    const { make, privateRoot } = await setup(t);
    let changed = false;
    const transport = fixtureTransport(profile, (route, response) => {
      if (changed && route.endsWith(`/projects/${profile.projectId}/`)) {
        if (membership === undefined) delete response.body.is_member;
        else response.body.is_member = membership;
      }
    });
    const operator = make(undefined, { transport });
    const candidate = await operator.resolve('wi-shared', 'COU-12');
    changed = true;
    await assert.rejects(operator.confirm('wi-shared', candidate.candidateId, candidate.localRef), {code:'scope_conflict'});
    assert.deepEqual(readdirSync(privateRoot), []);
    assert.equal(transport.posts, 0);
  }
  const { make, privateRoot } = await setup(t);
  const operator = make();
  const candidate = await operator.resolve('wi-shared', 'COU-12');
  assert.equal((await operator.confirm('wi-shared', candidate.candidateId, candidate.localRef)).itemId, issueIds[0]);
  assert.equal(readdirSync(privateRoot).length, 1);
});

test('expiry and clock rollback during provider reads never publish a link', async t => {
  for (const afterGet of [301000, 301001, 1500]) {
    const { make, privateRoot } = await setup(t);
    let clock = 1000;
    let verifying = false;
    const transport = fixtureTransport(profile, (route) => {
      if (verifying && route.endsWith(`/work-items/${issueIds[0]}/`)) clock = afterGet;
    });
    const operator = make(undefined, { transport, now: () => clock });
    const candidate = await operator.resolve('wi-shared', 'COU-12');
    verifying = true; clock = 2000;
    await assert.rejects(operator.confirm('wi-shared', candidate.candidateId, candidate.localRef), {code:'scope_conflict'});
    assert.deepEqual(readdirSync(privateRoot), []);
    assert.equal(transport.posts, 0);
  }
  const { make, privateRoot } = await setup(t);
  let clock = 1000;
  const operator = make(undefined, { now: () => clock });
  const candidate = await operator.resolve('wi-shared', 'COU-12');
  clock = 301000;
  await assert.rejects(operator.confirm('wi-shared', candidate.candidateId, candidate.localRef), {code:'scope_conflict'});
  assert.deepEqual(readdirSync(privateRoot), []);
  clock = 300999;
  assert.equal((await operator.confirm('wi-shared', candidate.candidateId, candidate.localRef)).itemId, issueIds[0]);
});

test('expiry after staging removes the temporary file without publishing', async t => {
  const { make, privateRoot } = await setup(t);
  const times = [1000, 2000, 2000, 2000, 301000];
  const operator = make(undefined, { now: () => times.shift() });
  const candidate = await operator.resolve('wi-shared', 'COU-12');
  await assert.rejects(operator.confirm('wi-shared', candidate.candidateId, candidate.localRef), {code:'scope_conflict'});
  assert.deepEqual(readdirSync(privateRoot), []);
});

test('installation identity separates otherwise identical local scopes', async t => {
  const { project, make, privateRoot } = await setup(t);
  const first = make(project);
  const second = make(project, { installationId:'1b6eba33-7959-4d8b-9387-576ac77ea410' });
  for (const action of ['plane_show', 'plane_open']) {
    assert.equal((await workItemOperation(action, {id:'wi-shared'}, {project, planeFixture:first})).installationId, installationId);
    assert.equal((await workItemOperation(action, {id:'wi-shared'}, {project, planeFixture:second})).installationId, '1b6eba33-7959-4d8b-9387-576ac77ea410');
  }
  const c = await first.resolve('wi-shared', 'COU-12');
  await first.confirm('wi-shared', c.candidateId, c.localRef);
  assert.equal(second.inspect('wi-shared').link, null);
  assert.notEqual(first.localRef('wi-shared'), second.localRef('wi-shared'));
  await assert.rejects(second.confirm('wi-shared', c.candidateId, c.localRef), {code:'scope_conflict'});
  assert.equal(readdirSync(privateRoot).length, 1);
});

test('missing, malformed or unverified reader identity cannot expose a projection or handoff', async t => {
  const { project, privateRoot } = await setup(t);
  for (const identity of [null, undefined, 'unattested', 42, 'C0A965AE-F134-4DED-8A66-AB60C366695F', () => { throw Error('unverified'); }]) {
    const fixture = { owns: () => true, readerIdentity: () => typeof identity === 'function' ? identity() : identity,
      inspect: () => { throw Error('must not inspect'); } };
    const show = await workItemOperation('plane_show', {id:'wi-shared'}, {project, planeFixture:fixture});
    const open = await workItemOperation('plane_open', {id:'wi-shared'}, {project, planeFixture:fixture});
    assert.equal(show.installationId, null); assert.equal(open.installationId, null);
    assert.deepEqual(show.plane, {availability:'disabled', freshness:'unavailable', link:null, operation:null});
    assert.deepEqual(open.planeHandoff, {disposition:'unavailable', localRef:null, operationId:null});
  }
  assert.deepEqual(readdirSync(privateRoot), []);
});

test('another item cannot consume the candidate or a damaged link', async t => {
  const { project, make, privateRoot } = await setup(t);
  assert.equal((await workItemOperation('create', {id:'wi-other',title:'Other',roleId:'dev',criteria:['Done']}, {project})).success, true);
  const operator = make();
  const c = await operator.resolve('wi-shared', 'COU-12');
  await assert.rejects(operator.confirm('wi-other', c.candidateId, c.localRef), {code:'scope_conflict'});
  await operator.confirm('wi-shared', c.candidateId, c.localRef);
  assert.equal(operator.inspect('wi-other').link, null);
  const path = join(privateRoot, readdirSync(privateRoot)[0]);
  const record = JSON.parse(readFileSync(path)); record.link.projectId = issueIds[1]; writeFileSync(path, JSON.stringify(record));
  assert.throws(() => operator.inspect('wi-shared'), {code:'integrity_error'});
  const result = await workItemOperation('plane_show', {id:'wi-shared'}, {project, planeFixture:operator});
  assert.equal(result.error.code, 'integrity_error');
  assert.ok(!JSON.stringify(result.error).includes(privateRoot));
});

test('installed engine without Plane credentials remains disabled', async t => {
  const { root, project } = await setup(t);
  const appHome = join(root, 'isolated-app');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/plane/i.test(key)));
  const install = spawnSync(process.execPath, [resolve('herdr/install.js'), '--app-home', appHome], {encoding:'utf8', env});
  assert.equal(install.status, 0, install.stderr);
  const engine = join(appHome, 'mods/council/engine');
  assert.ok(readFileSync(join(engine, 'herdr/mods/council/runtime/plane-fixture.mjs')).length > 0);
  const child = spawnSync(process.execPath, [join(engine,'bin/council.js'), 'work-item', 'plane', 'show', '--id', 'wi-shared', '--project', project], {encoding:'utf8', env});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).installationId, null);
  assert.deepEqual(JSON.parse(child.stdout).plane, { availability:'disabled', freshness:'unavailable', link:null, operation:null });
  const handoff = spawnSync(process.execPath, [join(engine,'bin/council.js'), 'work-item', 'plane', 'open', '--id', 'wi-shared', '--project', project], {encoding:'utf8', env});
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.equal(JSON.parse(handoff.stdout).installationId, null);
  assert.deepEqual(JSON.parse(handoff.stdout).planeHandoff, {disposition:'unavailable', localRef:null, operationId:null});
});

test('separate processes converge on same target and reject a different target', async t => {
  const { project, privateRoot } = await setup(t);
  async function race(refs) {
    const children = refs.map(ref => fork(resolve('tests/fixtures/plane-g1-child.mjs'), [project, privateRoot, ref], {stdio:['ignore','ignore','ignore','ipc']}));
    const results = children.map(child => new Promise((resolveResult, reject) => {
      let ready = false;
      child.on('message', m => { if (m.ready) { ready = true; if (children.every(c => c.readyToConfirm)) children.forEach(c => c.send('go')); } else resolveResult(m); });
      child.on('message', m => { if (m.ready) { child.readyToConfirm = true; if (children.every(c => c.readyToConfirm)) children.forEach(c => c.send('go')); } });
      child.on('error', reject); child.on('exit', code => { if (code && !ready) reject(Error(`child exited ${code}`)); });
    }));
    return Promise.all(results);
  }
  const same = await race(['COU-12','COU-12']);
  assert.deepEqual(same[0].link, same[1].link);
  assert.ok(same.every(result => result.installationId === installationId));
  const different = await race(['COU-12','COU-13']);
  assert.equal(different.filter(x => x.error === 'scope_conflict').length, 1);
  assert.equal(different.filter(x => x.link?.itemId === issueIds[0]).length, 1);
  assert.equal(readdirSync(privateRoot).length, 1);
});
