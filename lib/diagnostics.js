import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { alignmentOf, skillRevision } from '../herdr/mods/council/runtime/alignment.mjs';
import { setupAlignment } from './alignment-setup.js';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const councilVersion = packageMetadata.version;
export const requiredCouncilTools = [
  'council_alignment', 'council_start', 'council_session_status', 'council_result',
  'council_poll_create', 'council_poll_read', 'council_poll_vote',
  'council_debate_create', 'council_debate_read', 'council_debate_reply'
];

function skillFingerprint(text) {
  return createHash('sha256').update(text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd()).digest('hex');
}

const expectedSkillFingerprint = skillFingerprint(readFileSync(new URL('../skills/council/SKILL.md', import.meta.url), 'utf8'));

function readConfig(file) {
  if (!existsSync(file)) return { status: 'missing' };
  try {
    return { status: 'read', value: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch {
    return { status: 'unreadable' };
  }
}

function configuredServer(plan) {
  const config = readConfig(plan.config);
  if (config.status !== 'read') return { status: config.status };
  const entry = plan.host === 'opencode' ? config.value?.mcp?.servers?.council : config.value?.mcpServers?.council;
  if (!entry) return { status: 'missing' };
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

export function diagnoseCouncilHost({ host, project, target, herdr, liveServer }) {
  const expected = { version: councilVersion, skillRevision, skillFingerprint: expectedSkillFingerprint, tools: [...requiredCouncilTools] };
  const issues = [];
  const issue = (code, action) => {
    if (!issues.some(issue => issue.code === code)) issues.push({ code, action });
  };
  const plan = host ? setupAlignment({ host, project }) : null;
  const configured = plan && { server: configuredServer(plan), skill: configuredSkill(plan), configPath: plan.config, skillPath: plan.skill };
  if (configured) {
    if (configured.server.status !== 'found') {
      issue('mcp_setup_missing', 'Check the host configuration and run alignment setup for the project.');
    } else if (configured.server.version !== expected.version) {
      issue('stale_mcp', 'Point the host at the matching Council installation and reload its MCP connection.');
    }
    if (configured.skill.status === 'missing') issue('skill_missing', 'Install the Council skill in the host and reload it.');
    else if (configured.skill.status !== 'current') issue('skill_mismatch', 'Refresh the installed Council skill and reload it in the host.');
  }

  if (liveServer) {
    const missingTools = Array.isArray(liveServer.tools) && requiredCouncilTools.some(tool => !liveServer.tools.includes(tool));
    if ((liveServer.version && liveServer.version !== expected.version) || missingTools) {
      issue(configured?.server.version === expected.version ? 'needs_reload' : 'stale_mcp',
        'Reload the host connection and confirm that its Council MCP tool list includes alignment and debate.');
    }
  }

  const terminal = target ? herdr.get(target) : null;
  const alignment = terminal ? { address: terminal.details?.address ?? target, state: terminal.success ? alignmentOf(terminal.details) : 'unavailable' } : null;
  if (alignment?.state === 'not_aligned') issue('not_aligned', 'Complete the setup reported missing by the agent, then request alignment.');
  if (alignment?.state === 'unconfirmed') issue('alignment_unconfirmed', 'Request an alignment check after the host loads the current skill and MCP server.');
  if (alignment?.state === 'unavailable') issue('terminal_unavailable', 'Check the selected Herdr terminal before requesting alignment.');

  return { expected, host: host ?? null, project: plan?.project ?? project ?? null, configured, liveServer: liveServer ?? null, alignment, issues };
}
