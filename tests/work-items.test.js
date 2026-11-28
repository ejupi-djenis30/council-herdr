import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { workItemOperation } from '../lib/work-items.js';
import { computeFingerprint } from '../herdr/mods/council/runtime/job-record.mjs';

function setup(t) { const project=mkdtempSync(join(tmpdir(),'council items ü ')); t.after(()=>rmSync(project,{recursive:true,force:true})); new TeamStore(project).set({id:'developer',agent:'codex',role:'Developer',permission:'write'}); return project; }
const definition={id:'wi-test',title:' Test ',roleId:'developer',criteria:[' one ','two']};
const op=(project,action,input,extra={})=>workItemOperation(action,input,{project,...extra});
const itemDir=(p)=>join(p,'.agent_workspace','.work-items','wi-test');
const read=(p,f)=>JSON.parse(readFileSync(join(p,f),'utf8'));
function writeJob(project,intent,override={}) { const dir=join(project,'.agent_workspace',intent.sessionId); mkdirSync(dir,{recursive:true}); const job={$schema:'council.job/v1',sessionId:intent.sessionId,workItemId:intent.id,mode:'delegate',participant:{team:{id:intent.roleId},address:'t123'},state:'starting',deliveryState:'planned',deadlineAt:new Date(Date.now()+60000).toISOString(),...override}; writeFileSync(join(dir,'job.json'),JSON.stringify(job)); return {job,dir}; }

test('definition is normalized, idempotent, isolated, and invalid input leaves no item',async t=>{
 const p=setup(t),other=setup(t);
 let r=await op(p,'create',definition); assert.equal(r.success,true); assert.deepEqual(r.item.criteria,['one','two']); assert.equal(r.item.state,'draft');
 assert.deepEqual((await op(p,'create',{...definition,title:'Test'})).item,r.item);
 assert.equal((await op(p,'create',{...definition,title:'Conflict'})).error.code,'conflict');
 assert.equal((await op(other,'show',{id:definition.id})).error.code,'not_found');
 assert.equal((await op(p,'create',{...definition,id:'../bad'})).error.code,'invalid_input');
 assert.equal((await op(p,'create',{...definition,id:'wi-other',criteria:['bad\nline']})).error.code,'invalid_input');
 assert.equal(existsSync(join(p,'.agent_workspace','.work-items','wi-other')),false);
 const bad=join(p,'.agent_workspace','.work-items','wi-damaged'); mkdirSync(bad); writeFileSync(join(bad,'00000001.json'),'{');
 const listed=await op(p,'list',{}); assert.equal(listed.items.length,1); assert.equal(listed.errors[0].id,'wi-damaged');
});

test('one published claim across independent processes and replay does not dispatch',async t=>{
 const p=setup(t); await op(p,'create',definition);
 const module=pathToFileURL(resolve('lib/work-items.js')).href, count=join(p,'calls');
 const script=`import {appendFileSync} from 'node:fs'; import {workItemOperation} from ${JSON.stringify(module)}; const result=await workItemOperation('delegate',{id:'wi-test'},{project:process.argv[1],callTeamMember:async()=>{appendFileSync(process.argv[2],'call\\n');}}); console.log(JSON.stringify(result));`;
 const run=()=>new Promise((resolvePromise,reject)=>{ const child=spawn(process.execPath,['--input-type=module','-e',script,p,count]); let out='',err=''; child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>err+=d); child.on('error',reject); child.on('close',code=>code?reject(Error(err)):resolvePromise(JSON.parse(out))); });
 const [a,b]=await Promise.all([run(),run()]); assert.equal(a.success,true); assert.equal(b.success,true); assert.equal(a.item.job.sessionId,b.item.job.sessionId); assert.equal(readFileSync(count,'utf8'),'call\n');
 const intent=read(itemDir(p),'00000002.json'); assert.equal(intent.sessionId,a.item.job.sessionId);
 const replay=await op(p,'delegate',{id:'wi-test'},{callTeamMember:()=>{throw Error('must not dispatch');}}); assert.equal(replay.item.job.outcome,'unconfirmed_start'); assert.equal((await op(p,'delegate',{id:'wi-test',timeoutSec:10})).error.code,'conflict');
});

test('interruptions preserve session and deadline; matched completion is screen evidence',async t=>{
 for (const phase of ['before-reservation','during-reservation','after-dispatch']) {
  const p=setup(t); await op(p,'create',definition); let session;
  const r=await op(p,'delegate',{id:'wi-test',timeoutSec:90},{callTeamMember:async (_m,args)=>{ session=args.sessionId; if(phase==='during-reservation') mkdirSync(join(p,'.agent_workspace',session)); if(phase==='after-dispatch') writeJob(p,{id:'wi-test',roleId:'developer',sessionId:session},{state:'uncertain',deliveryState:'uncertain'}); throw Error('lost reply'); }});
  assert.equal(r.success,true); assert.equal(r.item.job.sessionId,session); assert.equal(r.item.state,'needs_attention');
  let called=0; const reopened=await op(p,'delegate',{id:'wi-test'},{callTeamMember:()=>called++}); assert.equal(called,0); assert.equal(reopened.item.job.sessionId,session);
  const intent=read(itemDir(p),'00000002.json'); assert.equal(intent.timeoutSec,90);
 }
 const p=setup(t); await op(p,'create',definition); await op(p,'delegate',{id:'wi-test'},{callTeamMember:async()=>{}}); const intent=read(itemDir(p),'00000002.json');
 const {job,dir}=writeJob(p,intent,{state:'completed',deliveryState:'acknowledged',result:{output:'done',captureScope:'terminal',turn:4,completedAt:new Date().toISOString(),artifactPath:'deliverables/output.txt'}});
 mkdirSync(join(dir,'deliverables')); writeFileSync(join(dir,'deliverables','output.txt'),'done');
 let r=await op(p,'show',{id:'wi-test'},{manager:{getStatus:async()=>({outcome:'completed'})}}); assert.equal(r.item.state,'result_ready'); assert.equal(r.item.result.source,'terminal_screen'); assert.match(r.item.nextAction,/Review/);
 job.workItemId='wi-foreign'; writeFileSync(join(dir,'job.json'),JSON.stringify(job)); const bytes=readFileSync(join(dir,'job.json'),'utf8'); r=await op(p,'show',{id:'wi-test'}); assert.equal(r.item.job.linked,false); assert.equal(r.item.job.address,null); assert.equal(r.item.result,null); assert.equal(readFileSync(join(dir,'job.json'),'utf8'),bytes);
});

test('binding participates in fingerprint without changing old fingerprints',()=>{
 const options={task:'test',team:{id:'developer'}}; assert.equal(computeFingerprint(options),computeFingerprint({...options,workItemId:undefined})); assert.notEqual(computeFingerprint(options),computeFingerprint({...options,workItemId:'wi-test'}));
});

test('existing Team execution persists profile, brief, binding and deadline with fake transport',async t=>{
 const {JobManager}=await import('../lib/jobs.js');
 const {JobWorker}=await import('../lib/job-worker.js');
 const p=setup(t); await op(p,'create',definition); let launch;
 const herdr={terminalId:null,get:()=>({success:false})};
 const manager=new JobManager({cwd:p,herdr,workerLauncher:call=>{launch=call; return {success:true,address:'worker'};}});
 const start=await op(p,'delegate',{id:'wi-test',timeoutSec:45},{manager}); assert.equal(start.item.state,'in_progress');
 assert.equal(launch.job.workItemId,'wi-test'); assert.equal(launch.job.participant.team.id,'developer'); assert.equal(launch.job.permission,'write'); assert.equal(launch.job.timeoutSec,45); assert.match(launch.job.task,/1\. one\n2\. two/); assert.equal(start.item.job.deadlineAt,launch.job.deadlineAt);
 const worker=new JobWorker({sessionDir:launch.sessionDir,herdr:{launchAgent:()=>({success:true,address:'t1',identity:{pid:10,createdMs:20},baselineTurn:1}),wait:()=>({success:true,ended:true,terminal:'t1',reason:'status',status:'done',turn:2}),captureTurn:()=>({success:true,content:'Handoff text',captureScope:'turn'}),stopCompletedTeamTurn:()=>({success:true})}});
 assert.equal((await worker.execute()).success,true);
 const reopened=await op(p,'show',{id:'wi-test'},{manager}); assert.equal(reopened.item.state,'result_ready'); assert.equal(reopened.item.result.output,'Handoff text'); assert.equal(reopened.item.result.source,'terminal_screen'); assert.equal(reopened.item.job.deadlineAt,launch.job.deadlineAt);
});

test('disk projection handles interruptions, late completion and inconsistent records',async t=>{
 const p=setup(t); await op(p,'create',definition); await op(p,'delegate',{id:'wi-test'},{callTeamMember:async()=>{}}); const intent=read(itemDir(p),'00000002.json');
 const cases=[
  [{state:'starting',deliveryState:'planned'},'in_progress','starting'],
  [{state:'deliberating',deliveryState:'acknowledged',awaitingInput:true},'needs_attention','awaiting_input'],
  [{state:'uncertain',deliveryState:'uncertain'},'needs_attention','uncertain'],
  [{state:'failed',deliveryState:'acknowledged',waitDetails:{reason:'blocked'}},'needs_attention','blocked'],
  [{state:'failed',deliveryState:'acknowledged',waitDetails:{reason:'timeout'}},'needs_attention','timed_out'],
  [{state:'failed',deliveryState:'planned'},'needs_attention','failed'],
  [{state:'deliberating',deliveryState:'acknowledged',deadlineAt:new Date(Date.now()-1000).toISOString()},'needs_attention','timed_out'],
  [{state:'completed',deliveryState:'planned',result:{output:'unverified'}},'needs_attention','integrity_error'],
  [{state:'mystery',deliveryState:'planned'},'needs_attention','integrity_error']
 ];
 for(const [state,expected,outcome] of cases) { writeJob(p,intent,state); const r=await op(p,'list',{}); assert.equal(r.items[0].state,expected,JSON.stringify(state)); assert.equal(r.items[0].job.outcome,outcome); }
 const {dir}=writeJob(p,intent,{state:'starting',deliveryState:'planned'}); writeFileSync(join(dir,'dispatch-error.json'),JSON.stringify({error:'failed'})); assert.equal((await op(p,'list',{})).items[0].job.outcome,'dispatch_failed');
 writeJob(p,intent,{state:'completed',deliveryState:'acknowledged',result:{output:'late'}}); assert.equal((await op(p,'list',{})).items[0].state,'result_ready');
});

test('malformed intent and mismatched or escaped evidence never dispatch or link',async t=>{
 const p=setup(t); await op(p,'create',definition);
 writeFileSync(join(itemDir(p),'00000002.json'),'null'); let calls=0;
 let r=await op(p,'delegate',{id:'wi-test'},{callTeamMember:()=>calls++}); assert.equal(calls,0); assert.equal(r.item.attention.code,'integrity_error');
 rmSync(join(itemDir(p),'00000002.json')); await op(p,'delegate',{id:'wi-test'},{callTeamMember:async()=>{}}); const intent=read(itemDir(p),'00000002.json');
 for(const override of [{mode:'review'},{sessionId:'other'},{workItemId:'wi-other'},{participant:{team:{id:'foreign'},address:'t1'}}]) { writeJob(p,intent,override); r=await op(p,'show',{id:'wi-test'}); assert.equal(r.item.job.linked,false); assert.equal(r.item.result,null); }
 writeJob(p,intent,{state:'completed',deliveryState:'acknowledged',result:{output:'unsafe',artifactPath:'../escape'}}); r=await op(p,'list',{}); assert.equal(r.items[0].state,'needs_attention'); assert.equal(r.items[0].job.outcome,'integrity_error');
});

test('replay survives role removal while a new draft cannot delegate',async t=>{
 const p=setup(t); await op(p,'create',definition); rmSync(join(p,'.agent_workspace','.team'),{recursive:true});
 assert.equal((await op(p,'create',definition)).success,true);
 let called=0; const result=await op(p,'delegate',{id:'wi-test'},{callTeamMember:()=>called++}); assert.equal(result.error.code,'role_unavailable'); assert.equal(called,0); assert.equal(existsSync(join(itemDir(p),'00000002.json')),false);
});

test('bounded corrupted events preserve valid rows and a corrupted intent cannot dispatch',async t=>{
 const p=setup(t); await op(p,'create',definition);
 const base=join(p,'.agent_workspace','.work-items');
 for(const [id,content] of [['wi-large','x'.repeat(65537)],['wi-partial','{"id":'],['wi-null','null']]) { const dir=join(base,id); mkdirSync(dir); writeFileSync(join(dir,'00000001.json'),content); }
 const listing=await op(p,'list',{}); assert.equal(listing.items.length,1); assert.equal(listing.errors.length,3);
 writeFileSync(join(itemDir(p),'00000002.json'),'{'); let calls=0; const r=await op(p,'delegate',{id:'wi-test'},{callTeamMember:()=>calls++}); assert.equal(calls,0); assert.equal(r.item.state,'needs_attention'); assert.equal(r.item.job,null);
});

test('show probes the verified worker but list stays disk only',async t=>{
 const p=setup(t); await op(p,'create',definition); await op(p,'delegate',{id:'wi-test'},{callTeamMember:async()=>{}}); const intent=read(itemDir(p),'00000002.json'); writeJob(p,intent);
 let probes=0; const manager={getStatus:async()=>{probes++; return {outcome:'worker_stopped'};}};
 assert.equal((await op(p,'list',{}, {manager})).items[0].state,'in_progress'); assert.equal(probes,0);
 const shown=await op(p,'show',{id:'wi-test'},{manager}); assert.equal(probes,1); assert.equal(shown.item.job.outcome,'worker_stopped'); assert.equal(shown.item.state,'needs_attention');
});

test('different timeout claims from separate processes publish one intent and one transport call',async t=>{
 const p=setup(t); await op(p,'create',definition);
 const module=pathToFileURL(resolve('lib/work-items.js')).href, count=join(p,'racing-calls');
 const script=`import {appendFileSync} from 'node:fs'; import {workItemOperation} from ${JSON.stringify(module)}; const r=await workItemOperation('delegate',{id:'wi-test',timeoutSec:Number(process.argv[3])},{project:process.argv[1],callTeamMember:async()=>{appendFileSync(process.argv[2],'call\\n');}}); console.log(JSON.stringify(r));`;
 const run=timeout=>new Promise((done,reject)=>{const c=spawn(process.execPath,['--input-type=module','-e',script,p,count,String(timeout)]);let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.on('error',reject);c.on('close',code=>code?reject(Error(err)):done(JSON.parse(out)));});
 const results=await Promise.all([run(30),run(60)]); assert.equal(results.filter(r=>r.success).length,1); assert.equal(results.find(r=>!r.success).error.code,'conflict'); assert.equal(readFileSync(count,'utf8'),'call\n'); assert.ok([30,60].includes(read(itemDir(p),'00000002.json').timeoutSec));
});
