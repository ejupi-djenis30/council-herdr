import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { workItemOperation } from '../lib/work-items.js';

test('CLI and MCP share a project and return typed envelopes',async t=>{
 const p=mkdtempSync(join(tmpdir(),'items cli ü ')); t.after(()=>rmSync(p,{recursive:true,force:true})); new TeamStore(p).set({id:'dev',agent:'codex',role:'Dev'});
 const cli=resolve('bin/council.js'); const run=(...args)=>spawnSync(process.execPath,[cli,'work-item',...args,'--project',p],{encoding:'utf8'});
 const input={id:'wi-cli',title:'Ünicode',roleId:'dev',criteria:['first','second']};
 let child=run('create','--input-json',JSON.stringify(input)); assert.equal(child.status,0,child.stderr); assert.equal(JSON.parse(child.stdout).item.title,input.title);
 child=run('show','--id','wi-cli'); assert.deepEqual(JSON.parse(child.stdout).item.criteria,input.criteria);
 const seeded=await workItemOperation('delegate',{id:'wi-cli'},{project:p,callTeamMember:async()=>{}});
 child=run('delegate','--id','wi-cli'); assert.equal(JSON.parse(child.stdout).item.job.sessionId,seeded.item.job.sessionId);
 child=run('list'); assert.equal(JSON.parse(child.stdout).items[0].id,'wi-cli');
 child=run('delegate','--id','../bad'); assert.notEqual(child.status,0); assert.equal(JSON.parse(child.stdout).error.code,'invalid_input');
 const messages=[{jsonrpc:'2.0',id:1,method:'tools/list'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'council_work_item_show',arguments:{project:p,id:'wi-cli'}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'council_work_item_list',arguments:{}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'council_work_item_delegate',arguments:{project:p,id:'wi-cli'}}},{jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'council_work_item_create',arguments:{project:p,...input}}},{jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'council_work_item_list',arguments:{project:p}}}];
 child=spawnSync(process.execPath,[cli,'mcp'],{cwd:p,env:{...process.env,COUNCIL_MCP_REQUIRE_PROJECT:'1'},input:messages.map(JSON.stringify).join('\n')+'\n',encoding:'utf8'});
 assert.equal(child.status,0,child.stderr); const frames=child.stdout.trim().split(/\r?\n/).map(JSON.parse); const response=new Map(frames.map(x=>[x.id,x.result])); assert.ok(response.get(1).tools.some(x=>x.name==='council_work_item_create')); assert.equal(JSON.parse(response.get(2).content[0].text).item.id,'wi-cli'); assert.equal(response.get(3).isError,true); assert.equal(JSON.parse(response.get(4).content[0].text).item.job.sessionId,seeded.item.job.sessionId); assert.equal(JSON.parse(response.get(5).content[0].text).item.id,'wi-cli'); assert.equal(JSON.parse(response.get(6).content[0].text).items[0].id,'wi-cli');
});
