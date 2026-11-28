import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { workItemOperation } from '../lib/work-items.js';

const cli = resolve('bin/council.js');
test('CLI and MCP share triage, frozen review, explicit close, reopen and history', async t => {
  const project = mkdtempSync(join(tmpdir(), 'council-v2-interfaces ü '));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  new TeamStore(project).set({ id: 'dev', agent: 'codex', role: 'Developer' });
  const item = { id: 'wi-cli', title: 'Review', roleId: 'dev', criteria: ['Check it.'] };
  await workItemOperation('create', item, { project });
  await workItemOperation('delegate', { id: item.id }, { project, callTeamMember: async (_manager, call) => {
    const dir = join(project, '.agent_workspace', call.sessionId);
    mkdirSync(dir);
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
      mode: 'delegate', workItemId: item.id, participant: { team: { id: 'dev' } }, state: 'completed',
      deliveryState: 'acknowledged', deadlineAt: new Date(Date.now() + 60000).toISOString(),
      result: { output: 'Handoff', completedAt: new Date().toISOString(), turn: 2 } }));
  } });
  const run = (...args) => {
    const child = spawnSync(process.execPath, [cli, 'work-item', ...args, '--project', project], { encoding: 'utf8' });
    return { status: child.status, body: JSON.parse(child.stdout) };
  };
  const json = value => ['--input-json', JSON.stringify(value)];
  const triaged = run('triage', ...json({ id: item.id, ifRevision: 2, requestId: 'triage', actor: 'Lead', patch: { priority: 'high' } }));
  assert.equal(triaged.status, 0, JSON.stringify(triaged));
  assert.equal(run('list', '--role', 'dev', '--state', 'open', '--sort', 'priority').body.items[0].lifecycle.priority, 'high');
  const started = run('review', 'start', ...json({ id: item.id, ifRevision: 3, requestId: 'review', actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'operator' }));
  assert.equal(started.status, 0, JSON.stringify(started));
  const review = started.body.item.lifecycle.review;
  const closed = run('close', ...json({ id: item.id, ifRevision: 4, requestId: 'close', actor: 'Lead', reviewId: review.id,
    evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Complete.', nextAction: 'Ship.' }));
  assert.equal(closed.status, 0, JSON.stringify(closed));
  const decision = closed.body.item.lifecycle.decision;
  const reopen = run('reopen', ...json({ id: item.id, ifRevision: 5, requestId: 'reopen', actor: 'Lead', decisionId: decision.id,
    snapshotSha256: review.snapshotSha256, reason: 'New work.', roleId: 'dev', nextAction: 'Revisit.' }));
  assert.equal(reopen.status, 0, JSON.stringify(reopen));
  assert.equal(reopen.body.item.lifecycle.cycle, 2);
  assert.equal(run('history', '--id', item.id, '--request-id', 'close').body.receipt.event, 'closed');
  assert.equal(run('show', '--id', item.id, '--review-id', review.id).body.archivedReview.capture.output, 'Handoff');

  const calls = [
    { name: 'council_work_item_show', arguments: { project, id: item.id, reviewId: review.id } },
    { name: 'council_work_item_history', arguments: { project, id: item.id, limit: 1 } },
    { name: 'council_work_item_list', arguments: { project, lifecycleState: 'open', roleId: 'dev' } }
  ];
  const frames = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ...calls.map((params, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params }))];
  const child = spawnSync(process.execPath, [cli, 'mcp'], { cwd: project, env: { ...process.env, COUNCIL_MCP_REQUIRE_PROJECT: '1' }, input: frames.join('\n') + '\n', encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const responses = new Map(child.stdout.trim().split(/\r?\n/).map(line => { const value = JSON.parse(line); return [value.id, value.result]; }));
  const names = new Set(responses.get(1).tools.map(tool => tool.name));
  for (const name of ['triage', 'review', 'close', 'reopen', 'history']) assert.ok(names.has(`council_work_item_${name}`));
  assert.equal(JSON.parse(responses.get(2).content[0].text).archivedReview.capture.output, 'Handoff');
  assert.equal(JSON.parse(responses.get(3).content[0].text).events[0].type, 'reopened');
  assert.equal(JSON.parse(responses.get(4).content[0].text).items[0].lifecycle.cycle, 2);
});

test('CLI and MCP v2 delegation use the existing Team job and a simulated worker', async t => {
  const { pathToFileURL } = await import('node:url');
  const project = mkdtempSync(join(tmpdir(), 'council-v2-delegate-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  new TeamStore(project).set({ id: 'dev', agent: 'codex', role: 'Developer', permission: 'write' });
  const jobs = new URL('../lib/jobs.js', import.meta.url).href;
  const worker = new URL('../lib/job-worker.js', import.meta.url).href;
  const preload = join(project, 'fixture-preload.mjs');
  writeFileSync(preload, `import { JobManager } from ${JSON.stringify(jobs)}; import { JobWorker } from ${JSON.stringify(worker)};
    const original = JobManager.prototype.startJob;
    JobManager.prototype.startJob = function(options) { this.workerLauncher = async ({sessionDir}) => {
      const worker = new JobWorker({ sessionDir, herdr: {
        launchAgent: () => ({success:true,address:'t1',identity:{pid:10,createdMs:20},baselineTurn:0}),
        wait: () => ({success:true,terminal:'t1',ended:true,reason:'status',status:'done',turn:1}),
        captureTurn: () => ({success:true,content:'Simulated handoff',captureScope:'turn'}),
        stopCompletedTeamTurn: () => ({success:true})
      }});
      if (!(await worker.execute()).success) throw new Error('Fixture worker failed');
      return {success:true};
    }; return original.call(this, options); };`);
  const args = ['--import', pathToFileURL(preload).href, cli];
  const make = id => workItemOperation('create', { id, title: 'Test', roleId: 'dev', criteria: ['Check'] }, { project });
  assert.equal((await make('wi-cli-v2')).success, true);
  const cliResult = spawnSync(process.execPath, [...args, 'work-item', 'delegate', '--id', 'wi-cli-v2', '--if-revision', '1',
    '--request-id', 'cli-delegate', '--actor', 'Lead', '--project', project], { cwd: project, encoding: 'utf8' });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  const item = JSON.parse(cliResult.stdout).item;
  assert.equal(item.state, 'result_ready');
  assert.equal(item.result.output, 'Simulated handoff');
  assert.equal(item.lifecycle.revision, 2);
  assert.equal(item.job.linked, true);
  assert.equal((await make('wi-mcp-v2')).success, true);
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'council_work_item_delegate',
    arguments: { project, id: 'wi-mcp-v2', ifRevision: 1, requestId: 'mcp-delegate', actor: 'Lead' } } });
  const mcp = spawnSync(process.execPath, [...args, 'mcp'], { cwd: project, input: frame + '\n', encoding: 'utf8' });
  assert.equal(mcp.status, 0, mcp.stderr);
  const result = JSON.parse(JSON.parse(mcp.stdout).result.content[0].text);
  assert.equal(result.item.state, 'result_ready');
  assert.equal(result.item.result.source, 'terminal_screen');
  assert.equal(result.item.job.linked, true);
});
