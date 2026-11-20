import { join } from 'node:path';
import { isJobRecord, jobExpired, jobInterruption, jobRecordProblem, jobRecovery } from './job-record.mjs';
import { isDirectory, isFile, readText } from './store-files.mjs';

const SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const OUTPUT_LIMIT = 12000;

function field(value) {
  return typeof value === 'string' && value ? value : null;
}

function dispatchError(dir) {
  try {
    const raw = readText(join(dir, 'dispatch-error.json'), 64 * 1024);
    return raw === null ? null : JSON.parse(raw)?.error || 'Worker dispatch failed';
  } catch {
    // The job reader treats an unreadable dispatch sidecar as unavailable.
    return null;
  }
}

function stateOf(job, problem, expired) {
  if (problem) return problem.dispatchFailed ? 'dispatch_failed' : 'invalid';
  if (job.state === 'completed') return 'completed';
  const interruption = jobInterruption(job, expired);
  if (interruption) return interruption;
  if (job.state === 'failed') return 'failed';
  if (job.state === 'deliberating' && job.deliveryState === 'acknowledged') return 'deliberating';
  if (job.state === 'starting' && job.deliveryState === 'planned') return 'starting';
  if (job.state === 'starting' && job.deliveryState === 'attempting') return 'attempting';
  return 'invalid';
}

function recordedOutputPath(dir) {
  const deliverables = join(dir, 'deliverables');
  try {
    const file = join(deliverables, 'output.txt');
    return isDirectory(deliverables) && isFile(file) ? file : null;
  } catch {
    return null;
  }
}

export function readDelegation(base, id, selected) {
  const dir = join(base, id);
  if (!isDirectory(dir)) return null;
  const raw = readText(join(dir, 'job.json'), SNAPSHOT_LIMIT);
  if (raw === null) return null;
  const job = JSON.parse(raw);
  if (!isJobRecord(job) || job.sessionId !== id || job.mode !== 'delegate') {
    throw new Error('Job record does not match this delegation.');
  }

  const now = Date.now();
  const deadline = Date.parse(job.deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error('Job record has no valid deadline.');
  const expired = jobExpired(job, now);
  const problem = jobRecordProblem(job, dispatchError(dir));
  const status = stateOf(job, problem, expired);
  const task = field(job.task) ?? id;
  const participant = job.participant;
  const ownership = ['borrowed', 'owned'].includes(participant?.ownership) ? participant.ownership : null;
  const summary = {
    id,
    mode: job.mode,
    question: task.slice(0, 220),
    createdAt: field(job.createdAt),
    updatedAt: field(job.updatedAt),
    status,
    agent: ownership === 'owned' ? field(participant?.agent) ?? field(job.agent) : field(participant?.reportedApp),
    ownership,
    address: field(participant?.canonicalAddress) ?? field(participant?.address)
  };
  if (!selected) return { summary, detail: null };

  const output = status === 'completed' ? job.result.output : null;
  const detail = {
    ...summary,
    task: task.slice(0, 2400),
    deliveryState: field(job.deliveryState),
    expired,
    remainingSec: ['starting', 'attempting', 'deliberating'].includes(status)
      ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null,
    workerAddress: field(job.worker?.address),
    wait: {
      reason: field(job.waitDetails?.reason),
      status: field(job.waitDetails?.status),
      turn: Number.isSafeInteger(job.waitDetails?.turn) ? job.waitDetails.turn : null
    },
    error: field(problem?.error) ?? field(job.error) ??
      (status === 'invalid' ? 'The saved state and delivery record are inconsistent.' : null),
    nextAction: jobRecovery(status, job.deliveryState),
    output: output?.slice(0, OUTPUT_LIMIT) ?? null,
    outputTruncated: Boolean(output && output.length > OUTPUT_LIMIT),
    outputPath: output !== null ? recordedOutputPath(dir) : null
  };
  return { summary, detail };
}
