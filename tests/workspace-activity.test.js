import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseGitStatus, readGitActivity } from '../herdr/mods/council/runtime/activity-git.mjs';
import { attachPlanChanges, parsePlan } from '../herdr/mods/council/runtime/activity-plan.mjs';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { PollStore } from '../herdr/mods/council/runtime/polls.mjs';
import { JobManager } from '../lib/jobs.js';
import { JobWorker } from '../lib/job-worker.js';
import { CouncilMcpServer } from '../lib/mcp-server.js';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/council.js', import.meta.url));

function project(t) {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'council-activity-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

const plan = [
  '# Release plan',
  '## Parser {#parser}',
  'files: [src/parser/**, src/parse?.js]',
  'needs: [rollout, missing]',
  '- [X] Recover file {#recover}',
  '  by: qa',
  '  evidence: src/parser/recovery.js',
  '~~~~',
  '## Fake {#fake}',
  '- [x] Exclude examples',
  '~~~~',
  '## Rollout {#rollout}',
  'kind: human',
  'needs: [parser]',
  '- [!] Ask for sign-off',
  '## decisions',
  '- Keep the fallback.'
].join('\r\n');

test('plan recognizes stable components, provenance and dependencies without treating code examples as tasks', () => {
  const parsed = parsePlan(plan);
  assert.equal(parsed.title, 'Release plan');
  assert.deepEqual(parsed.components.map(item => item.id), ['parser', 'rollout']);
  assert.deepEqual(parsed.components[0].tasks[0], { id: 'recover', title: 'Recover file', state: 'done', by: 'qa',
    evidence: 'src/parser/recovery.js', from: null });
  assert.equal(parsed.components[1].kind, 'human');
  assert.equal(parsed.components[1].tasks[0].state, 'blocked');
  assert.deepEqual(parsed.decisions, ['Keep the fallback.']);
  assert.match(parsed.issues.join(' '), /unknown components: missing.*Dependency cycle/i);
  assert.deepEqual(parsed.layers, [{ kind: 'unresolved', ids: ['parser', 'rollout'] }]);
  const paths = ['src/parser/recovery.js', 'src/parser/fixtures/edge.js', 'src/parse1.js', 'src/parse12.js', 'src/other.js']
    .map(path => ({ path, flag: ' M' }));
  const result = attachPlanChanges(parsed, paths);
  assert.deepEqual(result.components[0].changes.map(item => item.path), paths.slice(0, 3).map(item => item.path));
  assert.equal(result.components[0].tasks[0].state, 'done', 'a change does not rewrite planned status');
  assert.equal(Object.hasOwn(result.components[0].changes[0], 'author'), false);
});

test('plan dependency lanes respect the graph and glob matches include renamed paths', () => {
  const declared = parsePlan([
    '## Release {#release}', 'needs: [test]',
    '## Test {#test}', 'needs: [source]', 'files: [test/**/case*?.js]',
    '## Source {#source}', 'files: [src/**]',
    '```` markdown', '```', '## Example {#fake}', '````'
  ].join('\n'));
  assert.deepEqual(declared.layers, [
    { kind: 'independent', ids: ['source'] }, { kind: 'dependent', ids: ['test'] },
    { kind: 'dependent', ids: ['release'] }
  ]);
  const files = [
    { path: 'test/fixtures/case1.js', previous: 'src/case.js', flag: 'R ' },
    { path: 'test/case.js', previous: null, flag: ' M' }
  ];
  const view = attachPlanChanges(declared, files);
  assert.deepEqual(view.components[1].changes, [files[0]]);
  assert.deepEqual(view.components[2].changes, [files[0]]);
});

test('Git activity pairs rename paths and scopes working-tree evidence to the selected folder', t => {
  assert.deepEqual(parseGitStatus('## main\0R  src/new name.js\0src/old name.js\0?? src/temp.js\0 M README.md\0', 'src/'), {
    branch: 'main', total: 2, clipped: false,
    files: [{ flag: 'R ', path: 'new name.js', previous: 'old name.js' }, { flag: '??', path: 'temp.js', previous: null }]
  });
  const cwd = project(t);
  git(cwd, 'init', '-q');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'parser.js'), 'parser\n');
  writeFileSync(join(cwd, 'README.md'), 'readme\n');
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial project');
  writeFileSync(join(cwd, 'src', 'parser.js'), 'new parser\n');
  writeFileSync(join(cwd, 'README.md'), 'new readme\n');
  const view = readGitActivity(join(cwd, 'src'));
  assert.equal(view.statusAvailable, true);
  assert.deepEqual(view.files.map(item => item.path), ['parser.js']);
  assert.equal(view.commits[0].subject, 'Initial project');
  assert.ok(view.worktrees.length);
});

test('focus follows the owning project without crossing a pinned folder, space, or nested Git boundary', async t => {
  const cwd = project(t);
  git(cwd, 'init', '-q');
  writeFileSync(join(cwd, 'PLAN.md'), plan);
  const component = join(cwd, 'packages', 'parser');
  const focused = join(component, 'src');
  mkdirSync(focused, { recursive: true });
  const manager = new JobManager({ cwd, herdr: {}, workerLauncher: () => ({ success: true }) });
  await manager.startJob({ sessionId: 'repo-task', task: 'Check the root project' });
  const follow = (folder, spaceFolder = cwd) => desktopRequest(folder, 'activity', { followFocus: true, spaceFolder });
  const view = follow(focused);
  assert.equal(view.folder, focused);
  assert.equal(view.project, cwd);
  assert.equal(view.runs[0].id, 'repo-task');
  assert.equal(view.plan.title, 'Release plan');
  assert.equal(desktopRequest(focused, 'activity', {}).project, focused, 'explicit folder reads remain exact');
  assert.equal(follow(focused, component).project, component, 'the active space can bound traversal within a Git repository');
  assert.equal(follow(focused, join(cwd, 'removed')).project, cwd, 'a removed space folder leaves the active Git project readable');
  git(component, 'init', '-q');
  assert.equal(follow(focused).project, component, 'a nested Git root establishes a separate project');
  assert.deepEqual(follow(focused).runs, []);
  writeFileSync(join(focused, 'PLAN.md'), '# Isolated plan\n');
  assert.equal(follow(focused).project, focused, 'a plan at the focused folder takes precedence');
});

test('workspace joins Council jobs and decisions with local progress instead of treating notes as outcomes', async t => {
  const cwd = project(t);
  writeFileSync(join(cwd, 'PLAN.md'), plan);
  const manager = new JobManager({ cwd, herdr: {}, workerLauncher: () => ({ success: true }) });
  await manager.startJob({ sessionId: 'parent-call', task: 'Prepare the release', team: { id: 'lead' } });
  await manager.startJob({ sessionId: 'child-call', task: 'Check parser', team: { id: 'qa' }, teamSource: 'parent-call' });
  new PollStore(cwd).create({ question: 'Ship the release?', mode: 'choice', options: ['Ship', 'Hold'] });
  const path = join(cwd, '.agent_workspace', 'child-call', 'job.json');
  const before = readFileSync(path);
  const server = new CouncilMcpServer({ cwd });
  let response;
  server.herdr.terminalId = 't-example';
  server.send = message => { response = message; };
  const call = async (name, args) => {
    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };
  await call('council_report_progress', {
    sessionId: 'child-call', state: 'blocked', text: 'Waiting for a fixture.', component: 'parser'
  });
  assert.deepEqual(readFileSync(path), before);
  const overview = await call('council_activity', {});
  assert.deepEqual(overview.counts, { active: 2, attention: 0, ready: 0 });
  assert.deepEqual(overview.decisions.map(item => item.question), ['Ship the release?']);
  assert.equal(overview.runs.find(job => job.id === 'child-call').related.parent.id, 'parent-call');
  assert.equal(overview.plan.components[0].reports[0].reporter, 't-example');
  assert.equal(overview.plan.components[0].reports[0].state, 'blocked');
  const detail = desktopRequest(cwd, 'activity', { id: 'parent-call' }).delegation;
  assert.equal(detail.related.children[0].id, 'child-call');
  assert.equal(detail.timeline.history, 'recorded');
  assert.throws(() => desktopRequest(cwd, 'activity-report', { sessionId: '../outside', text: 'Escape' }), /session ID/);
  assert.throws(() => desktopRequest(cwd, 'activity-report', {
    sessionId: 'child-call', text: 'Other component', component: 'not-in-this-plan'
  }), /PLAN.md/);
});

test('new delegation records show the delivery and capture milestones while old sessions show a summary', async t => {
  const cwd = project(t);
  const manager = new JobManager({ cwd, herdr: {}, workerLauncher: () => ({ success: true }) });
  await manager.startJob({ sessionId: 'inspect-sample', task: 'Inspect fixture' });
  const sessionDir = join(cwd, '.agent_workspace', 'inspect-sample');
  const worker = new JobWorker({ sessionDir, herdr: {
    launchAgent: () => ({ success: true, address: 't-owned', baselineTurn: 2 }),
    wait: () => ({ success: true, terminal: 't-owned', ended: true, reason: 'status', status: 'done', turn: 3 }),
    captureTurn(address, turn) {
      assert.equal(address, 't-owned');
      assert.equal(turn, 3);
      return { success: true, content: 'Evidence available.' };
    },
    dismiss: () => ({ success: true })
  } });
  assert.equal((await worker.execute()).success, true);
  const select = () => desktopRequest(cwd, 'activity', { id: 'inspect-sample' }).delegation;
  assert.deepEqual(select().timeline.entries.map(item => item.kind), ['scheduled', 'claimed', 'dispatched', 'terminal', 'delivered', 'captured']);
  const path = join(sessionDir, 'job.json');
  const { timeline: _timeline, ...legacy } = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify(legacy));
  assert.equal(select().timeline.history, 'summary');
  assert.deepEqual(select().timeline.entries.map(item => item.kind), ['scheduled', 'delivered', 'captured']);
});

test('progress retries with a stable request ID save one note across concurrent writers', async t => {
  const cwd = project(t);
  const planPath = join(cwd, 'PLAN.md');
  writeFileSync(planPath, plan);
  const manager = new JobManager({ cwd, herdr: {}, workerLauncher: () => ({ success: true }) });
  await manager.startJob({ sessionId: 'retry-note', task: 'Verify the parser' });
  const args = [entry, 'activity', 'report', '--session', 'retry-note', '--request-id', 'update-1',
    '--component', 'parser', '--text', 'Waiting for a fixture.'];
  const submit = () => run(process.execPath, args, { cwd, windowsHide: true, timeout: 10000 });
  const [first, retry] = await Promise.all([submit(), submit()]);
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(retry.stdout));
  writeFileSync(planPath, '# Plan revised\n');
  assert.deepEqual(JSON.parse((await submit()).stdout), JSON.parse(first.stdout), 'existing receipts survive a project plan edit');
  assert.throws(() => desktopRequest(cwd, 'activity-report', {
    sessionId: 'retry-note', text: 'A different update', requestId: 'update-1'
  }), /already used/);
  assert.equal(desktopRequest(cwd, 'activity', { id: 'retry-note' }).delegation.progress.count, 1);
});

test('a new note brings an older run into Workspace and an unreadable note preserves the last valid update', async t => {
  const cwd = project(t);
  const manager = new JobManager({ cwd, herdr: {}, workerLauncher: () => ({ success: true }) });
  for (let index = 0; index < 19; index++) {
    await manager.startJob({ sessionId: `job-${index}`, task: 'Check the parser' });
  }
  const oldest = join(cwd, '.agent_workspace', 'job-0');
  const jobPath = join(oldest, 'job.json');
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  writeFileSync(jobPath, JSON.stringify({ ...job, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' }));
  const overview = () => desktopRequest(cwd, 'activity', {});
  assert.equal(overview().runs.some(run => run.id === job.sessionId), false);
  desktopRequest(cwd, 'activity-report', { sessionId: job.sessionId, text: 'A fresh handoff' });
  writeFileSync(join(oldest, 'progress', '00000002.json'), '{corrupt}');
  const view = overview();
  assert.equal(view.counts.active, 19);
  assert.equal(view.runs[0].id, job.sessionId);
  assert.equal(view.runs[0].note.text, 'A fresh handoff');
  assert.ok(view.errors.some(issue => issue.detail.includes('unreadable note')));
});
