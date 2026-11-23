import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './workspace.js';

const skillNames = ['council', 'council-delegate', 'council-review', 'council-team'];
const serverEntry = fileURLToPath(new URL('../bin/council.js', import.meta.url));

const hosts = {
  antigravity: { skills: ['.agents', 'skills'], config: ['.agents', 'mcp_config.json'] },
  codex: { skills: ['.agents', 'skills'] },
  claude: { skills: ['.claude', 'skills'], config: ['.mcp.json'] },
  junie: { skills: ['.junie', 'skills'], config: ['.junie', 'mcp', 'mcp.json'] },
  opencode: { skills: ['.agents', 'skills'], config: ['opencode.jsonc'] }
};

function readRegular(path) {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error(`Expected a regular file at ${path}.`);
  return readFileSync(path, 'utf8');
}

function checkParents(project, file) {
  for (let parent = dirname(file); parent !== project; parent = dirname(parent)) {
    if (existsSync(parent) && !lstatSync(parent).isDirectory()) throw new Error(`Expected a regular project directory at ${parent}.`);
  }
}

function serverUpdate(config, host, server) {
  const current = readRegular(config);
  let settings;
  try { settings = JSON.parse(current ?? '{}'); } catch { throw new Error(`Merge the Council server into ${config} using the preview; it contains JSONC comments or invalid JSON.`); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`Expected a JSON object in ${config}.`);
  if (host === 'opencode') settings.mcp ??= {};
  const container = host === 'opencode' ? settings.mcp : settings;
  const key = host === 'opencode' ? 'servers' : 'mcpServers';
  if (!container || typeof container !== 'object' || Array.isArray(container)) throw new Error(`Invalid MCP configuration in ${config}.`);
  container[key] ??= {};
  const servers = container[key];
  if (typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`Invalid MCP servers in ${config}.`);
  if (JSON.stringify(servers.council) === JSON.stringify(server)) return null;
  const occupied = Boolean(servers.council);
  servers.council = server;
  return { path: config, current, content: JSON.stringify(settings, null, 2) + '\n', occupied };
}

export function setupAlignment({ host, project, apply = false, replace = false }) {
  if (typeof project !== 'string' || !isAbsolute(project) || !existsSync(project) || !lstatSync(project).isDirectory()) {
    throw new Error('Use --project with an existing absolute project directory.');
  }
  project = resolve(project);
  if (!Object.hasOwn(hosts, host)) throw new Error('Choose --host codex, antigravity, claude, junie, or opencode. See docs/alignment.md for other hosts.');
  const paths = hosts[host];
  let config = paths.config ? join(project, ...paths.config) : null;
  const alternate = join(project, 'opencode.json');
  if (host === 'opencode' && existsSync(alternate) && !existsSync(config)) config = alternate;
  const skills = skillNames.map(name => join(project, ...paths.skills, name, 'SKILL.md'));
  const binding = { COUNCIL_MCP_PROJECT: project };
  const server = host === 'opencode' ? { type: 'local', command: [process.execPath, serverEntry, 'mcp'], environment: binding }
    : { command: process.execPath, args: [serverEntry, 'mcp'], env: binding, ...(host === 'codex' ? { cwd: project } : {}) };
  const plan = { host, project, skill: skills[0], skills, config, server, applied: false };
  if (!apply) return plan;

  const updates = skills.map((path, index) => {
    checkParents(project, path);
    const current = readRegular(path);
    const content = readFileSync(new URL(`../skills/${skillNames[index]}/SKILL.md`, import.meta.url), 'utf8');
    return current === content ? null : { path, current, content, occupied: current !== null };
  }).filter(Boolean);
  if (config) {
    checkParents(project, config);
    const update = serverUpdate(config, host, server);
    if (update) updates.unshift(update);
  }
  if (!replace && updates.some(update => update.occupied)) {
    throw new Error('An existing Council skill or connection differs. Use the preview to review it before applying with --replace.');
  }
  if (updates.some(update => readRegular(update.path) !== update.current)) throw new Error('Council setup changed during this operation. Retry after inspecting it.');
  for (const update of updates) atomicWrite(update.path, update.content);
  return { ...plan, applied: true };
}
