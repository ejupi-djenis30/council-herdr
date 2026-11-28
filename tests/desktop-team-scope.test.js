import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';

// Load the real Desktop view and builders' callbacks in Node with a small Herdr host substitute.
const hostKey = 'councilDesktopTeamTest';
const hostExports = {
  'gpui-kit': 'View, div, svg',
  'gpui-base': 'Button, h_flex, v_flex, Input, InputState, Textarea, TextareaState',
  herdr: 'agents, appHome, checking, closeOverlay, exec, focused, hc, notify, openOverlay, panes, props, readTextFile, run, spaces, terminals, theme'
};
const hostModules = Object.fromEntries(Object.entries(hostExports).map(([name, exports]) => [
  name, 'data:text/javascript,' + encodeURIComponent(name === 'herdr'
    ? exports.split(', ').map(fn => `export const ${fn} = (...args) => globalThis.${hostKey}.${fn}(...args);`).join('\n')
    : `export const { ${exports} } = globalThis.${hostKey};`)
]));
register('data:text/javascript,' + encodeURIComponent(`
  const modules = ${JSON.stringify(hostModules)};
  export function resolve(specifier, context, next) {
    return Object.hasOwn(modules, specifier)
      ? { url: modules[specifier], shortCircuit: true } : next(specifier, context);
  }
`), import.meta.url);

function element(name = '') {
  const node = { name, nodes: [], click: null };
  const api = {
    child: child => { node.nodes.push(child); return builder; },
    children: children => { node.nodes.push(...children); return builder; },
    id: id => { node.name = id; return builder; },
    on_click: click => { node.click = click; return builder; },
    when: (condition, branch) => condition ? branch(builder) : builder
  };
  const builder = new Proxy(node, { get: (target, key) => key in target ? target[key] : api[key] ?? (() => builder) });
  return builder;
}

function buttonIn(node, id) {
  if (node?.name === id) return node;
  for (const child of node?.nodes ?? []) {
    const found = buttonIn(child, id);
    if (found) return found;
  }
  return null;
}

const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));
const entry = fileURLToPath(new URL('../herdr/mods/council/runtime/council.mjs', import.meta.url));
const task = '--review the selected project';
const profiles = {
  root: { id: 'reviewer', role: 'Space reviewer', agent: 'codex', permission: 'write' },
  nested: { id: 'reviewer', role: 'Nested reviewer', agent: 'claude', model: 'nested-model', permission: 'read' }
};

async function desktop(t, nestedTeam) {
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'council-team-scope-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'space root');
  const nested = join(root, 'nested project');
  mkdirSync(nested, { recursive: true });
  new TeamStore(root).set(profiles.root);
  new TeamStore(nested).set(profiles.nested);

  const dispatchLog = join(temp, 'dispatch.log');
  const stub = join(temp, 'hc-stub.mjs');
  writeFileSync(stub, `import child from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    child.spawnSync = (program, args) => {
      if (program !== 'hc') throw new Error('Unexpected child command');
      if (args[0] === 'get' || args[0] === 'ls') return { status: 0, stdout: '[]', stderr: '' };
      if (args[0] !== 'run') throw new Error('Unexpected hc operation');
      appendFileSync(process.env.COUNCIL_TEAM_SCOPE_LOG, JSON.stringify(args) + '\\n');
      return { status: 0, stdout: '{"address":"t900"}', stderr: '' };
    };
    syncBuiltinESMExports();`);

  const requests = [];
  const space = { id: 'space', folder: root, machine: 'project-peer', active: true, tabs: [] };
  const engine = { node: process.execPath, entry, cli, machine: space.machine };
  let active = space;
  let focusedFolder = nested;
  const state = (initial = '') => {
    let value = initial;
    return { value: () => value, set_value: next => { value = next; }, focus() {}, release() {} };
  };
  const context = { focus_handle: () => state(), notify() {}, spawn: callback => pending.push(callback(context)) };
  const pending = [];
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  Object.assign(globalThis[hostKey] ??= {}, {
    View: class {}, div: element, svg: element, h_flex: element, v_flex: element,
    Button: { new: element }, Input: { new: () => element() }, Textarea: { new: () => element() },
    InputState: { new: options => state(options?.value) }, TextareaState: { new: () => state() },
    checking: () => true, props: () => ({}), theme: () => ({}), spaces: () => [active],
    focused: () => ({ space: active.id, terminal: `${active.machine}/t1`, cwd: focusedFolder }),
    agents: () => [], panes: () => [], terminals: () => [],
    readTextFile: async (path, { on }) => {
      requests.push({ path, on });
      return readFileSync(path, 'utf8');
    },
    exec: async (program, args, options) => {
      requests.push({ args, ...options });
      const subprocess = spawnSync(program, ['--import', pathToFileURL(stub).href, ...args],
        { cwd: options.cwd, timeout: options.timeout, encoding: 'utf8',
          env: { ...process.env, HC_TERMINAL_ID: '', COUNCIL_TEAM_SCOPE_LOG: dispatchLog } });
      if (subprocess.error) throw subprocess.error;
      return { code: subprocess.status, stdout: subprocess.stdout, stderr: subprocess.stderr };
    }
  });
  const { default: Council } = await import('../herdr/mods/council/main.js');
  const view = new Council();
  view.init({}, context);
  Object.assign(view, {
    folder: root, spaceId: space.id, spaceMachine: space.machine, config: engine, engine,
    activitySearch: state(), search: state()
  });
  view.peerEngines.set(space.machine, Promise.resolve(engine));
  const action = id => {
    const button = buttonIn(view.renderContent({}, active), id);
    assert.ok(button, `Missing button ${id}`);
    return () => button.click(null, context);
  };
  const click = id => action(id)();
  if (nestedTeam) {
    // The Work items form last read an empty roster. Its Open Team action refreshes the project roster.
    view.workspace.view = 'work-items';
    view.data = { project: nested, folder: nested, git: {}, errors: [] };
    view.workItems.current = { kind: 'create', scope: { project: nested, engine, space: space.id }, roles: [] };
    click('open-work-item-team');
  } else {
    view.navigate(context, 'team');
  }
  await settle();

  return {
    view, space, engine, root, nested, requests, context, action, click, settle,
    moveFocus: path => { focusedFolder = path; },
    selectMachine: () => { active = { ...space, id: 'other-space', machine: 'other-peer' }; },
    launches: () => existsSync(dispatchLog) ? readFileSync(dispatchLog, 'utf8').trim().split('\n').map(JSON.parse) : [],
    job: (project, id) => {
      const path = join(project, '.agent_workspace', id, 'job.json');
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    }
  };
}

for (const nestedTeam of [true, false]) {
  test(nestedTeam ? 'Work items Team call keeps the nested roster project and peer' : 'normal Team call still uses the space root', async t => {
    const host = await desktop(t, nestedTeam);
    const { view, engine, root, nested, requests } = host;
    const chosen = nestedTeam ? nested : root;
    const other = nestedTeam ? root : nested;
    const profile = nestedTeam ? profiles.nested : profiles.root;
    assert.equal(view.data.members[0].role, profile.role);
    assert.equal(requests[0].cwd, chosen);
    assert.equal(requests[0].on, engine.machine);

    host.moveFocus(root);
    host.click('call-reviewer');
    view.form.task.set_value(task);
    const id = view.form.sessionId;
    host.moveFocus(nested);
    if (nestedTeam) view.engine = { ...engine, cli: `${fileURLToPath(new URL('../bin/', import.meta.url))}./council.js` };
    host.click('start-task');
    await host.settle();

    const invocations = requests.filter(request => request.args?.[1] === 'team');
    const installation = requests.find(request => request.path);
    const actualProject = invocations[0]?.cwd;
    const job = host.job(actualProject ?? chosen, id);
    const launches = host.launches();
    assert.deepEqual({
      invocations,
      installation,
      resolvedProfile: job && { role: job.participant.team.role, agent: job.agent, permission: job.permission },
      workerCwds: launches.map(args => args[args.indexOf('--cwd') + 1]),
      otherProjectJob: Boolean(host.job(other, id))
    }, {
      invocations: [{
        args: [cli, 'team', 'call', 'reviewer', '--session', id, '--timeout', '180', `--task=${task}`],
        on: engine.machine, cwd: chosen, timeout: 30000
      }],
      installation: { path: cli, on: engine.machine },
      resolvedProfile: { role: profile.role, agent: profile.agent, permission: profile.permission },
      workerCwds: [chosen],
      otherProjectJob: false
    });
    assert.equal(job.participant.team.model, profile.model ?? '');
    assert.equal(view.selected.project, chosen);
  });
}

test('a Team form cannot dispatch after focus switches to another peer', async t => {
  const host = await desktop(t, true);
  host.click('call-reviewer');
  host.view.form.task.set_value(task);
  const id = host.view.form.sessionId;
  host.selectMachine();
  host.view.launchTask(host.context);
  await host.settle();
  assert.equal(host.requests.filter(request => request.args?.[1] === 'team').length, 0);
  assert.deepEqual(host.launches(), []);
  assert.equal(host.job(host.root, id), null);
  assert.equal(host.job(host.nested, id), null);
});

test('a stale nested roster button cannot open a call from the normal Team view', async t => {
  const host = await desktop(t, true);
  const callNested = host.action('call-reviewer');
  host.view.navigate(host.context, 'team');
  await host.settle();
  assert.equal(host.view.data.members[0].role, profiles.root.role);
  callNested();
  assert.equal(host.view.form, null);
  assert.deepEqual(host.launches(), []);
});
