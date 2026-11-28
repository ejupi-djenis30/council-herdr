import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createGitHubVerifier, createAnonymousGitHubTransport } from '../herdr/mods/council/runtime/plane-github.mjs';
import { createFixtureOperator } from '../herdr/mods/council/runtime/plane-fixture.mjs';
import { createFixturePlane } from '../herdr/mods/council/runtime/plane-transport-fixture.mjs';
import { createFixturePublisher } from '../herdr/mods/council/runtime/plane-publication-fixture.mjs';
import { WorkItemStore } from '../herdr/mods/council/runtime/work-item-store.mjs';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { workItemOperation } from '../lib/work-items.js';
import { createFixtureWorkItemReader } from '../lib/plane-evidence.js';
import { installationId, profile, issueIds, github, fixtureTransport } from './fixtures/plane-g1.mjs';
import { githubFixture } from './fixtures/plane-github-fixture.mjs';

const operatorId='159be116-5033-4af6-aabf-3552ddc024e1';
const target={instanceId:profile.instanceId,origin:profile.origin,workspaceSlug:profile.workspaceSlug,workspaceId:profile.workspaceId,
  projectKey:profile.projectKey,projectId:profile.projectId,itemId:issueIds[0],sequence:12,authorId:profile.principalId};
const mutateBody=(response,change)=>{const body=JSON.parse(response.body); change(body); response.body=Buffer.from(JSON.stringify(body));};

async function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'council-t006-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const project=join(root,'project'),privateRoot=join(root,'private'); mkdirSync(project); mkdirSync(privateRoot);
  new TeamStore(project).set({id:'dev',agent:'codex',role:'Dev'});
  const created=await workItemOperation('create',{id:'wi-t006',title:'Fixture',roleId:'dev',criteria:['done']},{project});
  assert.equal(created.success,true);
  const links=createFixtureOperator({project,privateRoot,installationId,profile,transport:fixtureTransport(),
    itemExists:(root,id)=>Boolean(new WorkItemStore(root).read(id,1))});
  const candidate=await links.resolve('wi-t006','COU-12'); await links.confirm('wi-t006',candidate.candidateId,candidate.localRef);
  const readCurrent=createFixtureWorkItemReader({project,itemId:'wi-t006',links});
  const plane=createFixturePlane(target), githubState=githubFixture(), clock={now:10000};
  const args={privateRoot,project,installationId,itemId:'wi-t006',target,registry:github.registry,
    plane,github:githubState.verifier,operatorId,readCurrent,acknowledgeDirectory:()=>true,now:()=>clock.now};
  const create=overrides=>createFixturePublisher({...args,...overrides});
  const publisher=create();
  const events=()=>{
    const dirName=readdirSync(privateRoot).find(name=>/^[a-f0-9]{64}$/.test(name));
    return readdirSync(join(privateRoot,dirName)).filter(name=>/^\d{8}\.json$/.test(name)).sort()
      .map(name=>JSON.parse(readFileSync(join(privateRoot,dirName,name))));
  };
  const triage=async()=>workItemOperation('triage',{id:'wi-t006',ifRevision:1,requestId:'changed-revision',actor:'Fixture',patch:{priority:'high'}},{project});
  return {root,project,privateRoot,links,readCurrent,plane,githubState,clock,publisher,create,events,triage};
}
const approval=preview=>({operatorId,approved:true,payloadDigest:preview.payloadDigest});

for (const evidenceUrl of [github.pull.html_url,github.commit.html_url]) {
  test(`verified ${evidenceUrl.includes('/pull/')?'PR':'commit'} builds exact preview and revalidates before Start`,async t=>{
    const ctx=await setup(t);
    assert.equal(ctx.githubState.calls.length,0);
    ctx.githubState.mutate=args=>assert.deepEqual(Object.keys(args).sort(),['method','origin','path','signal']);
    const {operation,preview}=await ctx.publisher.prepareEvidence(evidenceUrl);
    assert.equal(operation.state,'prepared'); assert.equal(preview.operationId,operation.operationId);
    assert.equal(preview.installationId,installationId); assert.equal(preview.itemId,'wi-t006');
    assert.match(preview.scopeRef,/^[a-f0-9]{64}$/);
    assert.equal(preview.itemRevision,1); assert.equal(preview.linkRevision,1); assert.equal(preview.status,'open');
    assert.deepEqual(preview.target,target); assert.equal(preview.visibility,'INTERNAL');
    assert.equal(preview.createdAt,10000); assert.equal(preview.expiresAt,310000);
    const expected=JSON.stringify({access:'INTERNAL',comment_html:`<p>Council status: open</p><p>Evidence: ${evidenceUrl}</p><p>Council publication: ${preview.operationId}</p>`});
    assert.deepEqual(preview.payloadUtf8,Buffer.from(expected));
    assert.equal(preview.payloadDigest,createHash('sha256').update(Buffer.from(expected)).digest('hex'));
    assert.equal(ctx.githubState.calls.length,2);
    assert.deepEqual(ctx.githubState.calls.map(call=>[call.method,call.origin,call.path]),[
      ['GET','https://api.github.com','/repos/example/council'],
      ['GET','https://api.github.com',evidenceUrl.includes('/pull/')?'/repos/example/council/pulls/31':`/repos/example/council/commits/${github.commit.sha}`]
    ]);
    const result=await ctx.publisher.confirm(preview.operationId,approval(preview));
    assert.equal(result.state,'published'); assert.equal(ctx.githubState.calls.length,6);
    assert.equal(ctx.events().filter(e=>e.type==='start').length,1); assert.equal(ctx.plane.snapshot().posts,1);
    assert.equal(ctx.plane.snapshot().calls.find(call=>call.method==='POST').bytes,expected);
    const reads=ctx.githubState.calls.length; ctx.githubState.fail=true;
    assert.equal((await ctx.publisher.confirm(preview.operationId,approval(preview))).state,'published');
    assert.equal(ctx.githubState.calls.length,reads); assert.equal(ctx.plane.snapshot().posts,1);
  });
}

test('canonical URL grammar fails before any provider call',async()=>{
  const g=githubFixture();
  for (const value of [' https://github.com/example/council/pull/31','https://user@github.com/example/council/pull/31',
    'https://github.com:443/example/council/pull/31','https://github.com/example/council/pull/031',
    'https://github.com/example/council/pull/0','https://github.com/example/council/pull/31/',
    'https://github.com/example/council/pull/31?q=1','https://github.com/example/council/pull/31#x',
    'https://github.com/example%2Fcouncil/pull/31','https://evil.example/example/council/pull/31',
    'https://github.com/other/council/pull/31','https://github.com/example/council/commit/abcd',
    `https://github.com/example/council/commit/${'A'.repeat(40)}`,`https://github.com/example/council/pull/${'1'.repeat(301)}`]) await assert.rejects(g.verifier.verify(value),{code:'evidence_unverified'});
  assert.equal(g.calls.length,0);
});

test('recorded public provider shapes for PR 18 and the full commit verify through injected GETs',async()=>{
  const registry={fullName:'Ejupi-Labs/council-herdr',id:1462663083,public:true};
  const sha='e843c3104a32e97d9940ee593efe877f9b25a611';
  const calls=[];
  const verifier=createGitHubVerifier({registry,request:async ({method,origin,path})=>{
    calls.push([method,origin,path]);
    const root='/repos/Ejupi-Labs/council-herdr';
    const body=path===root?{id:registry.id,full_name:registry.fullName,private:false}:
      path===`${root}/pulls/18`?{number:18,base:{repo:{id:registry.id}},html_url:`https://github.com/${registry.fullName}/pull/18`}:
      {sha,html_url:`https://github.com/${registry.fullName}/commit/${sha}`};
    return {status:200,redirected:false,body:Buffer.from(JSON.stringify(body))};
  }});
  assert.equal((await verifier.verify(`https://github.com/${registry.fullName}/pull/18`)).reference,'18');
  assert.equal((await verifier.verify(`https://github.com/${registry.fullName}/commit/${sha}`)).reference,sha);
  assert.deepEqual(calls.map(call=>call[2]),['/repos/Ejupi-Labs/council-herdr','/repos/Ejupi-Labs/council-herdr/pulls/18',
    '/repos/Ejupi-Labs/council-herdr',`/repos/Ejupi-Labs/council-herdr/commits/${sha}`]);
});

test('explicit HTTPS adapter pins host and bounds streaming without ambient credentials',async()=>{
  const seen=[];
  function connector(chunks,status=200,headers={}) {
    return (options,callback)=>{
      seen.push(options);
      const req=new EventEmitter(); req.destroy=()=>{};
      req.end=()=>queueMicrotask(()=>{
        const response=new EventEmitter(); response.statusCode=status; response.headers=headers; response.destroy=()=>{};
        callback(response);
        queueMicrotask(()=>{for(const chunk of chunks) response.emit('data',chunk); response.emit('end');});
      });
      return req;
    };
  }
  const args={method:'GET',origin:'https://api.github.com',path:'/repos/example/council',signal:new AbortController().signal};
  const transport=createAnonymousGitHubTransport({connect:connector([Buffer.from('{"ok":true}')])});
  assert.equal((await transport(args)).body.toString(),'{"ok":true}');
  assert.equal(seen[0].hostname,'api.github.com'); assert.equal(seen[0].protocol,'https:');
  assert.equal(seen[0].method,'GET'); assert.equal(seen[0].agent,false); assert.equal(seen[0].rejectUnauthorized,true);
  assert.equal(Object.keys(seen[0].headers).some(key=>/auth|cookie|proxy/i.test(key)),false);
  const oversized=createAnonymousGitHubTransport({connect:connector([Buffer.alloc(600000),Buffer.alloc(600000)])});
  await assert.rejects(oversized(args),{code:'evidence_unverified'});
  const redirect=createAnonymousGitHubTransport({connect:connector([],302,{location:'https://evil.example'})});
  assert.equal((await redirect(args)).status,302); assert.equal(seen.length,3);
});

test('GitHub repository and evidence identity mismatches fail closed',async()=>{
  const cases=[
    ['repo id',(p,b)=>{if(!p.includes('/pulls/')) b.id++;}],
    ['repo slug',(p,b)=>{if(!p.includes('/pulls/')) b.full_name='example/other';}],
    ['private',(p,b)=>{if(!p.includes('/pulls/')) b.private=true;}],
    ['PR number',(p,b)=>{if(p.includes('/pulls/')) b.number=32;}],
    ['PR base',(p,b)=>{if(p.includes('/pulls/')) b.base.repo.id++;}],
    ['PR URL',(p,b)=>{if(p.includes('/pulls/')) b.html_url+='?x=1';}]
  ];
  for (const [name,change] of cases) {
    const g=githubFixture({mutate:(args,response)=>mutateBody(response,body=>change(args.path,body))});
    await assert.rejects(g.verifier.verify(github.pull.html_url),{code:'evidence_unverified'},name);
    assert.ok(g.calls.length<=2);
  }
  for (const field of ['sha','html_url']) {
    const g=githubFixture({mutate:(args,response)=>{if(args.path.includes('/commits/')) mutateBody(response,body=>{body[field]=field==='sha'?'b'.repeat(40):body.html_url+'/';});}});
    await assert.rejects(g.verifier.verify(github.commit.html_url),{code:'evidence_unverified'});
  }
});

test('redirects, non-200, malformed/oversized bodies, transport failure and timeout are typed and redacted',async()=>{
  for (const mutate of [
    (_a,r)=>{r.status=302;}, (_a,r)=>{r.status=429;}, (_a,r)=>{r.redirected=true;},
    (_a,r)=>{r.body=Buffer.from([255]);}, (_a,r)=>{r.body=Buffer.from('{');},
    (_a,r)=>{r.body=Buffer.alloc(1024*1024+1);}
  ]) {
    const g=githubFixture({mutate});
    await assert.rejects(g.verifier.verify(github.pull.html_url),{code:'evidence_unverified'});
  }
  const offline=githubFixture(); offline.fail=true;
  await assert.rejects(offline.verifier.verify(github.pull.html_url),error=>error.code==='offline' && !error.message.includes('fixture-private'));
  const stalled=githubFixture({mutate:()=>new Promise(()=>{}),verifierOptions:{requestTimeoutMs:25,budgetMs:60}});
  await assert.rejects(stalled.verifier.verify(github.pull.html_url),{code:'offline'});
  assert.equal(stalled.calls.length,1);
  const blocked=githubFixture({mutate:()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40),verifierOptions:{requestTimeoutMs:25,budgetMs:200}});
  await assert.rejects(blocked.verifier.verify(github.pull.html_url),{code:'offline'});
  const transport=createAnonymousGitHubTransport();
  await assert.rejects(transport({method:'POST',origin:'https://api.github.com',path:'/repos/example/council'}),{code:'evidence_unverified'});
  await assert.rejects(transport({method:'GET',origin:'https://evil.example',path:'/repos/example/council'}),{code:'evidence_unverified'});
});

test('changed GitHub identity before or during pre-Start verification produces zero Start and POST',async t=>{
  for (const phase of ['first','second']) {
    const ctx=await setup(t); const {preview}=await ctx.publisher.prepareEvidence(github.pull.html_url);
    ctx.githubState.mutate=(args,response)=>{
      const expected=phase==='first'?4:6;
      if (ctx.githubState.calls.length===expected && args.path.endsWith('/pulls/31')) mutateBody(response,body=>{body.base.repo.id++;});
    };
    const result=await ctx.publisher.confirm(preview.operationId,approval(preview));
    assert.equal(result.state,'conflict'); assert.equal(result.reason,'evidence_unverified');
    assert.equal(ctx.events().filter(event=>event.type==='start').length,0); assert.equal(ctx.plane.snapshot().posts,0);
    assert.equal(ctx.githubState.calls.length,phase==='first'?4:6);
  }
});

test('COU-8 revision change before and during GitHub GET produces zero Start and POST',async t=>{
  for (const phase of ['before','during-first','during-second']) {
    const ctx=await setup(t); const {preview}=await ctx.publisher.prepareEvidence(github.pull.html_url);
    if (phase==='before') assert.equal((await ctx.triage()).success,true);
    else ctx.githubState.mutate=async()=>{
      if (ctx.githubState.calls.length===(phase==='during-first'?4:6)) assert.equal((await ctx.triage()).success,true);
    };
    const result=await ctx.publisher.confirm(preview.operationId,approval(preview));
    assert.equal(result.state,'conflict'); assert.equal(result.reason,'scope_conflict');
    assert.equal(ctx.events().filter(event=>event.type==='start').length,0); assert.equal(ctx.plane.snapshot().posts,0);
    assert.equal(ctx.readCurrent().itemRevision,2);
  }
});

test('revision change during preparation GET leaves no intent or send',async t=>{
  const ctx=await setup(t);
  ctx.githubState.mutate=async()=>{if(ctx.githubState.calls.length===2) assert.equal((await ctx.triage()).success,true);};
  await assert.rejects(ctx.publisher.prepareEvidence(github.pull.html_url),{code:'scope_conflict'});
  assert.equal(ctx.events().length,0); assert.equal(ctx.plane.snapshot().posts,0);
});

test('expiry or COU-8 corruption during preparation GET leaves no intent or send',async t=>{
  for (const mode of ['expiry','integrity']) {
    const ctx=await setup(t);
    ctx.githubState.mutate=()=>{
      if(ctx.githubState.calls.length===2) {
        if(mode==='expiry') ctx.clock.now=310000;
        else writeFileSync(join(ctx.project,'.agent_workspace','.work-items','wi-t006','00000001.json'),Buffer.from([255]));
      }
    };
    await assert.rejects(ctx.publisher.prepareEvidence(github.pull.html_url),{code:mode==='expiry'?'stale_preview':'integrity_error'});
    assert.equal(ctx.events().length,0); assert.equal(ctx.plane.snapshot().posts,0);
  }
});

test('scope, link, status and author changes during GitHub GET cannot reach Start',async t=>{
  for (const field of ['installation','link','status','author','integrity']) {
    const ctx=await setup(t); let changed=false;
    const readCurrent=()=>{
      const current=ctx.readCurrent();
      if (changed) {
        if(field==='installation') current.installationId='1b6eba33-7959-4d8b-9387-576ac77ea410';
        if(field==='link') current.linkRevision++;
        if(field==='status') current.status='closed';
        if(field==='author') current.target={...current.target,authorId:'e709703f-50b5-4f0c-80a1-d5a78d62574a'};
        if(field==='integrity') current.integrity=true;
      }
      return current;
    };
    const publisher=ctx.create({readCurrent});
    const {preview}=await publisher.prepareEvidence(github.pull.html_url);
    ctx.githubState.mutate=()=>{if(ctx.githubState.calls.length===4) changed=true;};
    const result=await publisher.confirm(preview.operationId,approval(preview));
    assert.equal(result.state,'conflict',field);
    assert.equal(result.reason,field==='integrity'?'integrity_error':'scope_conflict',field);
    assert.equal(ctx.events().filter(event=>event.type==='start').length,0); assert.equal(ctx.plane.snapshot().posts,0);
  }
});

test('expiry during either GitHub verification leaves zero Start and zero POST',async t=>{
  for (const call of [4,6]) {
    const ctx=await setup(t); const {preview}=await ctx.publisher.prepareEvidence(github.pull.html_url);
    ctx.githubState.mutate=()=>{if(ctx.githubState.calls.length===call) ctx.clock.now=preview.expiresAt;};
    const result=await ctx.publisher.confirm(preview.operationId,approval(preview));
    assert.equal(result.state,'expired'); assert.equal(result.reason,'stale_preview');
    assert.equal(ctx.events().filter(event=>event.type==='start').length,0); assert.equal(ctx.plane.snapshot().posts,0);
  }
});

test('total verification budget is enforced at the Start link boundary',async t=>{
  const ctx=await setup(t);
  const limited=githubFixture({verifierOptions:{requestTimeoutMs:100,budgetMs:500}});
  const publisher=ctx.create({github:limited.verifier,hook:(point,type)=>{
    if(point==='before_link' && type==='start') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,550);
  }});
  const {preview}=await publisher.prepareEvidence(github.pull.html_url);
  const result=await publisher.confirm(preview.operationId,approval(preview));
  assert.equal(result.state,'offline'); assert.equal(result.reason,'offline');
  assert.equal(ctx.events().filter(event=>event.type==='start').length,0); assert.equal(ctx.plane.snapshot().posts,0);
});

test('unverified low-level snapshot and corrupted COU-8 data cannot reach Start',async t=>{
  const ctx=await setup(t);
  ctx.githubState.mutate=(args,response)=>{if(args.path.endsWith('/pulls/31')) mutateBody(response,body=>{body.number=999;});};
  const low={operationId:'1'.repeat(32),itemRevision:1,linkRevision:1,status:'open',evidenceUrl:github.pull.html_url,createdAt:10000,expiresAt:310000};
  assert.equal(ctx.publisher.prepare,undefined);
  await assert.rejects(ctx.publisher.prepareEvidence(low),{code:'invalid_input'});
  assert.equal(ctx.events().length,0); assert.equal(ctx.plane.snapshot().posts,0);
  await assert.rejects(ctx.publisher.prepareEvidence(github.pull.html_url),{code:'evidence_unverified'});
  assert.equal(ctx.events().length,0);
  ctx.githubState.mutate=()=>{};
  const {preview}=await ctx.publisher.prepareEvidence(github.pull.html_url);
  const eventPath=join(ctx.project,'.agent_workspace','.work-items','wi-t006','00000001.json');
  writeFileSync(eventPath,Buffer.from([255]));
  const result=await ctx.publisher.confirm(preview.operationId,approval(preview));
  assert.equal(result.state,'conflict'); assert.equal(result.reason,'integrity_error');
  assert.equal(ctx.events().filter(event=>event.type==='start').length,0); assert.equal(ctx.plane.snapshot().posts,0);
});

test('no low-level fixture entry can bypass later GitHub revalidation',async t=>{
  const ctx=await setup(t);
  assert.equal(ctx.publisher.prepare,undefined);
  const {preview}=await ctx.publisher.prepareEvidence(github.pull.html_url);
  ctx.githubState.mutate=(args,response)=>{if(args.path.endsWith('/pulls/31')) mutateBody(response,body=>{body.html_url+='?bad';});};
  const result=await ctx.publisher.confirm(preview.operationId,approval(preview));
  assert.equal(result.state,'conflict'); assert.equal(result.reason,'evidence_unverified');
  assert.equal(ctx.events().filter(event=>event.type==='start').length,0); assert.equal(ctx.plane.snapshot().posts,0);
});

test('fixture binding cannot substitute another installation or Plane author',async t=>{
  const ctx=await setup(t);
  const wrongRegistry=createGitHubVerifier({registry:{...github.registry,id:github.registry.id+1},request:async()=>({status:200,redirected:false,body:Buffer.from('{}')})});
  assert.throws(()=>ctx.create({github:wrongRegistry}),{code:'invalid_input'});
  const wrongInstallation=ctx.create({installationId:'1b6eba33-7959-4d8b-9387-576ac77ea410'});
  await assert.rejects(wrongInstallation.prepareEvidence(github.pull.html_url),{code:'scope_conflict'});
  const changed={...target,authorId:'e709703f-50b5-4f0c-80a1-d5a78d62574a'};
  const wrongAuthor=ctx.create({target:changed,plane:createFixturePlane(changed)});
  await assert.rejects(wrongAuthor.prepareEvidence(github.pull.html_url),{code:'scope_conflict'});
  assert.equal(ctx.plane.snapshot().posts,0);
});

test('a started uncertain operation remains inspection even if GitHub is offline',async t=>{
  const ctx=await setup(t); const {preview}=await ctx.publisher.prepareEvidence(github.pull.html_url);
  ctx.plane.setMode('commit_drop');
  assert.equal((await ctx.publisher.confirm(preview.operationId,approval(preview))).state,'delivery_uncertain');
  const reads=ctx.githubState.calls.length; ctx.githubState.fail=true;
  const restarted=ctx.create();
  assert.equal((await restarted.confirm(preview.operationId,{})).state,'delivery_uncertain');
  const prepared=await restarted.prepareEvidence('not-a-new-request');
  assert.equal(prepared.operation.operationId,preview.operationId); assert.equal(prepared.preview,null);
  assert.equal(ctx.githubState.calls.length,reads); assert.equal(ctx.plane.snapshot().posts,1);
});
