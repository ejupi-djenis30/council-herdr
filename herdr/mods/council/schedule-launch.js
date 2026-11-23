import { prepareTask } from './task-launch.js';
import { fitsScheduleDates, parseScheduleTime } from './runtime/schedule-time.mjs';

export function prepareSchedule({ id, firstRun, repeating, interval, runs, task }, immediateAt) {
  const { args, receipt } = prepareTask(task);
  const date = firstRun.trim();
  const first = parseScheduleTime(date || immediateAt, { requireDateTime: true });
  if (!Number.isFinite(first)) throw new Error('Enter an existing date and time as YYYY-MM-DD HH:mm in local time or an ISO timestamp with a time zone.');
  const everySec = repeating ? Number(interval) : null;
  const count = repeating ? (runs.trim() ? Number(runs) : null) : 1;
  if (repeating && (!Number.isFinite(everySec) || everySec < 1)) throw new Error('Enter a repeat interval of at least one second.');
  if (count !== null && (!Number.isSafeInteger(count) || count < 1)) throw new Error('Enter a positive whole number of runs.');
  if (!fitsScheduleDates(first, everySec, count)) throw new Error('The repeat interval and run count exceed the supported date range.');
  const at = new Date(first).toISOString();
  return { id, at, everySec, count, receipt, args: ['schedule', 'create', '--id', id, '--at', at,
    ...(repeating ? ['--every', String(everySec)] : []), ...(count === null ? [] : ['--count', String(count)]), ...args] };
}

function matchesSchedule(schedule, { id, at, everySec, count, receipt }) {
  const job = schedule?.job;
  if (!job || schedule.id !== id || schedule.at !== at || schedule.everySec !== everySec || schedule.count !== count) return false;
  if ((job.mode || 'delegate') !== receipt.mode || job.task?.trim() !== receipt.task || (job.agent || 'codex') !== receipt.agent ||
      (job.permission || 'read') !== receipt.permission || (job.timeoutSec ?? 180) !== receipt.timeoutSec ||
      Boolean(job.keepTerminals) !== receipt.keepTerminals || job.adopt || job.sessionId) return false;
  if (!receipt.workflow) return !job.context && !job.criteria && !job.representative && !job.agents?.length &&
    !job.subtasks?.length && !job.stages?.length && !job.previousSession && (job.round ?? 1) === 1;
  const workflow = receipt.workflow;
  return (job.context ?? '') === workflow.context && (job.criteria ?? '') === workflow.criteria &&
    (job.representative ?? null) === workflow.representative && (job.round ?? 1) === workflow.round &&
    (job.previousSession ?? null) === workflow.previousSession &&
    ['agents', 'subtasks', 'stages'].every(key => JSON.stringify(job[key] ?? []) === JSON.stringify(workflow[key]));
}

export async function submitSchedule(action, target, dispatch, read) {
  const { id } = target;
  let reason;
  try {
    const result = await dispatch(action === 'create' ? target.args : ['schedule', action, id]);
    let record;
    try { record = JSON.parse(result.stdout); } catch {}
    if (result.code === 0 && record?.id === id && (action === 'cancel' ? record.state === 'cancelled' : record.success === true)) return;
    reason = record?.error || result.stderr?.trim() || 'The scheduler returned no acknowledgement.';
  } catch (error) {
    reason = error.message;
  }
  // The scheduler may have persisted the request before the Desktop connection timed out.
  let saved;
  try { saved = (await read(id))?.schedule; } catch {}
  if (action === 'create' && matchesSchedule(saved, target)) return;
  if (action === 'cancel' && saved?.id === id && saved.state === 'cancelled') return;
  if (action === 'resume' && saved?.id === id && saved.attempt > target.attempt) return;
  throw new Error(`${reason} Check schedule ${id} in this project.${action === 'create' ? ' Retrying this form uses the same ID.' : ''}`);
}
