import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { inspectGitRoot, readGitActivity } from './activity-git.mjs';
import { readProgress, saveProgress } from './activity-log.mjs';
import { attachPlanChanges, plansComponent, readPlan } from './activity-plan.mjs';
import { readDelegation } from './delegations.mjs';
import { isDirectory } from './store-files.mjs';

const current = new Set(['starting', 'attempting', 'deliberating']);
const attention = new Set(['blocked', 'uncertain', 'timed_out', 'dispatch_failed', 'failed', 'invalid']);
const sessionKey = /^[a-zA-Z0-9_-]{1,240}$/;
const activityLimit = 18;

function contains(parent, folder) {
  const path = relative(parent, folder);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

function workspaceMarker(folder) {
  const plan = lstatSync(join(folder, 'PLAN.md'), { throwIfNoEntry: false });
  const store = lstatSync(join(folder, '.agent_workspace'), { throwIfNoEntry: false });
  return Boolean(plan?.isFile() || store?.isDirectory());
}

export function activityScope(cwd, { followFocus, spaceFolder } = {}) {
  const folder = realpathSync.native(cwd);
  const git = inspectGitRoot(folder);
  if (followFocus !== true) return { folder, project: folder, git };
  const root = git.root && realpathSync.native(git.root);
  let space = null;
  if (typeof spaceFolder === 'string' && isAbsolute(spaceFolder)) {
    try { space = realpathSync.native(spaceFolder); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let boundary = root || folder;
  if (space && contains(space, folder) && (!root || contains(root, space))) boundary = space;
  if (!contains(boundary, folder)) return { folder, project: folder, git };
  for (let project = folder; relative(boundary, project); project = dirname(project)) {
    if (workspaceMarker(project)) return { folder, project, git };
  }
  return { folder, project: boundary, git };
}

export function runGroup(job) {
  if (attention.has(job.status) || job.power === 'unconfirmed') return 'attention';
  return current.has(job.status) || job.power === 'stopping' ? 'active' : 'ready';
}

export function runRelations(job, summaries) {
  const parent = job.teamSource && summaries.find(item => item.id === job.teamSource);
  return {
    parent: parent ? { id: parent.id, member: parent.teamMember, status: parent.status } : null,
    children: summaries.filter(item => item.teamSource === job.id)
      .slice(0, 24).map(item => ({ id: item.id, member: item.teamMember, status: item.status }))
  };
}

function summarizeRuns(base, all, errors) {
  const counts = { active: 0, attention: 0, ready: 0 };
  const latest = job => {
    try {
      const progress = readProgress(join(base, job.id), 5);
      if (progress.unreadable) errors.push({ source: 'Progress', detail: `${job.id}: unreadable note` });
      return progress.notes.at(-1) ?? null;
    } catch (error) {
      errors.push({ source: 'Progress', detail: `${job.id}: ${error.message}` });
      return null;
    }
  };
  const runs = all.map(job => {
    const note = latest(job);
    const at = job.updatedAt || job.createdAt || '';
    return { ...job, group: runGroup(job), note, activityAt: note && Date.parse(note.at) > (Date.parse(at) || 0) ? note.at : at };
  }).sort((a, b) => (Date.parse(b.activityAt) || 0) - (Date.parse(a.activityAt) || 0) || a.id.localeCompare(b.id))
    .filter(job => ++counts[job.group] <= activityLimit)
    .map(job => ({ ...job, related: job.teamSource || job.teamMember ? runRelations(job, all) : null }));
  return { counts, runs };
}

function decisionsFrom(polls, debates, reviews) {
  return [
    ...polls.filter(item => !item.closedAt).map(item => ({ ...item, tab: 'polls', state: 'open' })),
    ...debates.filter(item => item.status === 'open').map(item => ({ ...item, tab: 'debates', state: 'open' })),
    ...reviews.filter(item => !['approved', 'rejected'].includes(item.status)).map(item => ({ ...item, tab: 'reviews', state: item.status }))
  ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function workspaceActivity(cwd, read, options) {
  const { project, folder, git: probe } = activityScope(cwd, options);
  const base = join(project, '.agent_workspace');
  const errors = [];
  const get = name => {
    try {
      const result = read(project, name);
      for (const error of result.errors ?? []) errors.push({ source: name, detail: `${error.id ?? 'Record'}: ${error.error}` });
      return result[name] ?? [];
    } catch (error) {
      errors.push({ source: name, detail: error.message });
      return [];
    }
  };
  const { counts, runs } = summarizeRuns(base, get('delegations'), errors);
  const decisions = decisionsFrom(get('polls'), get('debates'), get('reviews'));
  const git = readGitActivity(project, probe);
  if (git.statusIssue) errors.push({ source: 'Git', detail: git.statusIssue });
  let plan = null;
  try {
    const declared = readPlan(project);
    if (declared) {
      plan = attachPlanChanges(declared, git.files);
      for (const component of plan.components) {
        component.reports = runs.filter(run => run.note?.component === component.id)
          .slice(0, 6).map(run => ({ id: run.id, member: run.teamMember, ...run.note }));
      }
    }
  } catch (error) {
    errors.push({ source: 'PLAN.md', detail: error.message });
  }
  return { $schema: 'council.activity/v1', project, folder, counts, runs, decisions: decisions.slice(0, activityLimit),
    decisionCount: decisions.length, plan, git, errors: errors.slice(0, 25) };
}

export function reportProgress(cwd, args, terminalId) {
  if (typeof args.sessionId !== 'string' || !sessionKey.test(args.sessionId)) throw new Error('A valid delegation session ID is required.');
  const base = join(realpathSync.native(cwd), '.agent_workspace');
  if (!isDirectory(base) || !readDelegation(base, args.sessionId, false)) throw new Error('Delegation not found in this project.');
  return saveProgress(join(base, args.sessionId), args, terminalId, id => plansComponent(readPlan(cwd), id));
}
