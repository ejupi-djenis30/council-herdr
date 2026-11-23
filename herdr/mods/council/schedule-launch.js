import { prepareTask } from './task-launch.js';

export async function prepareSchedule({ id, task, ...timing }, resolveTiming) {
  const { args, receipt } = prepareTask(task);
  const { at, everySec, count } = await resolveTiming(timing);
  return { id, at, everySec, count, receipt, args: ['schedule', 'create', '--id', id, '--at', at,
    ...(everySec === null ? [] : ['--every', String(everySec)]), ...(count === null ? [] : ['--count', String(count)]), ...args] };
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
  let rejected = false;
  try {
    const result = await dispatch(action === 'create' ? target.args : ['schedule', action, id]);
    let record;
    try { record = JSON.parse(result.stdout); } catch {}
    if (result.code === 0 && record?.id === id && (action === 'cancel' ? record.state === 'cancelled' : record.success === true)) return;
    reason = record?.error || result.stderr?.trim() || 'The scheduler returned no acknowledgement.';
    rejected = record?.success === false;
  } catch (error) {
    reason = error.message;
  }
  // The scheduler may have persisted the request before the Desktop connection timed out.
  if (!rejected) {
    let saved;
    try { saved = (await read(id))?.schedule; } catch {}
    if (action === 'cancel' && saved?.id === id && saved.state === 'cancelled') return;
    const matches = action === 'create' ? matchesSchedule(saved, target) :
      action === 'resume' && saved?.id === id && saved.attempt === target.attempt + 1;
    if (matches) {
      // A matching definition or an attempt directory is written before Herdr starts the scheduler.
      if (saved.workerAddress && saved.state !== 'dispatch_uncertain') return;
      reason = saved.error || reason;
    }
  }
  throw new Error(`${reason} Check schedule ${id} in this project.${action === 'create' ? ' Retrying this form uses the same ID.' : ''}`);
}
