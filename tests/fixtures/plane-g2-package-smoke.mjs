import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TeamStore } from '../../herdr/mods/council/runtime/team.mjs';
import { workItemOperation } from '../../lib/work-items.js';

const archive = process.argv[2];
if (!archive) throw Error('Expected npm tarball');
const root = mkdtempSync(join(tmpdir(), 'plane-g2-package-'));
try {
  const unpack = spawnSync('tar',['-xzf','-'],{cwd:root,input:readFileSync(archive),encoding:'utf8'});
  assert.equal(unpack.status,0,unpack.stderr);
  const project=join(root,'project'), app=join(root,'app'); mkdirSync(project);
  new TeamStore(project).set({id:'dev',agent:'codex',role:'Dev'});
  const created=await workItemOperation('create',{id:'wi-package',title:'Fixture',roleId:'dev',criteria:['done']},{project});
  assert.equal(created.success,true);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/plane/i.test(key)));
  const installed=spawnSync(process.execPath,[join(root,'package/herdr/install.js'),'--app-home',app],{encoding:'utf8',env});
  assert.equal(installed.status,0,installed.stderr);
  const engine=join(app,'mods/council/engine');
  for (const file of ['plane-journal-fixture.mjs','plane-publication-fixture.mjs','plane-transport-fixture.mjs'])
    assert.ok(readFileSync(join(engine,'herdr/mods/council/runtime',file)).length);
  const cli=join(engine,'bin/council.js');
  for (const action of ['show','open']) {
    const child=spawnSync(process.execPath,[cli,'work-item','plane',action,'--id','wi-package','--project',project],{encoding:'utf8',env});
    assert.equal(child.status,0,child.stderr);
    const result=JSON.parse(child.stdout); assert.equal(result.installationId,null);
    if (action==='show') assert.equal(result.plane.availability,'disabled');
    else assert.equal(result.planeHandoff.disposition,'unavailable');
  }
  const request={jsonrpc:'2.0',id:1,method:'tools/list'};
  const mcp=spawnSync(process.execPath,[cli,'mcp'],{cwd:project,env,input:JSON.stringify(request)+'\n',encoding:'utf8'});
  assert.equal(mcp.status,0,mcp.stderr);
  const names=JSON.parse(mcp.stdout.trim()).result.tools.map(tool=>tool.name);
  assert.ok(names.includes('council_work_item_plane_show'));
  assert.ok(!names.some(name=>/council_work_item_plane_(publish|confirm|prepare|reconcile)/.test(name)));
  process.stdout.write('G2 fixture modules packaged; installed CLI/MCP remain disabled without Plane credentials.\n');
} finally { rmSync(root,{recursive:true,force:true}); }
