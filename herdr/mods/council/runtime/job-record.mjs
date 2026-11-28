import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readText } from './store-files.mjs';

/**
 * Compute deterministic input fingerprint for job idempotency and conflict detection
 */
export function computeFingerprint(options = {}, workflow = null) {
  const normalized = {
    mode: options.mode || 'delegate',
    task: String(options.task || '').trim(),
    agent: String(options.agent || 'codex').toLowerCase().trim(),
    adopt: options.adopt ? String(options.adopt).trim() : null,
    permission: options.permission || 'read',
    timeoutSec: Number(options.timeoutSec || 180),
    keepTerminals: Boolean(options.keepTerminals || options.keep),
    ...(workflow ? { workflow } : {}),
    ...(options.team ? { team: options.team.id } : {}),
    ...(options.workItemId ? { workItemId: options.workItemId } : {}),
    ...(options.workItemBinding ? { workItemBinding: options.workItemBinding } : {})
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function isJobRecord(job) {
  return Boolean(job && typeof job === 'object' && job.$schema === 'council.job/v1');
}

export function readDispatchError(dir) {
  try {
    const raw = readText(join(dir, 'dispatch-error.json'), 64 * 1024);
    if (raw === null) return null;
    const record = JSON.parse(raw);
    return { error: typeof record?.error === 'string' && record.error || 'Worker dispatch failed',
      failedAt: typeof record?.failedAt === 'string' ? record.failedAt : null };
  } catch {
    return { error: 'Worker dispatch failure record is unreadable', failedAt: null };
  }
}

export function jobRecordProblem(job, dispatchError) {
  const workerClaimed = job.worker?.status === 'claimed' ||
    job.deliveryState !== 'planned' || job.state !== 'starting';
  if (dispatchError && !workerClaimed) {
    return { dispatchFailed: true, error: dispatchError };
  }
  if (job.state === 'completed' && typeof job.result?.output !== 'string') {
    return { corrupt: true, error: 'Completed job record is corrupt or incomplete (missing result payload)' };
  }
  if (job.state === 'completed' && job.deliveryState !== 'acknowledged') {
    return { corrupt: true, error: 'Completed job record is inconsistent (missing acknowledged delivery)' };
  }
  return null;
}

export function jobExpired(job, now = Date.now()) {
  return now > new Date(job.deadlineAt).getTime();
}

export function jobInterruption(job, expired, workerObservation) {
  if (job.state === 'completed') return null;
  if (job.deliveryState === 'uncertain' || job.state === 'uncertain') return 'uncertain';
  if (job.state === 'failed') {
    if (job.failureKind === 'timed_out' || job.waitDetails?.reason === 'timeout' || job.waitDetails?.isTimeout === true) return 'timed_out';
    if (job.waitDetails?.status === 'blocked' || job.waitDetails?.reason === 'blocked') return 'blocked';
    return null;
  }
  if (workerObservation?.state === 'stopped') return 'worker_stopped';
  if (expired) return 'timed_out';
  if (job.state === 'deliberating' && job.awaitingInput === true &&
      (job.deliveryState === 'acknowledged' || (job.workflow && job.deliveryState === 'attempting'))) return 'awaiting_input';
  return null;
}

export function jobRecovery(outcome, deliveryState) {
  switch (outcome) {
    case 'uncertain':
      return 'Inspect the terminal and its delivery record before submitting the task again.';
    case 'awaiting_input':
      return 'Open the participant terminal and address the prompt. Council will keep collecting until the job deadline.';
    case 'worker_stopped':
      return deliveryState === 'planned'
        ? 'Inspect the worker terminal and its session claim before starting another job.'
        : 'Inspect the participant terminal for the existing task and its answer before starting another job.';
    case 'blocked':
      return 'Council stopped collecting this turn. Open the terminal and resolve any prompt there. Read the resulting answer in Herdr before starting another job.';
    case 'timed_out':
      return deliveryState === 'acknowledged'
        ? 'Council reached its deadline before saving a capture. The agent may still be working. Inspect the existing terminal before starting another job.'
        : 'Council reached its deadline without a saved result. Inspect the delivery record before submitting the task again.';
    case 'failed':
    case 'dispatch_failed':
      return 'Inspect the saved error and any recorded terminals before starting another job with a new session ID.';
    default:
      return null;
  }
}
