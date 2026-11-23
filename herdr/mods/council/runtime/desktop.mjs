import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { reportProgress, runRelations, workspaceActivity } from './activity.mjs';
import { matchesDesktopTask, readDelegation } from './delegations.mjs';
import { closeDebate, createDebate, readDebate, readDebateRoom, replyToDebate, roomSchema } from './debate-room.mjs';
import { currentFormalVerdict, reviewStatus, discussionMessages, proposalReference, readAdvisoryRun, readDiscussionSession, readJson, readSubmittedBallots } from './discussion.mjs';
import { pendingInvitationIds, planInvitations, prepareInvitations, readInvitationDelivery, retryInvitation } from './invitations.mjs';
import { PollStore } from './polls.mjs';
import { isDirectory, isFile, readText } from './store-files.mjs';
import { TeamStore } from './team.mjs';

const formalModes = new Set(['council', 'review']);
const sessionViews = {
  reviews: ['council', 'review'],
  debates: ['council', 'review', 'debate'],
  delegations: ['delegate', 'parallel', 'pipeline']
};

function readCouncilSession(base, id, selected, view, cwd) {
  const dir = join(base, id);
  const session = readDiscussionSession(dir, id);
  if (!session || !sessionViews[view].includes(session.mode)) return null;
  const formal = formalModes.has(session.mode);
  const saved = formal ? currentFormalVerdict(dir, session) : null;
  const interactive = session.mode === 'debate' && session.$schema === roomSchema;
  const room = interactive ? (selected ? readDebate(cwd, id) : readDebateRoom(cwd, id)) : null;
  const advisory = !formal && !interactive ? readAdvisoryRun(dir, session) : null;
  const failure = formal && !saved ? readAdvisoryRun(dir, session) : null;
  const taskDir = join(dir, 'task');
  const task = interactive ? session.question : isDirectory(taskDir) ? readText(join(taskDir, 'task.md'), 1024 * 1024)?.trim() : null;
  const summary = {
    id, mode: session.mode, interactive, question: task?.slice(0, 220) || id, createdAt: session.createdAt,
    status: interactive ? (room.closedAt ? 'closed' : 'open')
      : advisory?.status ?? (failure?.status === 'incomplete' ? 'incomplete' : reviewStatus(saved)),
    ...(room ? { closedAt: room.closedAt, createdBy: room.createdBy } : {}),
    ...(advisory ? { standalone: true, updatedAt: advisory.updatedAt ?? session.createdAt } : {}),
    ...(formal ? { updatedAt: saved?.verdict.validation.validatedAt ?? failure?.updatedAt ?? session.createdAt } : {})
  };
  if (!selected) return { summary, detail: null };
  const proposal = proposalReference(dir, session, saved?.verdict.validation);
  const detail = { ...summary, task: task?.slice(0, 2400) || id, participants: session.participants ?? [] };
  if (view !== 'reviews') {
    const invitationDelivery = interactive ? readInvitationDelivery(cwd, id, { closed: Boolean(room.closedAt) }) : null;
    const invitations = invitationDelivery?.targets ?? null;
    const names = new Map(invitations?.map(target => [target.address, target.label]));
    const messages = interactive ? room.messages.map(message => ({ ...message, agent: names.get(message.author) }))
      : discussionMessages(dir, session, proposal);
    const polls = interactive ? new PollStore(cwd).list({ sourceDebateId: id }).polls : [];
    return { summary, detail: { ...detail, messages, invitations, invitationDelivery, polls, decision: room?.decision ?? null,
      reportPath: advisory?.reportPath ?? failure?.reportPath ?? null, error: advisory?.error ?? failure?.error ?? null,
      execution: advisory?.execution ?? null } };
  }
  const reportPath = saved ? join(dir, saved.folder, 'report.md') : null;
  return { summary, detail: { ...detail,
    tally: saved?.verdict.tally ?? null, validation: saved?.verdict.validation ?? null,
    ballots: readSubmittedBallots(dir, session, proposal), proposal,
    reportPath: reportPath && isFile(reportPath) ? reportPath : failure?.reportPath ?? null,
    ...(failure?.error ? { error: failure.error } : {})
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
    case 'reviews': return sessions(cwd, args.id, 'reviews', 'review',
      (base, id, selected) => readCouncilSession(base, id, selected, 'reviews', cwd));
    case 'debates': return sessions(cwd, args.id, 'debates', 'debate',
      (base, id, selected) => readCouncilSession(base, id, selected, 'debates', cwd));
    case 'task-match': return { matches: matchesDesktopTask(join(cwd, '.agent_workspace'), args) };
    case 'delegations': {
      const result = sessions(cwd, args.id, 'delegations', 'delegation', (base, id, selected) =>
        readDelegation(base, id, selected) ?? readCouncilSession(base, id, selected, 'delegations', cwd));
      const job = result.delegation;
      if (job?.teamMember || job?.teamSource) {
        job.related = runRelations(job, sessions(cwd, null, 'delegations', 'delegation', readDelegation).delegations);
      }
      return result;
    }
    case 'activity': {
      if (args.id != null) return projectRequest(cwd, 'delegations', { id: args.id });
      const errors = [];
      const projects = Array.isArray(args.projects) ? discoverProjects(cwd, args, errors) : [];
      return workspaceActivity(cwd, (project, section) => projectRequest(project, section, {}), { ...args, projects, errors });
    }
    case 'activity-report':
      reportProgress(cwd, args, 'operator');
      return projectRequest(cwd, 'delegations', { id: args.sessionId });
    case 'pending-invitations': return { ids: pendingInvitationIds(cwd, args.space) };
    case 'create':
    case 'debate-create': {
      const plan = planInvitations(args.space, args.recipients);
      const beforePublish = plan ? id => prepareInvitations(cwd, id, plan) : undefined;
      if (action === 'debate-create') {
        const room = createDebate(cwd, args, { beforePublish, fromPanel: true });
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
      closeDebate(cwd, args.id, args, { fromPanel: true });
      return projectRequest(cwd, 'debates', { id: args.id }).debate;
    case 'add-option': return store.addOption(args.id, args.label);
    case 'track': return store.track(args.id, args);
    case 'untrack': return store.untrack(args.id, args.voter);
    case 'vote': return store.vote(args.id, { ...args, voter: 'operator' }, { fromPanel: true });
    case 'close': return store.close(args.id, args.outcome);
    default: throw new Error('Unknown Council panel action.');
  }
}

function containedBy(root, folder) {
  const path = relative(root, folder);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

const ignoredProjectFolders = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'coverage', '__pycache__']);
// The panel starts a fresh helper for each refresh. Always inspect named folders and their
// direct children, then spend a single shared budget on nested projects across the space.
const nestedDirectoryLimit = 128;

function projectFolders(entries) {
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') &&
    !ignoredProjectFolders.has(entry.name.toLowerCase()));
}

function discoverProjects(cwd, args, errors) {
  const scanned = new Map();
  const visited = new Set();
  const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const scan = path => scanned.set(key(path), path);
  const roots = (Array.isArray(args.spaceFolders) ? args.spaceFolders : [args.spaceFolder]).flatMap(folder => {
    if (typeof folder !== 'string' || !isAbsolute(folder)) return [];
    try { return [realpathSync.native(folder)]; } catch { return []; }
  });
  const nested = [];
  const enqueued = new Set();
  function enqueue(path) {
    if (nested.length >= nestedDirectoryLimit || enqueued.has(key(path))) return;
    enqueued.add(key(path));
    nested.push(path);
  }
  for (const folder of [cwd, ...args.projects, ...roots]) {
    if (typeof folder !== 'string' || !isAbsolute(folder)) continue;
    try {
      const project = realpathSync.native(folder);
      if (visited.has(key(project))) continue;
      visited.add(key(project));
      scan(project);
      for (let parent = dirname(project); parent !== dirname(parent) && roots.some(root => containedBy(root, parent)); parent = dirname(parent)) {
        if (lstatSync(join(parent, '.agent_workspace'), { throwIfNoEntry: false })?.isDirectory()) scan(parent);
      }
      if (roots.length) {
        const inSpace = roots.some(root => containedBy(root, project));
        for (const child of projectFolders(readdirSync(project, { withFileTypes: true }))) {
          const candidate = join(project, child.name);
          const workspace = lstatSync(join(candidate, '.agent_workspace'), { throwIfNoEntry: false });
          if (workspace?.isDirectory()) scan(candidate);
          if (inSpace) enqueue(candidate);
        }
      }
    } catch (error) {
      errors.push({ project: folder, error: error.message });
    }
  }
  for (const path of nested) {
    if (visited.has(key(path))) continue;
    try {
      const entries = readdirSync(path, { withFileTypes: true });
      if (entries.some(entry => entry.name === '.agent_workspace' && entry.isDirectory())) scan(path);
      if (nested.length < nestedDirectoryLimit) {
        for (const child of projectFolders(entries)) enqueue(join(path, child.name));
      }
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) errors.push({ project: path, error: error.message });
    }
  }
  return [...scanned.values()];
}

export function desktopRequest(cwd, action, args) {
  const pendingInvites = action === 'pending-invitations';
  if ((!pendingInvites && !Object.hasOwn(sessionViews, action) && action !== 'polls') || args.id != null || !Array.isArray(args.projects)) {
    return projectRequest(cwd, action, args);
  }
  const items = [];
  const errors = [];
  for (const project of discoverProjects(cwd, args, errors)) {
    try {
      if (pendingInvites) {
        items.push(...pendingInvitationIds(project, args.space).map(id => ({ id, project })));
        continue;
      }
      const result = projectRequest(project, action, {});
      items.push(...result[action].map(item => ({ ...item, project })));
      errors.push(...result.errors.map(error => ({ ...error, project })));
    } catch (error) {
      errors.push({ project, error: error.message });
    }
  }
  items.sort((a, b) => Boolean(a.closedAt) - Boolean(b.closedAt) || String(b.createdAt).localeCompare(String(a.createdAt)));
  return { [action]: items, errors };
}
