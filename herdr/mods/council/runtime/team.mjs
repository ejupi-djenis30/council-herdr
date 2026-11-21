import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, eventFiles, isDirectory, readText } from './store-files.mjs';
import { jobRecordProblem } from './job-record.mjs';

const agents = ['codex', 'claude', 'antigravity', 'junie'];
const modelAgents = ['codex', 'claude'];
const memberId = /^[a-z][a-z0-9-]{0,31}$/;
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;

function field(value, label, limit, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.trim().length > limit || (required && !value.trim())) {
    throw new Error(`${label} must contain ${required ? '1' : '0'} to ${limit} characters.`);
  }
  return value.trim();
}

function memberProfile(input, members) {
  const id = field(input.id, 'Member ID', 32, true);
  if (!memberId.test(id)) throw new Error('Use a lowercase member ID such as lead or qa-review.');
  const agent = field(input.agent, 'Agent', 20, true);
  if (!agents.includes(agent)) throw new Error(`Choose an agent: ${agents.join(', ')}.`);
  const role = field(input.role, 'Role', 80, true);
  const model = field(input.model, 'Model', 120);
  if (model && (!modelAgents.includes(agent) || !modelId.test(model))) {
    throw new Error('A model ID can be set for Codex or Claude. Use the ID accepted by that agent.');
  }
  const permission = input.permission ?? 'read';
  if (!['read', 'write'].includes(permission)) throw new Error('Choose read or write access.');
  const instructions = field(input.instructions, 'Responsibilities', 1200);
  const reportsTo = field(input.reportsTo, 'Reports to', 32);
  for (let parent = reportsTo; parent; parent = members.get(parent)?.reportsTo) {
    if (id === parent) throw new Error('Reporting lines must be acyclic.');
    if (!members.has(parent)) throw new Error(`Unknown member: ${parent}.`);
  }
  return { id, agent, role, model, permission, instructions, reportsTo };
}

export class TeamStore {
  constructor(cwd) {
    this.root = realpathSync.native(cwd);
    this.base = join(this.root, '.agent_workspace');
    this.dir = join(this.base, '.team');
  }

  readMembers() {
    const members = new Map();
    if (!isDirectory(this.base)) return { members, revision: 0 };
    const files = eventFiles(this.dir);
    for (const file of files) {
      const profile = memberProfile(JSON.parse(readText(join(this.dir, file), 16000)), members);
      members.set(profile.id, profile);
    }
    return { members, revision: files.length };
  }

  set(input) {
    isDirectory(this.base, { create: true });
    isDirectory(this.dir, { create: true });
    for (let attempt = 0; attempt < 12; attempt++) {
      const { members, revision } = this.readMembers();
      const profile = memberProfile(input, members);
      if (appendEvent(this.dir, revision + 1, profile)) return profile;
    }
    throw new Error('Team configuration changed repeatedly. Save again.');
  }

  turns() {
    if (!isDirectory(this.base)) return [];
    const turns = [];
    for (const entry of readdirSync(this.base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = join(this.base, entry.name);
      try {
        const job = JSON.parse(readText(join(directory, 'job.json'), 16 * 1024 * 1024));
        if (job?.$schema !== 'council.job/v1' || job.sessionId !== entry.name || !job.participant?.team) continue;
        const dispatchError = job.state === 'starting' && readText(join(directory, 'dispatch-error.json'), 64 * 1024);
        const problem = jobRecordProblem(job, dispatchError);
        const { participant, sessionId, state, deadlineAt, createdAt } = job;
        turns.push({ participant, sessionId, state: problem ? 'failed' : state, deadlineAt, createdAt,
          hasResult: state === 'completed' && !problem && Boolean(job.result?.artifactPath),
          triedLaunch: job.deliveryState !== 'planned' });
      } catch {
        // Keep the team roster usable if a historical job cannot be read.
      }
    }
    return turns.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.sessionId.localeCompare(a.sessionId));
  }

  list() {
    const { members } = this.readMembers();
    const turns = this.turns();
    return {
      agents, modelAgents,
      members: Array.from(members.values(), profile => {
        const history = turns.filter(turn => turn.participant.team.id === profile.id);
        const latest = history[0];
        // A later queued or failed call must not hide a process held by an earlier call.
        const holder = history.find(turn => turn.participant.address && turn.participant.power !== 'off');
        const last = holder && (!latest?.participant.address || latest.createdAt <= holder.createdAt) ? holder : latest;
        const expired = last && Date.parse(last.deadlineAt) <= Date.now();
        const power = last?.participant.power;
        const state = !last || power === 'off' || (last.state === 'failed' && !last.triedLaunch) ? 'off'
          : expired || ['failed', 'uncertain'].includes(last.state) || power === 'unconfirmed' ? 'attention'
          : power === 'stopping' ? 'stopping' : last.state === 'starting' ? 'starting' : 'running';
        return { ...profile, state, sessionId: latest?.sessionId ?? null };
      })
    };
  }
}
