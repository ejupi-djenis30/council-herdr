import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareTask, submitTask, taskFormDefaults, taskFormValues } from '../herdr/mods/council/task-launch.js';
import { alignmentKey, alignmentLabel } from '../herdr/mods/council/runtime/alignment.mjs';

const install = fileURLToPath(new URL('../herdr/install.js', import.meta.url));

function run(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 10000 });
}

function environment(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'council desktop ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appHome = join(root, 'app profile');
  const project = join(root, 'sample worktree');
  mkdirSync(appHome);
  mkdirSync(project);
  return { root, appHome, project, mod: join(appHome, 'mods', 'council') };
}

test('a fresh install bundles an independent runtime and preserves a conflicting binding', t => {
  const { appHome, project, mod } = environment(t);
  const keysFile = join(appHome, 'keys.json');
  const original = '{"global":{"shift-f8":"tab.new"}}\n';
  writeFileSync(keysFile, original);

  const installed = run([install, '--app-home', appHome, '--shortcut'], project);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stderr, /Shortcut skipped/);
  assert.equal(readFileSync(keysFile, 'utf8'), original);
  const config = JSON.parse(readFileSync(join(mod, 'config.json'), 'utf8'));
  assert.deepEqual(config, { node: process.execPath });
  assert.match(readFileSync(join(mod, 'icons', 'logo.svg'), 'utf8'), /<svg/);
  assert.ok(existsSync(join(mod, 'navigation.js')));

  const standalone = join(mod, 'runtime', 'council.mjs');
  const created = run([standalone, 'poll', 'create', '--mode', 'open', '--question', 'Ready?'], project);
  assert.equal(created.status, 0, created.stderr);
  const { id } = JSON.parse(created.stdout);
  const desktop = run([standalone, 'desktop', 'vote', JSON.stringify({ id, answer: 'Ready for review.' })], project);
  assert.equal(desktop.status, 0, desktop.stderr);
  assert.equal(JSON.parse(desktop.stdout).responses[0].answer, 'Ready for review.');
  const duplicate = run([install, '--app-home', appHome], project);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already exists/);
});

test('Desktop starts each workflow and a Team turn through its installed engine and recovers a lost acknowledgement', async t => {
  const { root, appHome, project, mod } = environment(t);
  const installed = run([install, '--app-home', appHome], project);
  assert.equal(installed.status, 0, installed.stderr);
  const cli = join(mod, 'engine', 'bin', 'council.js');
  const log = join(root, 'worker-launches');
  const stub = join(root, 'mock-hc.mjs');
  writeFileSync(stub, `import child from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    child.spawnSync = (command, args) => {
      if (command === 'hc' && args[0] === 'get' && args[1] === 't700') {
        return { status: 0, stdout: process.env.COUNCIL_TEST_TERMINAL, stderr: '' };
      }
      if (command !== 'hc' || args[0] !== 'run') throw Error('Unexpected command ' + command);
      appendFileSync(process.env.COUNCIL_TEST_LAUNCH_LOG, JSON.stringify(args) + '\\n');
      return { status: 0, stdout: '{"address":"t900"}', stderr: '' };
    };
    syncBuiltinESMExports();`);
  const terminal = { address: 't700', state: 'live', reported: true, pid: 7, created_ms: 101, turn: 4,
    status: { state: 'idle', app: 'junie' } };
  terminal.labels = { [alignmentKey]: alignmentLabel(terminal, 'aligned').split('=')[1] };
  const dispatch = args => {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, cli, ...args], {
      cwd: project, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HC_TERMINAL_ID: '', COUNCIL_TEST_LAUNCH_LOG: log, COUNCIL_TEST_TERMINAL: JSON.stringify(terminal) }
    });
    return { code: child.status, stdout: child.stdout, stderr: child.stderr };
  };
  const desktop = (action, request) => {
    const result = run([join(mod, 'runtime', 'council.mjs'), 'desktop', action, JSON.stringify(request)], project);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const match = request => desktop('task-match', request);
  const prefix = '--inspect the parser '.repeat(125);
  const task = { sessionId: 'desktop-inspect', agent: 'junie', permission: 'read', task: prefix + 'today', timeout: '360' };
  assert.equal(await submitTask(task, dispatch, match), task.sessionId);
  assert.equal(await submitTask(task, dispatch, match), task.sessionId);
  assert.equal(desktop('delegations', { id: task.sessionId }).delegation.task, task.task.slice(0, 2400));
  const changed = { ...task, task: prefix + 'tomorrow' };
  let lookups = 0;
  await assert.rejects(submitTask(changed, dispatch, () => { lookups++; return { matches: true }; }),
    error => /fingerprint mismatch/.test(error.message) && !error.message.includes('Retrying'));
  assert.equal(lookups, 0, 'an explicit conflict reaches the operator directly');
  const disconnected = () => { throw Error('Disconnected.'); };
  assert.equal(await submitTask(task, disconnected, match), task.sessionId);
  for (const other of [changed, { ...task, permission: 'write' }, { ...task, timeout: '30' }, { ...task, agent: 'claude' }]) {
    await assert.rejects(submitTask(other, disconnected, match), /Disconnected.*desktop-inspect/);
  }
  assert.equal(dispatch(['team', 'set', 'qa', '--agent', 'claude', '--permission', 'write', '--model', 'custom', '--role', 'QA']).code, 0);
  const call = { ...task, sessionId: 'desktop-qa', member: 'qa', task: '--phase=review '.padEnd(11999, 'x') + '.' };
  assert.equal(await submitTask(call, args => {
    assert.equal(dispatch(args).code, 0);
    throw Error('Launcher timed out after saving the job.');
  }, match), call.sessionId);
  await assert.rejects(submitTask({ ...call, timeout: '30' }, disconnected, match), /Disconnected/);
  await assert.rejects(submitTask({ ...call, member: 'other' }, disconnected, match), /Disconnected/);
  const saved = JSON.parse(readFileSync(join(project, '.agent_workspace', call.sessionId, 'job.json'), 'utf8'));
  assert.equal(saved.timeoutSec, 360);
  assert.equal(saved.task, call.task);
  assert.equal(saved.agent, 'claude');
  assert.equal(saved.permission, 'write');
  assert.equal(saved.participant.team.model, 'custom');
  const borrowed = { ...task, sessionId: 'desktop-adopt', adopt: 't700' };
  assert.equal(await submitTask(borrowed, dispatch, match), borrowed.sessionId);
  assert.equal(await submitTask(borrowed, disconnected, match), borrowed.sessionId);
  await assert.rejects(submitTask({ ...borrowed, adopt: 't701' }, disconnected, match), /Disconnected/);
  await assert.rejects(submitTask({ ...borrowed, adopt: undefined }, disconnected, match), /Disconnected/);
  const adopted = desktop('delegations', { id: borrowed.sessionId }).delegation;
  assert.equal(adopted.ownership, 'borrowed');
  assert.equal(adopted.agent, 'junie');
  assert.equal(adopted.participantCreatedMs, terminal.created_ms);
  for (const mode of ['council', 'review', 'debate', 'parallel', 'pipeline']) {
    const { fields, extra } = taskFormDefaults(mode);
    Object.assign(fields, { task: '  Improve build verification  ', context: '--build details', criteria: 'No lost results',
      assignment1: 'Inspect tests', assignment2: 'Review saved runs', stageTask1: 'Gather evidence' });
    const form = { ...extra, sessionId: 'desktop-' + mode,
      ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { value: () => value }])) };
    form.roleAgents[1] = 'junie';
    form.assignments[1].agent = 'junie';
    form.representatives.council = 'council-skeptic';
    form.stages.reverse();
    form.keepTerminals = true;
    const settings = taskFormValues(form);
    const session = await submitTask(settings, args => {
      assert.equal(dispatch(args).code, 0);
      throw Error('Acknowledgement lost.');
    }, match);
    assert.equal(session, form.sessionId);
    assert.equal(await submitTask(settings, dispatch, match), session);
    const job = JSON.parse(readFileSync(join(project, '.agent_workspace', session, 'job.json')));
    assert.equal(job.mode, mode);
    assert.equal(job.permission, 'read');
    assert.equal(job.keepTerminals, true);
    assert.equal(job.task, 'Improve build verification');
    assert.equal(job.workflow.context, '--build details');
    assert.equal(job.workflow.criteria, 'No lost results');
    assert.equal(desktop('delegations', { id: session }).delegation.workflowSessionId, job.workflow.sessionId);
    const edits = [{ criteria: 'New decision criteria' }, { keepTerminals: false }];
    if (mode === 'parallel') {
      assert.deepEqual(job.workflow.agents, ['claude', 'junie']);
      assert.deepEqual(job.workflow.subtasks, ['Inspect tests', 'Review saved runs']);
      edits.push({ subtasks: ['Inspect docs', 'Review saved runs'] });
    } else if (mode === 'pipeline') {
      assert.deepEqual(job.workflow.stages.map(stage => stage.name), ['Verification', 'Implementation plan', 'Research']);
      assert.equal(job.workflow.stages[0].role, 'reviewer');
      assert.equal(job.workflow.stages[2].task, 'Gather evidence');
      edits.push({ stages: [...settings.stages].reverse(), agents: [...settings.agents].reverse() });
    } else {
      assert.deepEqual(job.workflow.agents, ['claude', 'junie', 'antigravity']);
      edits.push({ agents: ['claude', 'codex', 'antigravity'] });
      if (mode === 'council') {
        assert.equal(job.workflow.representative, 'council-skeptic');
        edits.push({ representative: 'council-author' });
      }
    }
    for (const edit of edits) {
      await assert.rejects(submitTask({ ...settings, ...edit }, disconnected, match), /Disconnected/);
    }
  }
  const launches = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(launches.length, 8);
  assert.ok(launches.every(args => args.includes(join(mod, 'engine', 'lib', 'job-worker.js'))));
});

test('an unconfirmed Desktop submission preserves its session ID and rejects invalid briefs locally', async () => {
  const task = { sessionId: 'desktop-parse', task: 'Inspect parser', agent: 'junie', permission: 'read', timeout: '180' };
  let calls = 0;
  const dispatch = () => { calls++; throw Error('Transport disconnected.'); };
  const noRecord = request => { assert.equal(request.sessionId, task.sessionId); return { matches: false }; };
  await assert.rejects(submitTask(task, dispatch, noRecord), /Transport disconnected.*desktop-parse.*same session/);
  await assert.rejects(submitTask({ ...task, task: ' ' }, dispatch, noRecord), /Enter a task/);
  await assert.rejects(submitTask({ ...task, timeout: '-1' }, dispatch, noRecord), /deadline/);
  assert.throws(() => prepareTask({ ...task, mode: 'debate', agents: ['junie'] }), /three roles/);
  assert.throws(() => prepareTask({ ...task, mode: 'parallel', agents: ['junie'], subtasks: ['  '] }), /each parallel assignment/);
  assert.throws(() => prepareTask({ ...task, mode: 'pipeline', agents: ['junie'], stages: [{ name: '' }] }), /name for stage 1/);
  assert.throws(() => prepareTask({ ...task, mode: 'unknown' }), /supported workflow/);
  assert.throws(() => prepareTask({ ...task, adopt: 'other/t123' }), /on this host/);
  assert.throws(() => prepareTask({ ...task, adopt: '' }), /on this host/);
  assert.equal(calls, 1);
});

test('managed upgrades retain the previous build and refuse local edits', t => {
  const { appHome, project, mod } = environment(t);
  const args = [install, '--app-home', appHome];
  const fresh = run(args, project);
  assert.equal(fresh.status, 0, fresh.stderr);
  const bytes = readFileSync(join(mod, 'main.js'));
  writeFileSync(join(mod, 'jsconfig.json'), '{}');

  const upgraded = run([...args, '--upgrade'], project);
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const backups = join(appHome, 'council-backups');
  const [backup] = readdirSync(backups);
  assert.deepEqual(readFileSync(join(backups, backup, 'council', 'main.js')), bytes);
  assert.ok(existsSync(resolve(mod, 'runtime', 'council.mjs')));

  const customized = Buffer.concat([bytes, Buffer.from('\n// Local theme tweak\n')]);
  writeFileSync(join(mod, 'main.js'), customized);
  const refused = run([...args, '--upgrade'], project);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /local changes/);
  assert.deepEqual(readFileSync(join(mod, 'main.js')), customized);
  assert.equal(readdirSync(backups).length, 1);
});

test('the menu is inserted once in the selected personal layout and preserves its original bytes in a backup', t => {
  const { appHome, project } = environment(t);
  const layouts = join(appHome, 'layouts');
  mkdirSync(layouts);
  const shared = '{"layout":"daily-work","theme":"graphite"}\n';
  writeFileSync(join(appHome, 'shared.json'), shared);
  const layout = {
    id: 'root', type: 'row', background: 'canvas', children: [
      { id: 'sidebar', type: 'column', size: { px: 268 }, children: [
        { id: 'brand', type: 'block', content: { mod: 'workspace-chrome' } },
        { id: 'spaces', type: 'block', content: { mod: 'spaces' } }
      ] },
      { id: 'main', type: 'block', content: { tab: 'active' } }
    ]
  };
  const original = JSON.stringify(layout) + '\r\n';
  const path = join(layouts, 'daily-work.json');
  writeFileSync(path, original);
  const args = [install, '--app-home', appHome, '--menu'];
  const installed = run(args, project);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Council menu added to layout "daily-work"/);
  const modified = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(modified.children[0].children.splice(1, 1), [{
    id: 'council-menu', type: 'block', size: { px: 44 }, content: { mod: 'council', props: { role: 'launcher' } }
  }]);
  assert.deepEqual(modified, layout);
  const backups = join(appHome, 'council-backups');
  const [archive] = readdirSync(backups);
  assert.equal(readFileSync(join(backups, archive, 'daily-work.json'), 'utf8'), original);

  const installedLayout = readFileSync(path, 'utf8');
  const repeated = run([...args, '--upgrade'], project);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(path, 'utf8'), installedLayout);
  assert.equal(readFileSync(join(appHome, 'shared.json'), 'utf8'), shared);
  assert.equal(readdirSync(backups).filter(entry => entry.startsWith('layout-')).length, 1);
});

test('menu installation clones a shipped layout and preserves an existing conflicting clone', t => {
  const { appHome, project } = environment(t);
  const layouts = join(appHome, 'layouts');
  mkdirSync(layouts);
  const original = '{"id":"root","type":"column","children":[{"id":"tabs","type":"block","content":{"mod":"terminals-bar"}}]}\n';
  const path = join(layouts, 'terminals.json');
  const clone = join(layouts, 'council-terminals.json');
  writeFileSync(path, original);
  const args = [install, '--app-home', appHome, '--menu', '--layout', 'terminals'];
  const installed = run(args, project);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /layout.switch --name council-terminals/);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.deepEqual(JSON.parse(readFileSync(clone, 'utf8')).children.map(node => node.id), ['tabs', 'council-menu']);
  const conflicting = '{"id":"root","type":"block","content":{"mod":"spaces"}}\n';
  writeFileSync(clone, conflicting);

  const refused = run([...args, '--upgrade'], project);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  assert.equal(readFileSync(clone, 'utf8'), conflicting);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(existsSync(join(appHome, 'council-backups')), false);
});
