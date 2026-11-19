import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const install = fileURLToPath(new URL('../herdr/install.js', import.meta.url));

function run(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 10000 });
}

function environment(t) {
  const root = mkdtempSync(join(tmpdir(), 'council desktop '));
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
