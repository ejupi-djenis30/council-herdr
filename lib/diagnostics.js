import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { alignmentDetails, skillRevision } from '../herdr/mods/council/runtime/alignment.mjs';
import { setupAlignment } from './alignment-setup.js';
import { councilToolDefinitions } from './mcp-tool-definitions.js';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const councilVersion = packageMetadata.version;
export const requiredCouncilTools = councilToolDefinitions().map(tool => tool.name);

function skillFingerprint(text) {
  return createHash('sha256').update(text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd()).digest('hex');
}

const expectedSkillFingerprint = skillFingerprint(readFileSync(new URL('../skills/council/SKILL.md', import.meta.url), 'utf8'));

function readConfig(file, jsonc = false) {
  if (!existsSync(file)) return { status: 'missing' };
  try {
    let source = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (jsonc) {
      // Match quoted strings first so URLs, escaped quotes and comma-like text survive.
      source = source.replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
        (_, quoted) => quoted ?? ' ');
      source = source.replace(/("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g, (_, quoted) => quoted ?? '');
    }
    return { status: 'read', value: JSON.parse(source) };
  } catch {
    return { status: 'unreadable' };
  }
}

function configuredServer(plan) {
  if (!plan.config) return { status: 'externally_managed' };
  const config = readConfig(plan.config, plan.host === 'opencode');
  if (config.status !== 'read') return { status: config.status };
  const entry = plan.host === 'opencode' ? config.value?.mcp?.servers?.council : config.value?.mcpServers?.council;
  if (!entry) return { status: 'missing' };
  if (plan.host === 'opencode' && entry.disabled === true) return { status: 'disabled' };
  const runner = plan.host === 'opencode' ? entry.command?.[1] : entry.args?.[0];
  if (typeof runner !== 'string' || !isAbsolute(runner) || !existsSync(runner)) return { status: 'unresolved', runner: runner ?? null };
  const metadata = readConfig(join(dirname(dirname(runner)), 'package.json')).value;
  const version = metadata?.name === packageMetadata.name && basename(runner) === 'council.js' ? metadata.version : null;
  return { status: version ? 'found' : 'unrecognized', runner, version };
}

function configuredSkill(plan) {
  if (!existsSync(plan.skill)) return { status: 'missing', revision: null };
  try {
    const text = readFileSync(plan.skill, 'utf8');
    const revision = text.match(/"revision"\s*:\s*"(council\/[^"\s]+)"/)?.[1] ?? null;
    const fingerprint = skillFingerprint(text);
    return { status: revision === skillRevision && fingerprint === expectedSkillFingerprint ? 'current' : 'mismatch', revision, fingerprint };
  } catch {
    return { status: 'unreadable', revision: null };
  }
}

export function inspectHostTools(hostTools) {
  const expectedCount = requiredCouncilTools.length;
  if (hostTools == null) return { state: 'unverified', expectedCount, availableCount: null, missingTools: null,
    nextAction: 'Discover the Council tools exposed to this agent and pass their names as hostTools.' };
  if (!Array.isArray(hostTools) || !hostTools.every(name => typeof name === 'string')) {
    throw new Error('hostTools must be an array of tool names observed in this agent session.');
  }
  const exposed = new Set(hostTools);
  const prefixes = ['', 'mcp__council__', 'tools.mcp__council__', 'mcp__council.', 'mcp__plugin_council_council__',
    'council_', 'council.', 'tools.council.'];
  const missingTools = requiredCouncilTools.filter(name => !prefixes.some(prefix => exposed.has(prefix + name)));
  return { state: missingTools.length ? 'incomplete' : 'complete', expectedCount,
    availableCount: expectedCount - missingTools.length, missingTools };
}

export function diagnoseCouncilHost({ host, project, target, herdr, liveServer, hostTools }) {
  const expected = { version: councilVersion, skillRevision, skillFingerprint: expectedSkillFingerprint, tools: [...requiredCouncilTools] };
  const issues = [];
  const issue = (code, action) => {
    const existing = issues.find(issue => issue.code === code);
    if (existing) return existing;
    const finding = { code, action };
    issues.push(finding);
    return finding;
  };
  const plan = host ? setupAlignment({ host, project }) : null;
  const configured = plan && { server: configuredServer(plan), skill: configuredSkill(plan), configPath: plan.config, skillPath: plan.skill };
  if (configured) {
    if (configured.server.status === 'disabled') {
      issue('mcp_disabled', 'Enable the Council MCP server in the host and reload its connection.');
    } else if (configured.server.status === 'unreadable') {
      issue('mcp_config_unreadable', 'Check the syntax and readability of the host configuration.');
    } else if (!['found', 'externally_managed'].includes(configured.server.status)) {
      issue('mcp_setup_missing', 'Check the host configuration and run alignment setup for the project.');
    } else if (configured.server.status === 'found' && configured.server.version !== expected.version) {
      issue('stale_mcp', 'Point the host at the matching Council installation and reload its MCP connection.');
    }
    if (configured.skill.status === 'missing') issue('skill_missing', 'Install the Council skill in the host and reload it.');
    else if (configured.skill.status !== 'current') issue('skill_mismatch', 'Refresh the installed Council skill and reload it in the host.');
  }

  const hostInventory = inspectHostTools(hostTools);
  const versionMismatch = liveServer?.version && liveServer.version !== expected.version;
  if (versionMismatch || hostInventory.state === 'incomplete') {
    const finding = issue(versionMismatch && configured?.server.version !== expected.version ? 'stale_mcp' : 'needs_reload',
      'Check the Council server version and enabled tools, then reload the host connection.');
    if (hostInventory.state === 'incomplete') {
      finding.missingTools = hostInventory.missingTools;
      finding.action += ` The host inventory is missing ${hostInventory.missingTools.join(', ')}.`;
    }
  }

  const terminal = target ? herdr.get(target) : null;
  const alignment = terminal ? { address: terminal.details?.address ?? target,
    ...(terminal.success ? alignmentDetails(terminal.details) : { state: 'unavailable' }) } : null;
  if (alignment?.state === 'needs_reload') {
    const finding = issue('needs_reload', alignment.nextAction);
    if (finding.action !== alignment.nextAction) finding.action += ' ' + alignment.nextAction;
  }
  if (alignment?.state === 'not_aligned') issue('not_aligned', 'Complete the setup reported missing by the agent, then request alignment.');
  if (alignment?.state === 'unconfirmed') issue('alignment_unconfirmed', 'Request an alignment check after the host loads the current skill and MCP server.');
  if (alignment?.state === 'unavailable') issue('terminal_unavailable', 'Check the selected Herdr terminal before requesting alignment.');

  return { expected, host: host ?? null, project: plan?.project ?? project ?? null, configured,
    liveServer: liveServer ?? null, hostInventory, alignment, issues };
}
