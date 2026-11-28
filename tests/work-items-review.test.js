import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { WorkItemStore } from '../herdr/mods/council/runtime/work-item-store.mjs';
import { workItemOperation } from '../lib/work-items.js';
import { JobManager } from '../lib/jobs.js';
import { JobWorker } from '../lib/job-worker.js';

const cli = resolve('bin/council.js');
const definition = { id: 'wi-review', title: 'Review', roleId: 'dev', criteria: ['Deliver the result'] };
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'council alias '));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const project = join(parent, 'project');
  mkdirSync(project);
  new TeamStore(project).set({ id: 'dev', agent: 'codex', role: 'Developer' });
  return { parent, project };
}
function callMcp(project, calls, options = {}) {
  const frames = calls.map((args, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'council_work_item_' + args[0], arguments: args[1] } })).join('\n') + '\n';
  const child = spawnSync(process.execPath, [...(options.nodeArgs ?? []), cli, 'mcp'], { cwd: project, input: frames, encoding: 'utf8', env: { ...process.env, ...options.env } });
  assert.equal(child.status, 0, child.stderr);
  return new Map(child.stdout.trim().split(/\r?\n/).map(line => { const r = JSON.parse(line); return [r.id, r.result]; }));
}

test('a completed Team capture saved through a project alias is visible through CLI and MCP', async t => {
  const { parent, project } = fixture(t);
  const alias = join(parent, 'project-alias');
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let dispatched;
  const manager = new JobManager({ cwd: alias, herdr: { terminalId: null, get: () => ({ success: false }) }, workerLauncher: job => { dispatched = job; return { success: true }; } });
  await workItemOperation('create', definition, { project: alias });
  const start = await workItemOperation('delegate', { id: definition.id }, { project: alias, manager });
  assert.equal(start.item.job.linked, true);
  const worker = new JobWorker({ sessionDir: dispatched.sessionDir, herdr: {
    launchAgent: () => ({ success: true, address: 't1', identity: { pid: 10, createdMs: 20 }, baselineTurn: 1 }),
    wait: () => ({ success: true, ended: true, terminal: 't1', reason: 'status', status: 'done', turn: 2 }),
    captureTurn: () => ({ success: true, content: 'Alias handoff', captureScope: 'turn' }),
    stopCompletedTeamTurn: () => ({ success: true })
  } });
  assert.equal((await worker.execute()).success, true);
  const child = spawnSync(process.execPath, [cli, 'work-item', 'show', '--id', definition.id, '--project', project], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const shown = JSON.parse(child.stdout).item;
  assert.equal(shown.state, 'result_ready');
  assert.equal(shown.result.output, 'Alias handoff');
  assert.equal(shown.job.linked, true);
  const reply = callMcp(alias, [['show', { project: alias, id: definition.id }]]).get(1);
  const item = JSON.parse(reply.content[0].text).item;
  assert.equal(item.state, 'result_ready');
  assert.equal(item.result.source, 'terminal_screen');
  assert.equal(item.job.linked, true);
});

test('MCP rejects non-object arguments using typed error envelopes', t => {
  const { project } = fixture(t);
  const responses = callMcp(project, [['list', []], ['list', null], ['show', 'wrong'], ['create', 12]]);
  for (const result of responses.values()) {
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'invalid_input');
  }
});

test('publication errors map to storage_error and uncertain publication cannot dispatch', async t => {
  const { project } = fixture(t);
  await workItemOperation('create', definition, { project });
  const original = WorkItemStore.prototype.publish;
  t.after(() => { WorkItemStore.prototype.publish = original; });
  WorkItemStore.prototype.publish = function () { const err = new Error('hard links unsupported'); err.code = 'ENOTSUP'; throw err; };
  let launches = 0;
  let result = await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async () => { launches++; } });
  assert.equal(result.error.code, 'storage_error');
  assert.equal(launches, 0);
  WorkItemStore.prototype.publish = function (...args) { original.apply(this, args); const err = new Error('lost publication acknowledgement'); err.code = 'EIO'; throw err; };
  result = await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async () => { launches++; } });
  assert.equal(result.item.job.outcome, 'unconfirmed_start');
  const session = result.item.job.sessionId;
  WorkItemStore.prototype.publish = original;
  result = await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async () => { launches++; } });
  assert.equal(result.item.job.sessionId, session);
  assert.equal(launches, 0);
});

test('list skips unpublished directories and never reads the capture artifact body', async t => {
  const { project } = fixture(t);
  await workItemOperation('create', definition, { project });
  await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async () => {} });
  const store = new WorkItemStore(project);
  const intent = store.read(definition.id, 2);
  const dir = join(store.base, intent.sessionId);
  mkdirSync(dir);
  const artifact = join(dir, 'output.txt');
  writeFileSync(artifact, 'saved');
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: intent.sessionId, workItemId: definition.id, mode: 'delegate', participant: { team: { id: 'dev' } }, deadlineAt: new Date(Date.now() + 10000).toISOString(), state: 'completed', deliveryState: 'acknowledged', result: { output: 'saved', artifactPath: artifact } }));
  mkdirSync(join(store.dir, 'wi-unpublished'));
  mkdirSync(join(store.dir, 'wi-broken'));
  writeFileSync(join(store.dir, 'wi-broken', '00000002.json'), '{}');
  const original = fs.readFileSync;
  fs.readFileSync = function (path, ...args) { if (String(path) === artifact) throw new Error('capture body was read'); return original.call(this, path, ...args); };
  syncBuiltinESMExports();
  try {
    const result = await workItemOperation('list', {}, { project });
    assert.deepEqual(result.errors.map(error => error.id), ['wi-broken']);
    assert.equal(result.items[0].state, 'result_ready');
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test('CLI and MCP start Team jobs with the canonical project, including through an alias', async t => {
  const { parent, project } = fixture(t);
  const alias = join(parent, 'project-alias');
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const moduleUrl = new URL('../lib/jobs.js', import.meta.url).href;
  const preload = join(parent, 'intercept.mjs');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs'; import { JobManager } from ${JSON.stringify(moduleUrl)}; JobManager.prototype.startJob = async function (options) { writeFileSync(process.env.WORK_ITEM_TEST_MARKER, JSON.stringify({ cwd: this.cwd, options })); return { success: true }; };`);
  const marker = join(parent, 'marker.json');
  const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], {
    cwd: parent, encoding: 'utf8', env: { ...process.env, HC_TERMINAL_ID: '', WORK_ITEM_TEST_MARKER: marker }
  });
  const create = id => run(['work-item', 'create', '--project', alias, '--input-json', JSON.stringify({ ...definition, id })]);
  const firstCreate = create('wi-cli-alias');
  assert.equal(firstCreate.status, 0, firstCreate.stderr);
  const delegated = run(['work-item', 'delegate', '--project', alias, '--id', 'wi-cli-alias']);
  assert.equal(delegated.status, 0, delegated.stderr);
  let saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(saved.cwd, realpathSync.native(project));
  assert.equal(saved.options.workItemId, 'wi-cli-alias');
  const secondCreate = create('wi-mcp-alias');
  assert.equal(secondCreate.status, 0, secondCreate.stderr);
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'council_work_item_delegate', arguments: { project: alias, id: 'wi-mcp-alias' }
  } });
  const mcp = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'mcp'], {
    cwd: parent, input: frame + '\n', encoding: 'utf8', env: { ...process.env, HC_TERMINAL_ID: '', WORK_ITEM_TEST_MARKER: marker }
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(JSON.parse(mcp.stdout).result.isError, false);
  saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(saved.cwd, realpathSync.native(project));
  assert.equal(saved.options.workItemId, 'wi-mcp-alias');
});

test('artifact references cannot use an external file or a link within the job', async t => {
  const { parent, project } = fixture(t);
  await workItemOperation('create', definition, { project });
  await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async () => {} });
  const store = new WorkItemStore(project);
  const intent = store.read(definition.id, 2);
  const dir = join(store.base, intent.sessionId);
  mkdirSync(dir);
  const real = join(dir, 'real');
  const linked = join(dir, 'linked');
  mkdirSync(real);
  writeFileSync(join(real, 'output.txt'), 'saved');
  symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const external = join(parent, 'external.txt');
  writeFileSync(external, 'outside');
  for (const artifactPath of [external, join(linked, 'output.txt')]) {
    writeFileSync(join(dir, 'job.json'), JSON.stringify({
      $schema: 'council.job/v1', sessionId: intent.sessionId, workItemId: definition.id, mode: 'delegate',
      participant: { team: { id: 'dev' }, address: 't1' }, deadlineAt: new Date(Date.now() + 10000).toISOString(),
      state: 'completed', deliveryState: 'acknowledged', result: { output: 'saved', artifactPath }
    }));
    const shown = await workItemOperation('show', { id: definition.id }, { project });
    assert.equal(shown.item.attention.code, 'integrity_error');
    assert.equal(shown.item.job.linked, false);
    assert.equal(shown.item.result, null);
  }
});

test('CLI and MCP report injected OS publication failures using contract error codes', t => {
  const { parent, project } = fixture(t);
  const preload = join(parent, 'storage-failure.mjs');
  const storeUrl = new URL('../herdr/mods/council/runtime/work-item-store.mjs', import.meta.url).href;
  writeFileSync(preload, `import { WorkItemStore } from ${JSON.stringify(storeUrl)}; WorkItemStore.prototype.publish = function () { const error = new Error('injected'); error.code = process.env.WORK_ITEM_TEST_ERROR; throw error; };`);
  for (const code of ['EACCES', 'EPERM', 'ENOTSUP']) {
    const env = { ...process.env, WORK_ITEM_TEST_ERROR: code };
    const args = ['--import', pathToFileURL(preload).href, cli];
    const child = spawnSync(process.execPath, [...args, 'work-item', 'create', '--project', project, '--input-json', JSON.stringify(definition)], { cwd: parent, env, encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.equal(JSON.parse(child.stdout).error.code, 'storage_error');
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'council_work_item_create', arguments: { project, ...definition } } });
    const mcp = spawnSync(process.execPath, [...args, 'mcp'], { cwd: parent, env, input: frame + '\n', encoding: 'utf8' });
    assert.equal(mcp.status, 0, mcp.stderr);
    const response = JSON.parse(mcp.stdout).result;
    assert.equal(response.isError, true);
    assert.equal(JSON.parse(response.content[0].text).error.code, 'storage_error');
  }
});

test('invalid UTF-8 in a definition is reported as integrity_error', async t => {
  const { project } = fixture(t);
  await workItemOperation('create', definition, { project });
  const store = new WorkItemStore(project);
  const path = join(store.dir, definition.id, '00000001.json');
  writeFileSync(path, Buffer.from([0xff]));

  const shown = await workItemOperation('show', { id: definition.id }, { project });
  assert.equal(shown.error.code, 'integrity_error');
  const listed = await workItemOperation('list', {}, { project });
  assert.equal(listed.errors[0].code, 'integrity_error');
  assert.equal(listed.errors[0].id, definition.id);
  const cliResult = spawnSync(process.execPath, [cli, 'work-item', 'show', '--project', project, '--id', definition.id], { encoding: 'utf8' });
  assert.notEqual(cliResult.status, 0);
  assert.equal(JSON.parse(cliResult.stdout).error.code, 'integrity_error');
  const reply = callMcp(project, [['show', { project, id: definition.id }]]).get(1);
  assert.equal(reply.isError, true);
  assert.equal(JSON.parse(reply.content[0].text).error.code, 'integrity_error');
  assert.deepEqual(fs.readFileSync(path), Buffer.from([0xff]));
});

test('invalid UTF-8 in an intent remains visible and cannot trigger another dispatch', async t => {
  const { parent, project } = fixture(t);
  await workItemOperation('create', definition, { project });
  let launches = 0;
  const options = { project, callTeamMember: async () => { launches++; } };
  await workItemOperation('delegate', { id: definition.id }, options);
  assert.equal(launches, 1);
  const store = new WorkItemStore(project);
  const path = join(store.dir, definition.id, '00000002.json');
  const damaged = Buffer.from([0xff]);
  writeFileSync(path, damaged);

  for (const operation of ['show', 'delegate']) {
    const result = await workItemOperation(operation, { id: definition.id }, options);
    assert.equal(result.success, true);
    assert.equal(result.item.state, 'needs_attention');
    assert.equal(result.item.attention.code, 'integrity_error');
    assert.equal(result.item.canDelegate, false);
  }
  const listed = await workItemOperation('list', {}, options);
  assert.equal(listed.items[0].state, 'needs_attention');
  assert.equal(listed.items[0].attention.code, 'integrity_error');
  assert.deepEqual(listed.errors, []);
  const marker = join(parent, 'unexpected-dispatch');
  const preload = join(parent, 'prevent-dispatch.mjs');
  const jobsUrl = new URL('../lib/jobs.js', import.meta.url).href;
  writeFileSync(preload, `import { writeFileSync } from 'node:fs'; import { JobManager } from ${JSON.stringify(jobsUrl)}; JobManager.prototype.startJob = async function () { writeFileSync(process.env.WORK_ITEM_TEST_MARKER, 'unexpected'); return { success: false }; };`);
  const calls = callMcp(project, [['show', { project, id: definition.id }], ['list', { project }], ['delegate', { project, id: definition.id }]], {
    nodeArgs: ['--import', pathToFileURL(preload).href], env: { WORK_ITEM_TEST_MARKER: marker }
  });
  for (const response of calls.values()) {
    assert.notEqual(response.isError, true);
    const envelope = JSON.parse(response.content[0].text);
    const item = envelope.item ?? envelope.items[0];
    assert.equal(item.state, 'needs_attention');
    assert.equal(item.attention.code, 'integrity_error');
  }
  assert.equal(launches, 1);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readFileSync(path), damaged);
});

test('a filesystem read error remains a storage_error', async t => {
  const { project } = fixture(t);
  await workItemOperation('create', definition, { project });
  const store = new WorkItemStore(project);
  const target = join(store.dir, definition.id, '00000001.json');
  const original = fs.readFileSync;
  fs.readFileSync = function (path, ...args) {
    if (String(path) === target) {
      const error = new Error('access denied');
      error.code = 'EACCES';
      throw error;
    }
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = await workItemOperation('show', { id: definition.id }, { project });
    assert.equal(result.error.code, 'storage_error');
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
});
