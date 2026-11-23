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
    call(4, 'council_poll_read', { project })
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
      'council_debate_create', 'council_debate_read', 'council_debate_reply', 'council_debate_close']) {
      assert.ok(tools.has(name), `${host}: ${name} missing`);
    }
    assert.equal(responses.get(3).isError, true, host);
    assert.match(responses.get(3).content[0].text, /no default project/, host);
    assert.notEqual(responses.get(4).isError, true, responses.get(4).content[0].text);
    assert.equal(existsSync(join(root, '.agent_workspace')), false, host);
    console.log(`${host}: packaged Council ${version} handshake and project guard passed`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
