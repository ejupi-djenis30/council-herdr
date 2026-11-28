import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const archive = process.argv[2];
if (!archive) throw new Error('Pass the npm tarball path.');
const temp = mkdtempSync(join(tmpdir(), 'council package smoke '));
try {
  const extracted = spawnSync('tar', ['-xzf', '-'], { cwd: temp, input: readFileSync(archive), encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.error?.message ?? extracted.stderr);
  const root = join(temp, 'package');
  const project = join(temp, 'unrelated project');
  mkdirSync(project);
  const cli = spawnSync(process.execPath, [join(root, 'bin/council.js'), 'work-item', 'list', '--project', project], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).items, []);
  const setRole = spawnSync(process.execPath, [join(root, 'bin/council.js'), 'team', 'set', 'smoke', '--agent', 'codex', '--role', 'Smoke'], { cwd: project, encoding: 'utf8' });
  assert.equal(setRole.status, 0, setRole.stderr);
  const input = { id: 'wi-package', title: 'Package check', roleId: 'smoke', criteria: ['Check the installed command'] };
  const create = spawnSync(process.execPath, [join(root, 'bin/council.js'), 'work-item', 'create', '--input-json', JSON.stringify(input), '--project', project], { encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  assert.equal(JSON.parse(create.stdout).item.id, input.id);
  const triageInput = { id: input.id, ifRevision: 1, requestId: 'smoke-triage', actor: 'Smoke', patch: { priority: 'high' } };
  const triage = spawnSync(process.execPath, [join(root, 'bin/council.js'), 'work-item', 'triage', '--input-json', JSON.stringify(triageInput), '--project', project], { encoding: 'utf8' });
  assert.equal(triage.status, 0, triage.stderr);
  assert.equal(JSON.parse(triage.stdout).item.lifecycle.priority, 'high');
  for (const file of ['herdr/mods/council/runtime/work-item-lifecycle-store.mjs', 'lib/work-item-lifecycle.js', 'lib/work-item-review.js', 'herdr/mods/council/work-item-view.js', 'herdr/mods/council/work-item-actions.js', 'herdr/mods/council/icons/LICENSE.ejupilabs-icons.txt']) {
    assert.ok(existsSync(join(root, file)), `missing packaged file: ${file}`);
  }
  const appHome = join(temp, 'isolated app');
  const installed = spawnSync(process.execPath, [join(root, 'herdr/install.js'), '--app-home', appHome], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const mod = join(appHome, 'mods/council');
  for (const file of ['icons/LICENSE.ejupilabs-icons.txt', 'work-item-view.js', 'work-item-actions.js', 'runtime/work-item-lifecycle-store.mjs', 'runtime/work-item-store.mjs', 'engine/herdr/mods/council/runtime/work-item-lifecycle-store.mjs']) {
    assert.ok(existsSync(join(mod, file)), `missing installed file: ${file}`);
  }
  const installedCli = spawnSync(process.execPath, [join(mod, 'engine/bin/council.js'), 'work-item', 'history', '--id', input.id, '--project', project], { encoding: 'utf8' });
  assert.equal(installedCli.status, 0, installedCli.stderr);
  assert.equal(JSON.parse(installedCli.stdout).events[0].type, 'triaged');
  const read = file => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const { version } = read('package.json');
  const codex = read('.codex-plugin/plugin.json');
  const claude = read('.claude-plugin/plugin.json');
  assert.equal(codex.version, version);
  assert.equal(claude.version, version);
  assert.equal(read('plugin.json').version, version);
  assert.ok(existsSync(join(root, codex.skills, 'council', 'SKILL.md')));
  const wrappers = [
    ['Codex compatibility', read(codex.mcpServers).mcpServers.council],
    ['portable plugin', read('mcp.json').mcpServers.council],
    ['Claude Code', claude.mcpServers.council],
    ['Antigravity', read('mcp_config.json').mcpServers.council]
  ];
  const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
  const call = (id, name, args) => request(id, 'tools/call', { name, arguments: args });
  const frames = [
    request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1' } }),
    request(undefined, 'notifications/initialized'),
    request(2, 'tools/list'),
    call(3, 'council_session_status', { sessionId: 'scoped' }),
    call(4, 'council_poll_read', { project }),
    call(5, 'council_work_item_list', {}),
    call(6, 'council_work_item_list', { project }),
    call(7, 'council_work_item_show', { project, id: 'wi-package' }),
    call(8, 'council_work_item_delegate', { project, id: '../invalid' }),
    call(9, 'council_work_item_history', { project, id: 'wi-package', requestId: 'smoke-triage' })
  ];
  for (const [host, command] of wrappers) {
    assert.equal(command.command, 'node', host);
    const env = { ...process.env, ...command.env };
    delete env.COUNCIL_MCP_PROJECT;
    // Codex resolves configured relative working directories against the installed plugin root.
    // Claude Code and Antigravity expand their respective installed plugin-root variables.
    const cwd = command.cwd ? resolve(root, command.cwd) : project;
    const args = command.args.map(arg => arg.replace(/^\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/, root));
    const child = spawnSync(process.execPath, args, {
      cwd, env, input: frames.map(frame => JSON.stringify(frame)).join('\n') + '\n',
      encoding: 'utf8', timeout: 10000
    });
    assert.equal(child.status, 0, `${host}: ${child.error?.message ?? child.stderr}`);
    const responses = new Map(child.stdout.trim().split(/\r?\n/).map(line => {
      const response = JSON.parse(line);
      return [response.id, response.result];
    }));
    assert.equal(responses.get(1).serverInfo.version, version, host);
    const tools = new Set(responses.get(2).tools.map(tool => tool.name));
    for (const name of ['council_alignment', 'council_start', 'council_session_status', 'council_result',
      'council_schedules', 'council_poll_create', 'council_poll_read', 'council_poll_vote', 'council_poll_manage',
      'council_debate_create', 'council_debate_read', 'council_debate_reply', 'council_debate_close',
      'council_work_item_create', 'council_work_item_list', 'council_work_item_show', 'council_work_item_delegate',
      'council_work_item_triage', 'council_work_item_review', 'council_work_item_close', 'council_work_item_reopen', 'council_work_item_history']) {
      assert.ok(tools.has(name), `${host}: ${name} missing`);
    }
    assert.equal(responses.get(3).isError, true, host);
    assert.match(responses.get(3).content[0].text, /no default project/, host);
    assert.notEqual(responses.get(4).isError, true, responses.get(4).content[0].text);
    assert.equal(responses.get(5).isError, true, host);
    assert.equal(JSON.parse(responses.get(5).content[0].text).error.code, 'invalid_input', host);
    assert.equal(JSON.parse(responses.get(6).content[0].text).items[0].id, 'wi-package', host);
    assert.equal(JSON.parse(responses.get(7).content[0].text).item.id, 'wi-package', host);
    assert.equal(responses.get(8).isError, true, host);
    assert.equal(JSON.parse(responses.get(8).content[0].text).error.code, 'invalid_input', host);
    assert.equal(JSON.parse(responses.get(9).content[0].text).receipt.event, 'triaged', host);
    assert.equal(existsSync(join(root, '.agent_workspace')), false, host);
    console.log(`${host}: packaged Council ${version} handshake and project guard passed`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
