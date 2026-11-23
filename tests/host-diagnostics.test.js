import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillRevision } from '../herdr/mods/council/runtime/alignment.mjs';
import { setupAlignment } from '../lib/alignment-setup.js';
import { councilVersion, diagnoseCouncilHost, requiredCouncilTools } from '../lib/diagnostics.js';
import { CouncilMcpServer } from '../lib/mcp-server.js';

function temporaryProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'council-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('host doctor distinguishes stale config, stale live MCP, skill mismatch and an unconfirmed terminal', t => {
  const project = temporaryProject(t);
  const request = { host: 'claude', project };
  const plan = setupAlignment({ ...request, apply: true });
  const oldPackage = join(project, 'older-install');
  const oldRunner = join(oldPackage, 'bin', 'council.js');
  mkdirSync(join(oldPackage, 'bin'), { recursive: true });
  writeFileSync(oldRunner, 'throw new Error("Doctor must not execute the configured runner")');
  writeFileSync(join(oldPackage, 'package.json'), JSON.stringify({ name: 'council-herdr', version: '2.0.1' }));
  writeFileSync(plan.config, JSON.stringify({ mcpServers: { council: { args: [oldRunner, 'mcp'] } } }));
  writeFileSync(plan.skill, 'An older skill without a readiness revision');

  const stale = diagnoseCouncilHost(request);
  assert.equal(stale.configured.server.version, '2.0.1');
  assert.deepEqual(stale.issues.map(issue => issue.code), ['stale_mcp', 'skill_mismatch']);

  setupAlignment({ ...request, apply: true, replace: true });
  const liveServer = { version: '2.0.1', tools: ['council_start'] };
  assert.deepEqual(diagnoseCouncilHost({ ...request, liveServer }).issues.map(issue => issue.code), ['needs_reload']);

  const herdr = { get: address => ({ success: true, details: { address } }) };
  const current = diagnoseCouncilHost({ ...request, target: 't1', herdr,
    liveServer: { version: councilVersion, tools: requiredCouncilTools } });
  assert.equal(current.configured.skill.revision, skillRevision);
  assert.equal(current.configured.skill.fingerprint, current.expected.skillFingerprint);
  assert.deepEqual(current.alignment, { address: 't1', state: 'unconfirmed' });
  assert.deepEqual(current.issues.map(issue => issue.code), ['alignment_unconfirmed']);

  writeFileSync(plan.skill, readFileSync(plan.skill, 'utf8') + '\nOutdated guidance using the same protocol.\n');
  const editedSkill = diagnoseCouncilHost(request);
  assert.equal(editedSkill.configured.skill.revision, skillRevision);
  assert.deepEqual(editedSkill.issues.map(issue => issue.code), ['skill_mismatch']);
});

test('Antigravity setup merges an absolute runner and explicit project binding into the workspace profile', t => {
  const project = temporaryProject(t);
  const request = { host: 'antigravity', project };
  const preview = setupAlignment(request);
  assert.equal(preview.config, join(project, '.agents', 'mcp_config.json'));
  assert.equal(preview.skill, join(project, '.agents', 'skills', 'council', 'SKILL.md'));
  assert.equal(existsSync(preview.config), false);
  mkdirSync(join(project, '.agents'));
  writeFileSync(preview.config, JSON.stringify({ mcpServers: { other: { command: 'example' } } }));
  setupAlignment({ ...request, apply: true });
  const servers = JSON.parse(readFileSync(preview.config, 'utf8')).mcpServers;
  assert.deepEqual(servers.other, { command: 'example' });
  assert.deepEqual(servers.council, preview.server);
  assert.equal(servers.council.env.COUNCIL_MCP_PROJECT, project);
});

test('an unbound plugin requires a project and keeps identical job IDs separate', async t => {
  const bundle = temporaryProject(t);
  const first = temporaryProject(t);
  const second = temporaryProject(t);
  const server = new CouncilMcpServer({ cwd: bundle, requireProject: true });
  const dispatches = [];
  server.herdr.exec = args => {
    assert.equal(args[0], 'run');
    dispatches.push({ name: args[args.indexOf('--name') + 1], cwd: args[args.indexOf('--cwd') + 1] });
    return { success: true, stdout: JSON.stringify({ address: `t${dispatches.length}` }) };
  };
  let response;
  server.sendResult = (_id, result) => { response = result; };
  const call = async (name, args) => {
    await server.handleToolCall(1, { name, arguments: args });
    return response;
  };

  assert.match((await call('council_start', { task: 'Missing context' })).content[0].text, /no default project/);
  assert.match((await call('council_convene', { task: 'Missing context' })).content[0].text, /no default project/);
  assert.match((await call('council_delegate', { task: 'Missing context' })).content[0].text, /no default project/);
  assert.match((await call('council_cast_ballot', { sessionId: 'shared' })).content[0].text, /absolute session directory/);
  for (const [project, task] of [[first, 'First task'], [second, 'Second task']]) {
    const args = { project, sessionId: 'shared' };
    const started = await call('council_start', { ...args, task });
    assert.equal(started.isError, false, started.content[0].text);
    const snapshot = await call('council_session_status', args);
    const result = await call('council_result', args);
    for (const reply of [started, snapshot, result]) assert.equal(JSON.parse(reply.content[0].text).project, project);
    assert.equal(JSON.parse(result.content[0].text).ready, false);
    const record = JSON.parse(readFileSync(join(project, '.agent_workspace', 'shared', 'job.json'), 'utf8'));
    assert.equal(record.task, task);
  }
  assert.deepEqual(dispatches.map(call => call.cwd), [first, second]);
  assert.notEqual(dispatches[0].name, dispatches[1].name);
  assert.equal(existsSync(join(bundle, '.agent_workspace')), false);
});
