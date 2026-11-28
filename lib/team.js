import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';

const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));
const memberId = /^[a-z][a-z0-9-]{0,31}$/;

export async function callTeamMember(manager, { member, task, sessionId, timeoutSec, workItemId, workItemBinding }) {
  if (typeof member !== 'string' || !memberId.test(member)) throw new Error('A valid member ID is required.');
  if (typeof task !== 'string' || !task.trim() || task.length > 12000) throw new Error('Provide a task of 1 to 12000 characters.');
  if (typeof sessionId !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(sessionId) || manager.workspace.sanitizeName(sessionId) !== sessionId) {
    throw new Error('Provide a stable lowercase session ID, such as design-review-1.');
  }

  const store = new TeamStore(manager.cwd);
  const existing = manager.readJobRecord(sessionId);
  if (!existing.success && !existing.notFound) throw new Error(existing.error);
  const saved = existing.job?.participant?.team;
  if (existing.success && saved?.id !== member) throw new Error(`Session "${sessionId}" belongs to another job.`);
  const { members } = store.readMembers();
  const profile = saved ?? members.get(member);
  if (!profile) throw new Error(`Unknown team member: ${member}.`);

  const turns = store.turns();
  const address = manager.herdr.terminalId;
  const candidate = address && turns.find(turn => turn.participant.address === address && turn.state === 'deliberating');
  const current = candidate && manager.herdr.get(address)?.details;
  const caller = current && Number.isSafeInteger(current.pid) && current.pid === candidate.participant.identity?.pid &&
    current?.created_ms === candidate?.participant?.identity?.createdMs ? candidate : null;
  if (caller?.participant.team.id === member) throw new Error('A running member cannot call its own role. Ask a teammate to call it later.');
  const project = process.platform === 'win32' ? store.root.toLowerCase() : store.root;
  const name = `team-${createHash('sha256').update(`${project}\0${member}`).digest('hex').slice(0, 24)}`;

  const result = await manager.startJob({
    task, sessionId, timeoutSec, workItemId, workItemBinding, agent: profile.agent, permission: profile.permission,
    team: profile, teamName: name, teamSource: caller?.sessionId ?? null,
    teamReports: Array.from(members.values()).filter(person => person.reportsTo === member).map(person => person.id)
  });
  return result.success ? {
    ...result,
    handoff: 'The call is saved. If your managed role has no more work, return a final handoff now and end this turn. A teammate can call your role in a new session when needed.'
  } : result;
}

export function teamBrief(job, project) {
  const { team } = job.participant;
  const status = `node "${cli}" result --session`;
  const previous = new TeamStore(project).turns().find(turn =>
    turn.participant.team.id === team.id && turn.sessionId !== job.sessionId && turn.hasResult);
  return [
    `You are ${team.id}, serving as ${team.role} on this Council team.`,
    team.reportsTo ? `You report to ${team.reportsTo}.` : 'This role has no assigned manager.',
    job.teamReports?.length ? `Direct reports: ${job.teamReports.join(', ')}.` : '',
    team.instructions ? `Role responsibilities: ${team.instructions}` : '',
    job.teamSource ? `Calling teammate's session: ${job.teamSource}. Its result, when available, is readable with ${status} ${job.teamSource}.` : '',
    previous ? `Your previous turn: ${previous.sessionId}. Consult the archived result if needed with ${status} ${previous.sessionId}.` : '',
    '',
    `Use council_team_list to find teammates and council_team_call to call a role with an explicit task and a fresh session ID. CLI equivalent: node "${cli}" team call <member> --session <id> --task "<brief>".`,
    `If a progress update or blocker would help the operator, use council_report_progress for session ${job.sessionId} when available. It adds a reported note to the workspace.`,
    'A call does not require you to stay active. When all remaining work or decisions have been delegated, give your final handoff with the called session IDs, decisions, and unresolved work, then end your turn immediately. Do not wait, poll, or keep your turn open for replies.',
    'Include enough context in calls for the recipient to act. If you need a teammate to report back to your role, ask for an explicit call when they have actionable information. Each new call starts a fresh model process with access to archived results.',
    'Report tool or permission failures in your handoff. Team roles do not change your permissions or formal voting rules.'
  ].filter(Boolean).join('\n');
}
