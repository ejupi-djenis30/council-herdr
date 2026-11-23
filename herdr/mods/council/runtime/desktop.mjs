import { readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { reportProgress, runRelations, workspaceActivity } from './activity.mjs';
import { readDelegation } from './delegations.mjs';
import { closeDebate, createDebate, readDebate, readDebateRoom, replyToDebate, roomSchema } from './debate-room.mjs';
import { discussionMessages, proposalReference, readDiscussionSession, readJson, readSubmittedBallots } from './discussion.mjs';
import { pendingInvitationIds, planInvitations, prepareInvitations, readInvitationDelivery, retryInvitation } from './invitations.mjs';
import { PollStore } from './polls.mjs';
import { isDirectory, isFile, readText } from './store-files.mjs';
import { TeamStore } from './team.mjs';

function verdictFor(dir, session) {
  const { sessionId: id } = session;
  const createdAt = Date.parse(session.createdAt);
  const candidates = ['reports', 'validation'].flatMap(folder => {
    const results = join(dir, folder);
    if (!isDirectory(results)) return [];
    const verdict = readJson(join(results, 'verdict.json'));
    const validation = verdict?.validation;
    const timestamp = Date.parse(validation?.validatedAt);
    if (verdict?.sessionId !== id || verdict.mode !== session.mode ||
        validation?.$schema !== 'council.validation/v1' || !verdict.tally ||
        !Number.isFinite(createdAt) || !Number.isFinite(timestamp) || timestamp < createdAt) return [];
    return [{ folder, verdict, timestamp }];
  });
  // A reused ID may have an older report alongside its current validation.
  candidates.sort((a, b) => b.timestamp - a.timestamp ||
    Number(b.folder === 'validation') - Number(a.folder === 'validation'));
  return candidates[0];
}

function reviewStatus(saved) {
  const validation = saved?.verdict.validation;
  const tally = saved?.verdict.tally;
  const authorized = saved?.folder === 'reports' && validation.passed === true &&
    ['validated', 'conditional'].includes(validation.verdict) && validation.artifactIntegrity === true &&
    validation.mutationDetected === false && tally.passed === true && tally.quorumMet === true && tally.invalidCount === 0;
  return authorized ? 'approved'
    : ['approved', 'validated', 'conditional'].includes(validation?.verdict) ? 'unconfirmed' : validation?.verdict ?? 'pending';
}

function readCouncilSession(base, id, selected, discussion, cwd) {
  const dir = join(base, id);
  const session = readDiscussionSession(dir, id);
  if (!session || (!discussion && session.mode === 'debate')) return null;
  const saved = session.mode === 'debate' ? null : verdictFor(dir, session);
  const interactive = session.mode === 'debate' && session.$schema === roomSchema;
  const room = interactive ? (selected ? readDebate(cwd, id) : readDebateRoom(cwd, id)) : null;
  const taskDir = join(dir, 'task');
  const task = interactive ? session.question : isDirectory(taskDir) ? readText(join(taskDir, 'task.md'), 1024 * 1024)?.trim() : null;
  const summary = {
    id, mode: session.mode, interactive, question: task?.slice(0, 220) || id, createdAt: session.createdAt,
    status: interactive ? (room.closedAt ? 'closed' : 'open') : session.mode === 'debate' ? 'archived' : reviewStatus(saved),
    ...(room ? { closedAt: room.closedAt } : {})
  };
  if (!selected) return { summary, detail: null };
  const proposal = proposalReference(dir, session, saved?.verdict.validation);
  const detail = { ...summary, task: task?.slice(0, 2400) || id, participants: session.participants ?? [] };
  if (discussion) {
    const invitationDelivery = interactive ? readInvitationDelivery(cwd, id, { closed: Boolean(room.closedAt) }) : null;
    const invitations = invitationDelivery?.targets ?? null;
    const names = new Map(invitations?.map(target => [target.address, target.label]));
    const messages = interactive ? room.messages.map(message => ({ ...message, agent: names.get(message.author) }))
      : discussionMessages(dir, session, proposal);
    const polls = interactive ? new PollStore(cwd).list({ sourceDebateId: id }).polls : [];
    return { summary, detail: { ...detail, interactive, messages, invitations, invitationDelivery, polls, decision: room?.decision ?? null } };
  }
  const reportPath = saved ? join(dir, saved.folder, 'report.md') : null;
  return { summary, detail: { ...detail,
    tally: saved?.verdict.tally ?? null, validation: saved?.verdict.validation ?? null,
    ballots: readSubmittedBallots(dir, session, proposal), proposal,
    reportPath: reportPath && isFile(reportPath) ? reportPath : null
  } };
}

function sessions(cwd, selected, collection, item, readRecord) {
  const base = join(cwd, '.agent_workspace');
  if (!isDirectory(base)) return { [collection]: [], [item]: null, errors: [] };
  if (selected != null) {
    if (typeof selected !== 'string' || !selected || selected.startsWith('.') || /[\\/:\u0000-\u001f]/.test(selected)) {
      throw new Error(`Invalid ${item} ID.`);
    }
    return { [item]: readRecord(base, selected, true)?.detail ?? null };
  }
  const entries = readdirSync(base, { withFileTypes: true });

  const summaries = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const result = readRecord(base, entry.name, false);
      if (!result) continue;
      summaries.push(result.summary);
    } catch (error) {
      errors.push({ id: entry.name, error: error.message });
    }
  }
  summaries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { [collection]: summaries, errors };
}

function projectRequest(cwd, action, args) {
  const store = new PollStore(cwd);
  switch (action) {
    case 'team': return new TeamStore(cwd).list();
    case 'team-set': {
      const team = new TeamStore(cwd);
      team.set(args);
      return team.list();
    }
    case 'polls': {
      if (args.id) {
        const poll = store.show(args.id);
        const invitationDelivery = readInvitationDelivery(cwd, args.id, { closed: Boolean(poll.closedAt) });
        return { poll: { ...poll, invitations: invitationDelivery?.targets ?? null, invitationDelivery } };
      }
      return store.list();
    }
    case 'reviews': return sessions(cwd, args.id, 'reviews', 'review', readCouncilSession);
    case 'debates': return sessions(cwd, args.id, 'debates', 'debate', (base, id, selected) => readCouncilSession(base, id, selected, true, cwd));
    case 'delegations': {
      const result = sessions(cwd, args.id, 'delegations', 'delegation', readDelegation);
      const job = result.delegation;
      if (job?.teamMember || job?.teamSource) {
        job.related = runRelations(job, sessions(cwd, null, 'delegations', 'delegation', readDelegation).delegations);
      }
      return result;
    }
    case 'activity': return args.id != null
      ? projectRequest(cwd, 'delegations', { id: args.id })
      : workspaceActivity(cwd, (project, section) => projectRequest(project, section, {}), args);
    case 'activity-report':
      reportProgress(cwd, args, 'operator');
      return projectRequest(cwd, 'delegations', { id: args.sessionId });
    case 'pending-invitations': return { ids: pendingInvitationIds(cwd, args.space) };
    case 'create':
    case 'debate-create': {
      const plan = planInvitations(args.space, args.recipients);
      const beforePublish = plan ? id => prepareInvitations(cwd, id, plan) : undefined;
      if (action === 'debate-create') {
        const room = createDebate(cwd, args, { beforePublish });
        return projectRequest(cwd, 'debates', { id: room.sessionId }).debate;
      }
      const participants = args.recipients === undefined ? args.participants : plan?.targets ?? [];
      const sourceDebateId = args.sourceDebateId === undefined ? undefined : readDebateRoom(cwd, args.sourceDebateId).sessionId;
      const poll = store.create({ ...args, participants, createdBy: 'operator' }, { fromPanel: true, beforePublish, sourceDebateId });
      return { ...poll, invitations: plan?.targets ?? null };
    }
    case 'debate-reply':
      replyToDebate(cwd, args.id, { author: 'operator', body: args.text }, { fromPanel: true });
      return projectRequest(cwd, 'debates', { id: args.id }).debate;
    case 'invite-retry': return retryInvitation(cwd, args);
    case 'debate-close':
      closeDebate(cwd, args.id, args);
      return projectRequest(cwd, 'debates', { id: args.id }).debate;
    case 'add-option': return store.addOption(args.id, args.label);
    case 'track': return store.track(args.id, args);
    case 'untrack': return store.untrack(args.id, args.voter);
    case 'vote': return store.vote(args.id, { ...args, voter: 'operator' }, { fromPanel: true });
    case 'close': return store.close(args.id, args.outcome);
    default: throw new Error('Unknown Council panel action.');
  }
}

export function desktopRequest(cwd, action, args) {
  const pendingInvites = action === 'pending-invitations';
  if ((!pendingInvites && !['polls', 'reviews', 'debates', 'delegations'].includes(action)) || args.id != null || !Array.isArray(args.projects)) {
    return projectRequest(cwd, action, args);
  }
  const items = [];
  const errors = [];
  const scanned = new Set();
  for (const folder of [cwd, ...args.projects]) {
    if (typeof folder !== 'string' || !isAbsolute(folder)) continue;
    try {
      const project = realpathSync.native(folder);
      const key = process.platform === 'win32' ? project.toLowerCase() : project;
      if (scanned.has(key)) continue;
      scanned.add(key);
      if (pendingInvites) {
        items.push(...pendingInvitationIds(project, args.space).map(id => ({ id, project })));
        continue;
      }
      const result = projectRequest(project, action, {});
      items.push(...result[action].map(item => ({ ...item, project })));
      errors.push(...result.errors.map(error => ({ ...error, project })));
    } catch (error) {
      errors.push({ project: folder, error: error.message });
    }
  }
  items.sort((a, b) => Boolean(a.closedAt) - Boolean(b.closedAt) || String(b.createdAt).localeCompare(String(a.createdAt)));
  return { [action]: items, errors };
}
