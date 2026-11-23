import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './workspace.js';

const skillSource = fileURLToPath(new URL('../skills/council/SKILL.md', import.meta.url));
const serverEntry = fileURLToPath(new URL('../bin/council.js', import.meta.url));

const hosts = {
  antigravity: { skills: ['.agents', 'skills'], config: ['.agents', 'mcp_config.json'] },
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

export function setupAlignment({ host, project, apply = false, replace = false }) {
  if (typeof project !== 'string' || !isAbsolute(project) || !existsSync(project) || !lstatSync(project).isDirectory()) {
    throw new Error('Use --project with an existing absolute project directory.');
  }
  project = resolve(project);
  if (!Object.hasOwn(hosts, host)) throw new Error('Choose --host antigravity, claude, junie, or opencode. See docs/alignment.md for other hosts.');
  const paths = hosts[host];
  const alternate = join(project, 'opencode.json');
  const config = host === 'opencode' && existsSync(alternate) && !existsSync(join(project, ...paths.config))
    ? alternate : join(project, ...paths.config);
  const skill = join(project, ...paths.skills, 'council', 'SKILL.md');
  const binding = { COUNCIL_MCP_PROJECT: project };
  const server = host === 'opencode' ? { type: 'local', command: [process.execPath, serverEntry, 'mcp'], environment: binding }
    : { command: process.execPath, args: [serverEntry, 'mcp'], env: binding };
  const plan = { host, project, skill, config, server, applied: false };
  if (!apply) return plan;

  checkParents(project, config);
  checkParents(project, skill);
  const oldConfig = readRegular(config);
  const oldSkill = readRegular(skill);
  const newSkill = readFileSync(skillSource, 'utf8');
  let settings;
  try { settings = JSON.parse(oldConfig ?? '{}'); } catch { throw new Error(`Merge the Council server into ${config} using the preview; it contains JSONC comments or invalid JSON.`); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`Expected a JSON object in ${config}.`);
  if (host === 'opencode') settings.mcp ??= {};
  const container = host === 'opencode' ? settings.mcp : settings;
  const key = host === 'opencode' ? 'servers' : 'mcpServers';
  if (!container || typeof container !== 'object' || Array.isArray(container)) throw new Error(`Invalid MCP configuration in ${config}.`);
  container[key] ??= {};
  const servers = container[key];
  if (typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`Invalid MCP servers in ${config}.`);
  const previous = servers.council;
  const serverChanged = JSON.stringify(previous) !== JSON.stringify(server);
  if (!replace && ((previous && serverChanged) || (oldSkill !== null && oldSkill !== newSkill))) {
    throw new Error('An existing Council skill or connection differs. Use the preview to review it before applying with --replace.');
  }
  if (readRegular(config) !== oldConfig || readRegular(skill) !== oldSkill) throw new Error('Council setup changed during this operation. Retry after inspecting it.');
  if (serverChanged) {
    servers.council = server;
    atomicWrite(config, JSON.stringify(settings, null, 2) + '\n');
  }
  if (oldSkill !== newSkill) atomicWrite(skill, newSkill);
  return { ...plan, applied: true };
}
