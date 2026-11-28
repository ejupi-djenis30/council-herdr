import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDirectory, readText } from '../herdr/mods/council/runtime/store-files.mjs';
import { WorkItemStore, itemIdPattern } from '../herdr/mods/council/runtime/work-item-store.mjs';
import { jobExpired, jobInterruption, jobRecordProblem, jobRecovery, readDispatchError } from '../herdr/mods/council/runtime/job-record.mjs';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { JobManager } from './jobs.js';
import { callTeamMember } from './team.js';

class Problem extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new Problem(code, message); };
const keys = (obj, allowed) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).some(k => !allowed.includes(k))) fail('invalid_input', 'Invalid or unknown input fields.');
};
const validId = id => { if (typeof id !== 'string' || !itemIdPattern.test(id)) fail('invalid_input', 'Invalid work item ID.'); };
const text = (v, label, max) => {
  if (typeof v !== 'string' || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(v) || !v.trim() || v.trim().length > max) fail('invalid_input', `Invalid ${label}.`);
  return v.trim();
};
function definition(input) {
  keys(input, ['id', 'title', 'roleId', 'criteria']); validId(input.id);
  const title = text(input.title, 'title', 160);
  if (typeof input.roleId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(input.roleId)) fail('invalid_input', 'Invalid role ID.');
  if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 12) fail('invalid_input', 'Provide 1 to 12 criteria.');
  return { id: input.id, title, roleId: input.roleId, criteria: input.criteria.map(v => text(v, 'criterion', 500)) };
}
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function loadDefinition(store,id) {
  let record;
  try { record = store.read(id, 1); } catch (error) {
    if (error.code) throw error;
    fail('integrity_error', `Unreadable definition: ${error.message}`);
  }
  if (!record) fail('not_found', 'Work item not found.');
  try {
    keys(record, ['$schema','id','title','roleId','criteria','createdAt']);
    const normalized = definition({ id: record.id, title: record.title, roleId: record.roleId, criteria: record.criteria });
    if (record.$schema !== 'council.work-item/v1' || record.id !== id || !timestamp(record.createdAt) || !same(normalized, {id:record.id,title:record.title,roleId:record.roleId,criteria:record.criteria})) throw Error('Invalid definition');
  } catch { fail('integrity_error', 'Invalid work item definition.'); }
  return record;
}
function loadIntent(store, item) {
  let intent;
  try { intent = store.read(item.id, 2); } catch (error) {
    if (error.code) throw error;
    return { invalid: true };
  }
  if (intent === null) return null;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return { invalid: true };
  if (Object.keys(intent).sort().join(',') !== ['$schema','createdAt','id','roleId','sessionId','timeoutSec'].sort().join(',') || intent.$schema !== 'council.work-item-dispatch/v1' || intent.id !== item.id || intent.roleId !== item.roleId || !/^wi-job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(intent.sessionId) || !Number.isInteger(intent.timeoutSec) || intent.timeoutSec < 1 || intent.timeoutSec > 3600 || !timestamp(intent.createdAt)) return { invalid: true };
  return intent;
}
const attention = (code, message, job = null) => ({ state:'needs_attention', nextAction:message, canDelegate:false, job, attention:{code,message}, result:null });
function readJob(store, intent) {
  const dir = join(store.base, intent.sessionId);
  try {
    if (!isDirectory(store.base) || !isDirectory(dir)) return {missing:true};
    const raw = readText(join(dir,'job.json'), 16 * 1024 * 1024);
    if (raw === null) return {missing:true};
    const job = JSON.parse(raw);
    if (job?.$schema !== 'council.job/v1' || job.sessionId !== intent.sessionId || job.workItemId !== intent.id || job.mode !== 'delegate' || job.participant?.team?.id !== intent.roleId || !timestamp(job.deadlineAt)) return {invalid:true};
    return {job,dir,problem:jobRecordProblem(job, readDispatchError(dir)?.error)};
  } catch { return {invalid:true}; }
}
// An old worker may have saved an absolute path through a project-root alias.
// Accept that alias only when its project root resolves to this project, and
// still reject links in the workspace, session, and artifact path itself.
function artifactReference(store, sessionId, sessionDir, reference) {
  if (typeof reference !== 'string' || !reference) throw new Error('Invalid artifact reference.');
  let relativePath;
  if (isAbsolute(reference)) {
    const absolute = resolve(reference);
    let ancestor = dirname(absolute);
    while (true) {
      const base = dirname(ancestor);
      if (basename(ancestor) === sessionId && basename(base) === '.agent_workspace') {
        const candidateRoot = dirname(base);
        try {
          const canonical = realpathSync.native(candidateRoot);
          const sameRoot = process.platform === 'win32'
            ? canonical.toLowerCase() === store.root.toLowerCase()
            : canonical === store.root;
          if (sameRoot && isDirectory(base) && isDirectory(ancestor)) {
            relativePath = relative(ancestor, absolute);
            break;
          }
        } catch { /* Keep searching for the actual project-root boundary. */ }
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  } else {
    relativePath = relative(sessionDir, resolve(sessionDir, reference));
  }
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Artifact is outside the job directory.');
  }
  const parts = relativePath.split(sep);
  let path = sessionDir;
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    if (!isDirectory(path)) throw new Error('Artifact directory is missing.');
  }
  path = join(path, parts.at(-1));
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Invalid or oversized artifact.');
  return path;
}

function project(store, item, intent, observation, includeResult = true) {
  if (!intent) return {
    state: 'draft', nextAction: 'Delegate this work item to its recorded role.',
    canDelegate: true, job: null, attention: null, result: null
  };
  if (intent.invalid) return attention('integrity_error', 'Inspect the damaged dispatch intent in this project.');

  const found = readJob(store, intent);
  const publicJob = {
    sessionId: intent.sessionId, linked: false, outcome: 'unconfirmed_start',
    deliveryState: null, deadlineAt: null, address: null
  };
  if (found.missing) {
    return attention('unconfirmed_start', 'Inspect the reserved session and Herdr, then refresh this item.', publicJob);
  }
  if (found.invalid) {
    return attention('integrity_error', 'Inspect the mismatched or unreadable job in this project.',
      { ...publicJob, outcome: 'integrity_error' });
  }

  const job = found.job;
  const info = {
    ...publicJob, linked: true,
    deliveryState: typeof job.deliveryState === 'string' ? job.deliveryState : null,
    deadlineAt: job.deadlineAt,
    address: typeof job.participant?.address === 'string' ? job.participant.address : null
  };
  if (found.problem?.dispatchFailed) {
    return attention('dispatch_failed', jobRecovery('dispatch_failed'), { ...info, outcome: 'dispatch_failed' });
  }
  if (found.problem) {
    return attention('integrity_error', 'Inspect inconsistent job completion evidence.',
      { ...publicJob, outcome: 'integrity_error' });
  }
  if (job.state === 'completed') {
    const capture = job.result;
    let artifactPath = null;
    if (capture.artifactPath != null) {
      try {
        artifactPath = artifactReference(store, intent.sessionId, found.dir, capture.artifactPath);
      } catch {
        return attention('integrity_error', 'Inspect invalid or inaccessible result artifact path.',
          { ...publicJob, outcome: 'integrity_error' });
      }
    }
    return {
      state: 'result_ready', nextAction: 'Review the handoff against the acceptance criteria.',
      canDelegate: false, job: { ...info, outcome: 'completed' }, attention: null,
      result: includeResult ? {
        output: capture.output,
        source: capture.source === 'direct_artifact' ? 'direct_artifact' : 'terminal_screen',
        captureScope: typeof capture.captureScope === 'string' ? capture.captureScope : null,
        artifactPath,
        turn: Number.isSafeInteger(capture.turn) ? capture.turn : null,
        completedAt: timestamp(capture.completedAt) ? capture.completedAt : null
      } : null
    };
  }
  const outcome = observation?.outcome ?? jobInterruption(job, jobExpired(job)) ?? job.state;
  if (['starting', 'deliberating'].includes(outcome) && ['planned', 'attempting', 'acknowledged'].includes(job.deliveryState)) {
    return {
      state: 'in_progress', nextAction: 'Inspect the linked delegation or refresh later.',
      canDelegate: false, job: { ...info, outcome }, attention: null, result: null
    };
  }
  if (['uncertain', 'awaiting_input', 'worker_stopped', 'blocked', 'timed_out', 'failed', 'dispatch_failed'].includes(outcome)) {
    return attention(outcome, jobRecovery(outcome, job.deliveryState) ?? 'Inspect the linked delegation.', { ...info, outcome });
  }
  return attention('integrity_error', 'Inspect the unknown or inconsistent job state.',
    { ...publicJob, outcome: 'integrity_error' });
}
function detail(store,item,observe) { const intent=loadIntent(store,item); return { ...item, $schema:undefined, ...project(store,item,intent,observe) }; }
function role(store,id) { if (!new TeamStore(store.root).readMembers().members.has(id)) fail('role_unavailable',`Team role ${id} is unavailable. Restore it or create another item.`); }
export async function workItemOperation(operation, input={}, options={}) {
  let store, root=null;
  try {
    if (typeof options.project !== 'string' || !isAbsolute(options.project)) fail('invalid_input','Use an absolute project path.');
    try { store=new WorkItemStore(options.project); root=store.root; } catch(e) { fail('storage_error',`Cannot open project: ${e.message}`); }
    if (operation === 'create') {
      const value=definition(input); let existing;
      try { existing=loadDefinition(store,value.id); } catch(e) { if(e.code !== 'not_found') throw e; }
      if (existing) {
        if (!same(value,{id:existing.id,title:existing.title,roleId:existing.roleId,criteria:existing.criteria})) fail('conflict','This ID already has different content.');
      } else {
        role(store,value.roleId);
        const event={$schema:'council.work-item/v1',...value,createdAt:new Date().toISOString()};
        if (!store.publish(value.id,1,event)) {
          existing=loadDefinition(store,value.id);
          if (!same(value,{id:existing.id,title:existing.title,roleId:existing.roleId,criteria:existing.criteria})) fail('conflict','This ID already has different content.');
        } else existing=event;
      }
      return {success:true,project:root,item:detail(store,existing)};
    }
    if (operation === 'list') {
      keys(input,[]); const items=[],errors=[];
      for (const id of store.ids()) {
        try {
          const item = loadDefinition(store, id);
          const { criteria, $schema, ...metadata } = item;
          const { result, ...state } = project(store, item, loadIntent(store, item), undefined, false);
          items.push({ ...metadata, ...state });
        } catch (error) {
          if (error instanceof Problem && error.code === 'not_found' && !store.hasPublishedEvents(id)) continue;
          errors.push({ id, code: 'integrity_error', message: error.message });
        }
      }
      items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {success:true,project:root,items,errors};
    }
    if (!['show','delegate'].includes(operation)) fail('invalid_input','Unknown work-item operation.');
    keys(input,operation === 'show'?['id']:['id','timeoutSec']); validId(input.id);
    if (input.timeoutSec !== undefined && (!Number.isInteger(input.timeoutSec) || input.timeoutSec<1 || input.timeoutSec>3600)) fail('invalid_input','Timeout must be an integer from 1 to 3600.');
    const item=loadDefinition(store,input.id); let intent=loadIntent(store,item);
    if (operation === 'delegate' && intent && !intent.invalid && input.timeoutSec !== undefined && input.timeoutSec !== intent.timeoutSec) fail('conflict','The saved intent has a different timeout.');
    if (operation === 'delegate' && !intent) {
      role(store,item.roleId);
      const candidate={$schema:'council.work-item-dispatch/v1',id:item.id,sessionId:`wi-job-${randomUUID()}`,roleId:item.roleId,timeoutSec:input.timeoutSec ?? 180,createdAt:new Date().toISOString()};
      let won;
      try {
        won = store.publish(item.id, 2, candidate);
      } catch (error) {
        // A hard link may have been published even if acknowledgement failed.
        // Observe it, but never dispatch without a positive publication receipt.
        const observed = loadIntent(store, item);
        if (observed) {
          if (!observed.invalid && input.timeoutSec !== undefined && input.timeoutSec !== observed.timeoutSec) {
            fail('conflict', 'The saved intent has a different timeout.');
          }
          return { success: true, project: root, item: detail(store, item) };
        }
        throw error;
      }
      intent=won?candidate:loadIntent(store,item);
      if (!won && input.timeoutSec !== undefined && !intent?.invalid && input.timeoutSec !== intent?.timeoutSec) fail('conflict','The saved intent has a different timeout.');
      if (won) {
        const task=`Work item ${item.id}: ${item.title}\n\nAcceptance criteria:\n${item.criteria.map((c,i)=>`${i+1}. ${c}`).join('\n')}\n\nProvide a handoff covering the criteria and any remaining steps.`;
        try { await (options.callTeamMember ?? callTeamMember)(options.manager ?? new JobManager({cwd:root}),{member:item.roleId,task,sessionId:intent.sessionId,timeoutSec:intent.timeoutSec,workItemId:item.id}); } catch { /* The durable intent prevents a second dispatch. */ }
      }
    }
    let observation;
    if (operation === 'show' && intent && !intent.invalid) {
      const check=readJob(store,intent);
      if (check.job && !check.problem) { try { observation=await (options.manager ?? new JobManager({cwd:root})).getStatus(intent.sessionId); } catch {} }
    }
    return {success:true,project:root,item:detail(store,item,observation)};
  } catch (error) {
    const domainError = error instanceof Problem;
    return { success: false, project: root, error: {
      code: domainError ? error.code : 'storage_error',
      message: domainError ? error.message : `Storage operation failed: ${error.message}. Check project permissions and local filesystem support.`
    } };
  }
}
