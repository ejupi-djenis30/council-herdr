import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createFixturePlane } from '../herdr/mods/council/runtime/plane-transport-fixture.mjs';
import { createFixturePublisher, createFixturePublicationReader } from '../herdr/mods/council/runtime/plane-publication-fixture.mjs';
import { createFixtureOperator } from '../herdr/mods/council/runtime/plane-fixture.mjs';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { workItemOperation } from '../lib/work-items.js';
import { installationId, profile, issueIds, github, fixtureTransport } from './fixtures/plane-g1.mjs';
import { githubFixture } from './fixtures/plane-github-fixture.mjs';

const operatorId = '159be116-5033-4af6-aabf-3552ddc024e1';
const target = { instanceId:profile.instanceId, origin:profile.origin, workspaceSlug:profile.workspaceSlug,
  workspaceId:profile.workspaceId, projectKey:profile.projectKey, projectId:profile.projectId,
  itemId:issueIds[0], sequence:12, authorId:profile.principalId };
const snapshot = (n = 1) => ({operationId:n.toString(16).padStart(32,'0'),itemRevision:4,linkRevision:1,status:'in_review',
  evidenceUrl:github.pull.html_url,createdAt:1000,expiresAt:301000});
async function prepare(publisher, draft) {
  const result=await publisher.prepareEvidence(draft.evidenceUrl);
  if (result.preview) {
    for (const key of ['operationId','itemRevision','linkRevision','status','evidenceUrl','createdAt','expiresAt']) draft[key]=result.preview[key];
  }
  return result.operation;
}
function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(),'council-plane-g2-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const project = join(root,'project'), privateRoot = join(root,'private');
  mkdirSync(project); mkdirSync(privateRoot);
  const clock = { now:2000 };
  const current = {installationId,itemId:'wi-shared',itemRevision:4,linkRevision:1,status:'in_review',target,integrity:false};
  const plane = createFixturePlane(target);
  const githubState = githubFixture();
  const args = {privateRoot,project,installationId,itemId:'wi-shared',target,registry:github.registry,plane,github:githubState.verifier,operatorId,
    readCurrent:()=>current,acknowledgeDirectory:()=>true,now:()=>clock.now,...options};
  const create = overrides => createFixturePublisher({...args,...overrides});
  const publisher = create();
  const approve = s => ({operatorId,approved:true,payloadDigest:publisher.payloadDigest(s)});
  return {root, project, privateRoot, clock, current, plane, githubState, publisher, create, approve};
}

test('fixture Start posts once and validates exact readback', async t => {
  const {publisher,plane,approve} = setup(t);
  const s = snapshot();
  const planningBefore=plane.snapshot().planningFields;
  assert.equal((await prepare(publisher,s)).state, 'prepared');
  const result = await publisher.confirm(s.operationId,approve(s));
  assert.equal(result.state,'published');
  assert.equal(result.receipt.source,'response');
  assert.equal((await publisher.confirm(s.operationId,approve(s))).state,'published');
  const trace=plane.snapshot();
  assert.equal(trace.posts,1); assert.equal(trace.comments.length,1); assert.equal(trace.planningWrites,0);
  assert.deepEqual(trace.planningFields,planningBefore);
  assert.deepEqual(JSON.parse(trace.calls.find(c=>c.method==='POST').bytes), {access:'INTERNAL',comment_html:`<p>Council status: in_review</p><p>Evidence: ${s.evidenceUrl}</p><p>Council publication: ${s.operationId}</p>`});
});

test('injected scoped reader exposes original operation without provider calls', async t => {
  const {publisher,plane,approve,project,privateRoot}=setup(t);
  new TeamStore(project).set({id:'dev',agent:'codex',role:'Dev'});
  assert.equal((await workItemOperation('create',{id:'wi-shared',title:'Fixture',roleId:'dev',criteria:['done']},{project})).success,true);
  const links=createFixtureOperator({project,privateRoot,installationId,profile,transport:fixtureTransport(),itemExists:()=>true});
  const candidate=await links.resolve('wi-shared','COU-12'); await links.confirm('wi-shared',candidate.candidateId,candidate.localRef);
  const reader=createFixturePublicationReader({links,publisher});
  const s=snapshot(); await prepare(publisher,s); await publisher.confirm(s.operationId,approve(s));
  const count=plane.snapshot().calls.length;
  const show=await workItemOperation('plane_show',{id:'wi-shared',operationId:s.operationId},{project,planeFixture:reader});
  assert.equal(show.installationId,installationId); assert.equal(show.plane.operation.state,'published');
  const open=await workItemOperation('plane_open',{id:'wi-shared',operationId:s.operationId},{project,planeFixture:reader});
  assert.equal(open.installationId,installationId); assert.equal(open.planeHandoff.operationId,s.operationId);
  assert.equal(open.planeHandoff.disposition,'unavailable');
  assert.equal((await workItemOperation('plane_show',{id:'wi-shared',operationId:'f'.repeat(32)},{project,planeFixture:reader})).error.code,'not_found');
  assert.equal(plane.snapshot().calls.length,count);
});

const vectors = JSON.parse(readFileSync(new URL('../specs/004-plane-evidence-publication/contracts/examples.json', import.meta.url))).repetitions.slice(0,10);
for (let i = 0; i < vectors.length; i++) {
  test(`canonical repetition ${i + 1}: ${vectors[i].situation}`, async t => {
    let stop = null;
    const {publisher,plane,approve,create,current,project,privateRoot} = setup(t, {hook:(point,type) => { if (stop === `${point}:${type}`) throw Error('fixture interruption'); }});
    const planningBefore=plane.snapshot().planningFields;
    const s = snapshot(i + 1);
    const linkOperator = createFixtureOperator({ project,privateRoot,installationId,profile,transport:fixtureTransport(),itemExists:()=>true });
    const candidate = await linkOperator.resolve('wi-shared','COU-12');
    if (i === 8) {
      const other = await linkOperator.resolve('wi-shared','COU-12');
      const links = await Promise.all([linkOperator.confirm('wi-shared',candidate.candidateId,candidate.localRef),linkOperator.confirm('wi-shared',other.candidateId,other.localRef)]);
      assert.deepEqual(links[0],links[1]);
    } else await linkOperator.confirm('wi-shared',candidate.candidateId,candidate.localRef);
    await prepare(publisher,s);
    let result;
    if (i === 1) plane.setMode('commit_drop');
    if (i === 2) plane.setMode('drop_without_commit');
    if (i === 3 || i === 4) plane.setMode('offline');
    if (i === 5) stop = 'after_approval:approval';
    if (i === 6) stop = 'after_start:start';
    if (i === 7) stop = 'after_link:receipt';
    if (i === 9) current.itemRevision = 5;
    if (i === 8) {
      await Promise.all([publisher.confirm(s.operationId,approve(s)),publisher.confirm(s.operationId,approve(s))]);
      result = publisher.inspect(s.operationId);
    } else if (i === 9) {
      try { result = await publisher.confirm(s.operationId,approve(s)); } catch (e) { result = {state:'conflict', reason:e.code}; }
    } else {
      result = await publisher.confirm(s.operationId,approve(s));
    }
    const restarted = create();
    if ([1,2].includes(i)) result = await restarted.reconcile(s.operationId);
    if (i === 2) { await restarted.confirm(s.operationId,approve(s)); result = await restarted.reconcile(s.operationId); }
    if (i === 3) { plane.setMode('normal'); result = await restarted.confirm(s.operationId,approve(s)); }
    if (i === 4) result = await restarted.reconcile(s.operationId);
    if (i === 5 || i === 6) { stop = null; result = await restarted.reconcile(s.operationId); }
    if (i === 6) await restarted.confirm(s.operationId,approve(s));
    if (i === 7 || i === 8) result = await restarted.confirm(s.operationId,approve(s));
    if (i === 9) assert.equal((await restarted.inspect(s.operationId)).state,'conflict');
    const trace = plane.snapshot(), expected = vectors[i].expected;
    assert.equal(trace.posts,expected.postAttempts);
    assert.equal(trace.comments.length,expected.comments);
    assert.equal(trace.planningWrites,expected.planningFieldWrites);
    assert.deepEqual(trace.planningFields,planningBefore);
    assert.equal(readdirSync(privateRoot).filter(name => name.endsWith('.json')).length,expected.links);
    assert.equal(result.state,expected.state);
    if (expected.readSource) assert.equal(result.receipt.source,expected.readSource);
  });
}

test('fixture consent and pins fail closed without any send', async t => {
  const {publisher,plane,approve,current,create} = setup(t);
  const s=snapshot(); await prepare(publisher,s);
  for (const input of [{...approve(s),approved:false}, {...approve(s),operatorId:randomUUID()},
    {...approve(s),payloadDigest:'0'.repeat(64)}, {...approve(s),unexpected:true}]) {
    await assert.rejects(publisher.confirm(s.operationId,input));
  }
  current.itemRevision++;
  assert.equal((await publisher.confirm(s.operationId,approve(s))).state,'conflict');
  assert.equal(create().inspect(s.operationId).state,'conflict');
  assert.equal(plane.snapshot().posts,0);
});

test('changed installation, item, link, status, target or provider permission denies Start', async t => {
  const mutations=[
    c=>{c.installationId=randomUUID();}, c=>{c.itemId='wi-other';}, c=>{c.linkRevision=2;},
    c=>{c.status='closed';}, c=>{c.target={...c.target,authorId:randomUUID()};}
  ];
  for (const mutate of mutations) {
    const {publisher,plane,approve,current}=setup(t);
    const s=snapshot(); await prepare(publisher,s); mutate(current);
    assert.equal((await publisher.confirm(s.operationId,approve(s))).state,'conflict');
    assert.equal(plane.snapshot().posts,0);
  }
  const {publisher,plane,approve}=setup(t);
  const s=snapshot(); await prepare(publisher,s); plane.setMode('unauthorized');
  const result=await publisher.confirm(s.operationId,approve(s));
  assert.equal(result.state,'conflict'); assert.equal(result.reason,'authorization_denied');
  assert.equal(plane.snapshot().posts,0);
});

test('expired preview stays retired after clock rollback; supersession is explicit', async t => {
  const {publisher,plane,approve,clock,create}=setup(t);
  const s=snapshot(); await prepare(publisher,s); clock.now=s.expiresAt;
  assert.equal((await publisher.confirm(s.operationId,approve(s))).state,'expired');
  clock.now=s.expiresAt-1;
  assert.equal(create().inspect(s.operationId).state,'expired');
  await assert.rejects(create().confirm(s.operationId,approve(s)));
  assert.equal(plane.snapshot().posts,0);
  const newer={...snapshot(2),createdAt:clock.now,expiresAt:clock.now+300000};
  assert.equal((await prepare(publisher,newer)).operationId,s.operationId);
  clock.now=s.expiresAt;
  publisher.supersede(s.operationId);
  assert.equal((await prepare(publisher,newer)).state,'prepared');
});

test('expiry and stale scope after approval never reach Start', async t => {
  for (const mode of ['expire','revision','offline']) {
    let mutate=()=>{};
    const {publisher,plane,approve,clock,current,create}=setup(t,{hook:(point)=>{if(point==='after_approval') mutate();}});
    const s=snapshot(); await prepare(publisher,s);
    mutate=()=>{if(mode==='expire') clock.now=s.expiresAt; if(mode==='revision') current.itemRevision++; if(mode==='offline') plane.setMode('offline');};
    const result=await publisher.confirm(s.operationId,approve(s));
    assert.equal(result.state,mode==='expire'?'expired':mode==='revision'?'conflict':'offline');
    assert.equal(plane.snapshot().posts,0);
    if (mode==='expire') {
      clock.now=s.expiresAt-1;
      assert.equal(create().inspect(s.operationId).state,'expired');
      await assert.rejects(create().confirm(s.operationId,approve(s)));
    }
  }
});

test('cancelled or conflicting previews require explicit supersession', async t => {
  const {publisher,plane,approve}=setup(t);
  const s=snapshot(); await prepare(publisher,s);
  assert.equal(publisher.cancel(s.operationId).state,'cancelled');
  await assert.rejects(publisher.confirm(s.operationId,approve(s)));
  assert.equal((await prepare(publisher,snapshot(2))).operationId,s.operationId);
  publisher.supersede(s.operationId);
  assert.equal((await prepare(publisher,snapshot(2))).state,'prepared');
  assert.equal(plane.snapshot().posts,0);
});

test('unverified preview fields and non-fixture transport are rejected', async t => {
  const {publisher,create,plane,project}=setup(t);
  for (const bad of [{...snapshot(),evidenceUrl:'https://github.com/example/council/pull/01'},
    {...snapshot(),status:'arbitrary'}, {...snapshot(),createdAt:1000,expiresAt:301001},
    {...snapshot(),prompt:'private-canary'}, {...snapshot(),itemRevision:0}]) assert.throws(()=>publisher.payloadDigest(bad));
  assert.equal(publisher.prepare,undefined);
  await assert.rejects(publisher.prepareEvidence({evidenceUrl:github.pull.html_url}),{code:'invalid_input'});
  assert.throws(()=>create({plane:{verify(){},post(){}}}),{code:'invalid_input'});
  assert.throws(()=>create({privateRoot:project}),{code:'scope_conflict'});
  assert.equal(plane.snapshot().posts,0);
});

test('pinned route and payload exclude private source, scope and canaries', async t => {
  const {publisher,plane,approve,root}=setup(t);
  const s=snapshot(); await prepare(publisher,s); await publisher.confirm(s.operationId,approve(s));
  const trace=plane.snapshot(), post=trace.calls.find(c=>c.method==='POST');
  assert.equal(post.route,`/api/v1/workspaces/${target.workspaceSlug}/projects/${target.projectId}/work-items/${target.itemId}/comments/`);
  assert.deepEqual(Object.keys(JSON.parse(post.bytes)),['access','comment_html']);
  for (const forbidden of [root,'wi-shared',installationId,target.authorId,'private-canary']) assert.ok(!post.bytes.includes(forbidden));
  assert.equal(trace.posts,1); assert.equal(trace.planningWrites,0);
});

test('approved payload bytes remain frozen if the caller later mutates its snapshot', async t => {
  const {publisher,plane}=setup(t);
  const s=snapshot(); await prepare(publisher,s);
  const originalDigest=publisher.payloadDigest(s);
  s.status='closed'; s.evidenceUrl='https://github.com/example/council/pull/99';
  const result=await publisher.confirm(s.operationId,{operatorId,approved:true,payloadDigest:originalDigest});
  assert.equal(result.state,'published');
  const bytes=plane.snapshot().calls.find(call=>call.method==='POST').bytes;
  assert.ok(bytes.includes('Council status: in_review'));
  assert.ok(bytes.includes(github.pull.html_url));
  assert.ok(!bytes.includes('/pull/99'));
});

test('changed installation or target cannot recover another scope', async t => {
  const {publisher,plane,approve,create}=setup(t);
  const s=snapshot(); await prepare(publisher,s); plane.setMode('commit_drop');
  await publisher.confirm(s.operationId,approve(s));
  const replacement=create({installationId:randomUUID()});
  assert.throws(()=>replacement.inspect(s.operationId),{code:'not_found'});
  const changed={...target,authorId:randomUUID()}, otherPlane=createFixturePlane(changed);
  const wrong=create({target:changed,plane:otherPlane});
  assert.throws(()=>wrong.inspect(s.operationId),{code:'integrity_error'});
  assert.equal(otherPlane.snapshot().posts,0);
  assert.equal(plane.snapshot().posts,1);
});

test('Start storage faults never grant a send, including lost acknowledgement', async t => {
  for (const point of ['before_link:start','after_link:start','before_ack:start','after_ack:start']) {
    let active = true;
    const options = {
      hook:(stage,type) => { if (active && `${stage}:${type}` === point) throw Error('fault'); },
      acknowledgeDirectory:(stage,type) => !(active && `${stage}_ack:${type}` === point)
    };
    const {publisher,plane,approve,create} = setup(t,options);
    const s=snapshot(); await prepare(publisher,s);
    const result = await publisher.confirm(s.operationId,approve(s));
    assert.equal(plane.snapshot().posts,0,point);
    if (point === 'after_link:start' || point === 'after_ack:start') {
      assert.equal(result.state,'delivery_uncertain',point);
      active = false;
      const restarted=create();
      assert.equal((await restarted.confirm(s.operationId,approve(s))).state,'delivery_uncertain');
      assert.equal((await restarted.reconcile(s.operationId)).state,'delivery_uncertain');
      assert.equal(plane.snapshot().posts,0);
    } else assert.equal(result.state,'approved_unsent',point);
  }
});

test('Start commit boundary rejects expiry, scope changes and clock rollback', async t => {
  for (const change of ['expiry','revision','rollback','installation','link','status','target']) {
    let mutate = () => {};
    const {publisher,plane,approve,clock,current,privateRoot}=setup(t,{
      hook:(point,type)=>{ if (point === 'before_link' && type === 'start') mutate(); }
    });
    const s=snapshot(); await prepare(publisher,s);
    mutate=()=>{
      if (change === 'expiry') clock.now=s.expiresAt;
      if (change === 'revision') current.itemRevision++;
      if (change === 'rollback') clock.now=1999;
      if (change === 'installation') current.installationId=randomUUID();
      if (change === 'link') current.linkRevision++;
      if (change === 'status') current.status='closed';
      if (change === 'target') current.target={...target,authorId:randomUUID()};
    };
    const result=await publisher.confirm(s.operationId,approve(s));
    assert.equal(result.state,change === 'expiry' ? 'expired' : 'conflict',change);
    assert.equal(result.reason,['expiry','rollback'].includes(change) ? 'stale_preview' : 'scope_conflict',change);
    const dir=join(privateRoot,readdirSync(privateRoot).find(name=>/^[a-f0-9]{64}$/.test(name)));
    const events=readdirSync(dir).filter(name=>/^\d{8}\.json$/.test(name)).map(name=>JSON.parse(readFileSync(join(dir,name))));
    assert.equal(events.filter(event=>event.type === 'start').length,0,change);
    assert.equal(readdirSync(dir).some(name=>name.endsWith('.tmp')),false,change);
    assert.equal(plane.snapshot().posts,0,change);
  }
});

test('Start commit rechecks time after the synchronous scope reader returns', async t => {
  let atBoundary=false;
  let expiry;
  const context=setup(t,{
    hook:(point,type)=>{ if (point === 'before_link' && type === 'start') atBoundary=true; },
    readCurrent:()=>{ if (atBoundary) context.clock.now=expiry; return context.current; }
  });
  const s=snapshot(); await prepare(context.publisher,s);
  expiry=s.expiresAt;
  const result=await context.publisher.confirm(s.operationId,context.approve(s));
  assert.equal(result.state,'expired'); assert.equal(result.reason,'stale_preview');
  assert.equal(context.plane.snapshot().posts,0);
  const dir=join(context.privateRoot,readdirSync(context.privateRoot).find(name=>/^[a-f0-9]{64}$/.test(name)));
  assert.equal(readdirSync(dir).filter(name=>/^\d{8}\.json$/.test(name)).map(name=>JSON.parse(readFileSync(join(dir,name)))).some(event=>event.type==='start'),false);
});

test('intent, approval, post and receipt interruptions keep truthful restart state', async t => {
  for (const point of ['before_link:intent','after_link:intent','before_link:approval','after_link:approval','after_post:start','before_link:receipt']) {
    let active=true;
    const {publisher,plane,approve,create}=setup(t,{hook:(stage,type)=>{if(active && `${stage}:${type}`===point) throw Error('fixture interruption');}});
    const s=snapshot();
    if (point.endsWith(':intent')) {
      await assert.rejects(prepare(publisher,s));
      active=false;
      if (point.startsWith('before')) assert.throws(()=>create().inspect(s.operationId),{code:'not_found'});
      else assert.equal(create().latest().state,'prepared');
      assert.equal(plane.snapshot().posts,0);
      continue;
    }
    await prepare(publisher,s);
    const result=await publisher.confirm(s.operationId,approve(s));
    const expected=point==='before_link:approval'?'prepared':point==='after_link:approval'?'approved_unsent':'delivery_uncertain';
    assert.equal(result.state,expected,point);
    assert.equal(plane.snapshot().posts,point.includes('post') || point.includes('receipt') ? 1 : 0,point);
    active=false;
    const restarted=create();
    if (expected==='delivery_uncertain') {
      assert.equal((await restarted.reconcile(s.operationId)).state,'published');
      assert.equal(plane.snapshot().posts,1);
    } else assert.equal(restarted.inspect(s.operationId).state,expected);
  }
});

test('unverifiable storage blocks writes and a receipt is not exposed without read acknowledgement', async t => {
  {
    const plane=createFixturePlane(target);
    assert.throws(()=>setup(t,{plane,acknowledgeDirectory:()=>false}),{code:'storage_error'});
    assert.equal(plane.snapshot().posts,0);
  }
  {
    let broken=false;
    const {publisher,plane,approve,create}=setup(t,{
      hook:(point,type)=>{if(point==='after_link' && type==='receipt') broken=true;},
      acknowledgeDirectory:(stage,type)=>!(broken && (stage==='read' || (stage==='after' && type==='receipt')))
    });
    const s=snapshot(); await prepare(publisher,s);
    await assert.rejects(publisher.confirm(s.operationId,approve(s)),{code:'storage_error'});
    assert.equal(plane.snapshot().posts,1);
    assert.throws(()=>publisher.inspect(s.operationId),{code:'storage_error'});
    broken=false;
    assert.equal(create().inspect(s.operationId).state,'published');
    assert.equal((await create().confirm(s.operationId,approve(s))).state,'published');
    assert.equal(plane.snapshot().posts,1);
  }
});

test('storage diagnostics never expose fixture paths or raw errors', async t => {
  const {publisher,root,plane}=setup(t,{hook:()=>{throw Error('sensitive-directory-canary');}});
  await assert.rejects(prepare(publisher,snapshot()),error=>{
    assert.equal(error.code,'storage_error');
    assert.ok(!error.message.includes(root));
    assert.ok(!error.message.includes('sensitive-directory-canary'));
    return true;
  });
  assert.equal(plane.snapshot().posts,0);
});

test('uncertain Start remains the item barrier across restart and changed snapshot', async t => {
  const {publisher,plane,approve,create,current} = setup(t);
  const s=snapshot(); await prepare(publisher,s); plane.setMode('drop_without_commit');
  assert.equal((await publisher.confirm(s.operationId,approve(s))).state,'delivery_uncertain');
  const restarted=create(); current.itemRevision=5;
  const newer={...snapshot(2),itemRevision:5};
  assert.equal((await prepare(restarted,newer)).operationId,s.operationId);
  assert.throws(()=>restarted.supersede(s.operationId),{code:'scope_conflict'});
  assert.equal((await restarted.reconcile(s.operationId)).state,'delivery_uncertain');
  assert.equal((await restarted.confirm(s.operationId,approve(s))).state,'delivery_uncertain');
  assert.equal(plane.snapshot().posts,1);
});

test('an earlier receipt remains inspectable while a newer revision is uncertain', async t => {
  const {publisher,plane,approve,create,current}=setup(t);
  const first=snapshot(); await prepare(publisher,first);
  assert.equal((await publisher.confirm(first.operationId,approve(first))).state,'published');
  current.itemRevision=5;
  const second={...snapshot(2),itemRevision:5}; await prepare(publisher,second); plane.setMode('commit_drop');
  assert.equal((await publisher.confirm(second.operationId,approve(second))).state,'delivery_uncertain');
  const reopened=create();
  assert.equal(reopened.latest().operationId,second.operationId);
  assert.equal(reopened.inspect(first.operationId).state,'published');
  assert.equal(reopened.inspect(first.operationId).itemRevision,4);
  plane.setMode('normal');
  assert.equal((await reopened.reconcile(second.operationId)).state,'published');
  assert.equal(reopened.inspect(first.operationId).state,'published');
  assert.equal(plane.snapshot().posts,2);
});

test('malformed acknowledgement and detail failure stay uncertain until positive readback', async t => {
  for (const mode of ['malformed_response','detail_error']) {
    const {publisher,plane,approve,create} = setup(t);
    const s=snapshot(); await prepare(publisher,s); plane.setMode(mode);
    assert.equal((await publisher.confirm(s.operationId,approve(s))).state,'delivery_uncertain');
    plane.setMode('normal');
    const result=await create().reconcile(s.operationId);
    assert.equal(result.state,'published'); assert.equal(result.receipt.source,'reconciliation');
    assert.equal(plane.snapshot().posts,1);
  }
});

test('reconciliation requires exact scope, author, creator, audience and content', async t => {
  const mutations = [
    c=>{c.workspace=randomUUID();}, c=>{c.project=randomUUID();}, c=>{c.issue=randomUUID();},
    c=>{c.actor=randomUUID();}, c=>{c.created_by=randomUUID();}, c=>{c.access='EXTERNAL';},
    c=>{c.parent=randomUUID();}, c=>{c.deleted_at='2026-01-01';}, c=>{c.edited_at='2026-01-01';},
    c=>{c.attachments=[{id:randomUUID()}];}, c=>{c.comment_html+=' ';}, c=>{c.id='invalid';}
  ];
  for (const mutate of mutations) {
    const {publisher,plane,approve,create}=setup(t);
    const s=snapshot(); await prepare(publisher,s); plane.setMode('commit_drop');
    assert.equal((await publisher.confirm(s.operationId,approve(s))).state,'delivery_uncertain');
    const comment=plane.snapshot().comments[0]; mutate(comment); plane.replaceComments([comment]); plane.setMode('normal');
    assert.equal((await create().reconcile(s.operationId)).state,'delivery_uncertain');
    assert.equal(plane.snapshot().posts,1);
  }
});

test('reconciliation proves one hit on second page and rejects ambiguity or malformed pagination', async t => {
  const cases=['second_page','duplicate','repeat_row','loop','too_many_pages','oversize_cursor','malformed','malformed_other','wrong_scope_other','oversize_body','missing'];
  for (const scenario of cases) {
    const {publisher,plane,approve,create}=setup(t);
    const s=snapshot(); await prepare(publisher,s); plane.setMode('commit_drop');
    await publisher.confirm(s.operationId,approve(s)); plane.setMode('normal');
    const good=plane.snapshot().comments[0];
    if (scenario === 'second_page') { plane.replaceComments([{...good,id:randomUUID(),comment_html:'unrelated'},good]); plane.setPageSize(1); }
    if (scenario === 'duplicate') plane.replaceComments([good,{...good,id:randomUUID()}]);
    if (scenario === 'repeat_row') plane.replaceComments([good,good]);
    if (scenario === 'missing') plane.replaceComments([]);
    if (scenario === 'loop') plane.setPages([
      {results:[{...good,id:randomUUID(),comment_html:'unrelated'}],next_page_results:true,next_cursor:'1'},
      {results:[{...good,id:randomUUID(),comment_html:'unrelated'}],next_page_results:true,next_cursor:'1'}]);
    if (scenario === 'too_many_pages') plane.setPages(Array.from({length:11},(_,index)=>({
      results:[index===10 ? good : {...good,id:randomUUID(),comment_html:'unrelated'}],
      next_page_results:index<10,next_cursor:index<10?String(index+1):null
    })));
    if (scenario === 'oversize_cursor') plane.setPages([{results:[],next_page_results:true,next_cursor:'x'.repeat(1025)}]);
    if (scenario === 'malformed') plane.setPages([{results:'not-an-array',next_page_results:false,next_cursor:null}]);
    if (scenario === 'malformed_other') plane.replaceComments([good,{...good,id:randomUUID(),comment_html:null}]);
    if (scenario === 'wrong_scope_other') plane.replaceComments([good,{...good,id:randomUUID(),issue:randomUUID(),comment_html:'unrelated'}]);
    if (scenario === 'oversize_body') plane.replaceComments([good,{...good,id:randomUUID(),comment_html:'x'.repeat(1024*1024)}]);
    const result=await create().reconcile(s.operationId);
    assert.equal(result.state,scenario === 'second_page' ? 'published' : 'delivery_uncertain',scenario);
    assert.equal(plane.snapshot().posts,1);
  }
});

test('terminal v1 page accepts a cursor and metadata but never follows that cursor', async t => {
  for (const extra of [{}, {count:1,total_pages:1,prev_page_results:false,prev_cursor:'opaque-previous'}]) {
    const {publisher,plane,approve,create}=setup(t);
    const s=snapshot(); await prepare(publisher,s); plane.setMode('commit_drop');
    assert.equal((await publisher.confirm(s.operationId,approve(s))).state,'delivery_uncertain');
    const original=plane.snapshot().comments[0]; plane.setMode('normal');
    plane.setPages([{...extra,results:[original],next_page_results:false,next_cursor:'opaque-terminal'}]);
    const result=await create().reconcile(s.operationId);
    assert.equal(result.state,'published'); assert.equal(result.receipt.commentId,original.id);
    const calls=plane.snapshot().calls;
    assert.equal(calls.filter(call=>call.kind === 'page').length,1);
    assert.ok(calls.some(call=>call.kind === 'detail' && call.route.endsWith(`/${original.id}/`)));
    assert.equal(plane.snapshot().posts,1);
  }
});

test('concurrent GET-only reconciliation records the same unique receipt', async t => {
  const {publisher,plane,approve,create}=setup(t);
  const s=snapshot(); await prepare(publisher,s); plane.setMode('commit_drop');
  await publisher.confirm(s.operationId,approve(s)); plane.setMode('normal');
  const [a,b]=await Promise.all([create().reconcile(s.operationId),create().reconcile(s.operationId)]);
  assert.equal(a.state,'published'); assert.deepEqual(a.receipt,b.receipt);
  assert.equal(plane.snapshot().posts,1);
});

test('a later conflicting positive proof is recorded without replacing the original receipt', async t => {
  const {publisher,plane,approve,privateRoot,create}=setup(t);
  const s=snapshot(); await prepare(publisher,s);
  const original=await publisher.confirm(s.operationId,approve(s));
  const conflicting={...plane.snapshot().comments[0],id:randomUUID()};
  plane.replaceComments([conflicting]);
  const next=await create().reconcile(s.operationId);
  assert.equal(next.state,'published'); assert.deepEqual(next.receipt,original.receipt);
  const dir=join(privateRoot,readdirSync(privateRoot).find(name=>/^[a-f0-9]{64}$/.test(name)));
  const conflicts=()=>readdirSync(dir).filter(n=>/^\d{8}\.json$/.test(n)).map(n=>JSON.parse(readFileSync(join(dir,n)))).filter(e=>e.type==='receipt_conflict');
  assert.equal(conflicts().length,1); assert.equal(conflicts()[0].data.commentId,conflicting.id);
  await create().reconcile(s.operationId);
  assert.equal(conflicts().length,1);
  assert.equal(plane.snapshot().posts,1);
});

test('damaged journal is blocked and does not produce a new send', async t => {
  const {publisher,plane,approve,privateRoot,create}=setup(t);
  const s=snapshot(); await prepare(publisher,s); plane.setMode('drop_without_commit');
  await publisher.confirm(s.operationId,approve(s));
  const dir=join(privateRoot,readdirSync(privateRoot).find(name=>/^[a-f0-9]{64}$/.test(name)));
  const tail=readdirSync(dir).filter(n=>/^\d{8}\.json$/.test(n)).sort().at(-1);
  writeFileSync(join(dir,tail),Buffer.from([255]));
  const prefix=create().inspect(s.operationId);
  assert.equal(prefix.state,'delivery_uncertain'); assert.equal(prefix.reason,'integrity_error');
  await assert.rejects(create().confirm(s.operationId,approve(s)),{code:'integrity_error'});
  assert.equal(plane.snapshot().posts,1);
});

test('a corrupt later intent leaves the prior receipt visible with integrity error and blocks mutations', async t => {
  const {publisher,plane,approve,current,privateRoot,project,create}=setup(t);
  new TeamStore(project).set({id:'dev',agent:'codex',role:'Dev'});
  assert.equal((await workItemOperation('create',{id:'wi-shared',title:'Fixture',roleId:'dev',criteria:['done']},{project})).success,true);
  const links=createFixtureOperator({project,privateRoot,installationId,profile,transport:fixtureTransport(),itemExists:()=>true});
  const candidate=await links.resolve('wi-shared','COU-12'); await links.confirm('wi-shared',candidate.candidateId,candidate.localRef);
  const first=snapshot(); await prepare(publisher,first);
  const published=await publisher.confirm(first.operationId,approve(first));
  assert.equal(published.state,'published');
  current.itemRevision=5;
  const second={...snapshot(2),itemRevision:5}; await prepare(publisher,second);
  const dir=join(privateRoot,readdirSync(privateRoot).find(name=>/^[a-f0-9]{64}$/.test(name)));
  const receiptFile=readdirSync(dir).find(name=>/^\d{8}\.json$/.test(name) && JSON.parse(readFileSync(join(dir,name))).type === 'receipt');
  const originalReceiptBytes=readFileSync(join(dir,receiptFile));
  const tail=readdirSync(dir).filter(name=>/^\d{8}\.json$/.test(name)).sort().at(-1);
  writeFileSync(join(dir,tail),Buffer.from([255]));
  const files=()=>readdirSync(dir).sort().map(name=>[name,readFileSync(join(dir,name)).toString('hex')]);
  const before=files(), callsBefore=plane.snapshot().calls.length;
  const restarted=create();
  const prefix=restarted.inspect(first.operationId);
  assert.equal(prefix.state,'published'); assert.deepEqual(prefix.receipt,published.receipt); assert.equal(prefix.reason,'integrity_error');
  assert.deepEqual(Buffer.from(JSON.stringify(prefix.receipt)),Buffer.from(JSON.stringify(published.receipt)));
  assert.deepEqual(readFileSync(join(dir,receiptFile)),originalReceiptBytes);
  assert.equal(restarted.latest().operationId,first.operationId);
  assert.throws(()=>restarted.inspect(second.operationId),{code:'integrity_error'});
  const reader=createFixturePublicationReader({links,publisher:restarted});
  const show=await workItemOperation('plane_show',{id:'wi-shared',operationId:first.operationId},{project,planeFixture:reader});
  assert.equal(show.success,true); assert.equal(show.installationId,installationId);
  assert.equal(show.plane.availability,'read_only'); assert.equal(show.plane.freshness,'cached');
  assert.equal(show.plane.operation.reason,'integrity_error'); assert.deepEqual(show.plane.operation.receipt,published.receipt);
  const missing=await workItemOperation('plane_show',{id:'wi-shared',operationId:second.operationId},{project,planeFixture:reader});
  assert.equal(missing.success,false); assert.equal(missing.error.code,'integrity_error');
  await assert.rejects(prepare(restarted,{...snapshot(3),itemRevision:5}),{code:'integrity_error'});
  assert.throws(()=>restarted.cancel(first.operationId),{code:'integrity_error'});
  assert.throws(()=>restarted.supersede(first.operationId),{code:'integrity_error'});
  await assert.rejects(restarted.confirm(first.operationId,approve(first)),{code:'integrity_error'});
  await assert.rejects(restarted.reconcile(first.operationId),{code:'integrity_error'});
  assert.deepEqual(files(),before);
  assert.equal(plane.snapshot().calls.length,callsBefore); assert.equal(plane.snapshot().posts,1);
});

test('replacement of the bound journal directory fails closed on reopen', async t => {
  const {publisher,plane,approve,privateRoot,create}=setup(t);
  const s=snapshot(); await prepare(publisher,s); plane.setMode('drop_without_commit');
  await publisher.confirm(s.operationId,approve(s));
  const name=readdirSync(privateRoot).find(entry=>/^[a-f0-9]{64}$/.test(entry));
  const dir=join(privateRoot,name);
  renameSync(dir,`${dir}.previous`); mkdirSync(dir);
  assert.throws(()=>publisher.inspect(s.operationId),{code:'integrity_error'});
  assert.throws(()=>create(),{code:'integrity_error'});
  assert.equal(plane.snapshot().posts,1);
});

test('real process exit after Start leaves uncertainty and never replays', async t => {
  const {publisher,plane,approve,project,privateRoot,create}=setup(t);
  const s=snapshot(); await prepare(publisher,s);
  const child=spawnSync(process.execPath,[resolve('tests/fixtures/plane-g2-child.mjs'),project,privateRoot,'crash',JSON.stringify(s)],{encoding:'utf8'});
  assert.equal(child.status,73,child.stderr);
  const restarted=create();
  assert.equal(restarted.inspect(s.operationId).state,'delivery_uncertain');
  assert.equal((await restarted.confirm(s.operationId,approve(s))).state,'delivery_uncertain');
  assert.equal((await restarted.reconcile(s.operationId)).state,'delivery_uncertain');
  assert.equal(plane.snapshot().posts,0);
});

test('real processes compete for one Start and at most one sends', async t => {
  const {publisher,project,privateRoot}=setup(t);
  const s=snapshot(); await prepare(publisher,s);
  const children=Array.from({length:2},()=>fork(resolve('tests/fixtures/plane-g2-child.mjs'),[project,privateRoot,'race',JSON.stringify(s)],{stdio:['ignore','ignore','ignore','ipc']}));
  t.after(()=>{ for (const child of children) if (child.exitCode === null) child.kill(); });
  const results=children.map(child=>new Promise((resolveResult,reject)=>{
    let finished=false;
    child.on('message',message=>{
      if (message.ready) {
        child.fixtureReady=true;
        if (children.every(c=>c.fixtureReady)) children.forEach(c=>c.send('go'));
      } else { finished=true; resolveResult(message); }
    });
    child.on('error',reject);
    child.on('exit',code=>{ if (!finished) reject(Error(`fixture child exited ${code}`)); });
  }));
  const outcomes=await Promise.all(results);
  assert.equal(outcomes.reduce((sum,entry)=>sum+entry.posts,0),1);
  assert.equal(publisher.inspect(s.operationId).state,'published');
});
