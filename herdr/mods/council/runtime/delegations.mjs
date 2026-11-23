import { join } from 'node:path';
import { jobTimeline, readProgress } from './activity-log.mjs';
import { isJobRecord, jobExpired, jobInterruption, jobRecordProblem, jobRecovery } from './job-record.mjs';
import { isDirectory, isFile, readText } from './store-files.mjs';
import { observeWorker, sameActiveWorker } from './worker-observation.mjs';

const SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const OUTPUT_LIMIT = 12000;

function field(value) {
  return typeof value === 'string' && value ? value : null;
}

function dispatchError(dir) {
  try {
    const raw = readText(join(dir, 'dispatch-error.json'), 64 * 1024);
    if (raw === null) return null;
    const record = JSON.parse(raw);
    return { error: field(record?.error) ?? 'Worker dispatch failed', failedAt: field(record?.failedAt) };
  } catch {
    // The job reader treats an unreadable dispatch sidecar as unavailable.
    return null;
  }
}

function stateOf(job, problem, expired, workerObservation) {
  if (problem) return problem.dispatchFailed ? 'dispatch_failed' : 'invalid';
  if (job.state === 'completed') return 'completed';
  const interruption = jobInterruption(job, expired, workerObservation);
  if (interruption) return interruption;
  if (job.state === 'failed') return 'failed';
  if (job.workflow && job.state === 'deliberating' && job.deliveryState === 'attempting') return 'deliberating';
  if (job.state === 'deliberating' && job.deliveryState === 'acknowledged') return 'deliberating';
  if (job.state === 'starting' && job.deliveryState === 'planned') return 'starting';
  if (job.state === 'starting' && job.deliveryState === 'attempting') return 'attempting';
  return 'invalid';
}

function recordedOutputPath(dir, workflow) {
  if (workflow) {
    const report = join(dir, 'workflow-report.md');
    return isFile(report) ? report : null;
  }
  const deliverables = join(dir, 'deliverables');
  try {
    const file = join(deliverables, 'output.txt');
    return isDirectory(deliverables) && isFile(file) ? file : null;
  } catch {
    return null;
  }
}

function readJob(dir, id) {
  const raw = readText(join(dir, 'job.json'), SNAPSHOT_LIMIT);
  if (raw === null) return null;
  const job = JSON.parse(raw);
  if (!isJobRecord(job) || job.sessionId !== id || (job.mode !== 'delegate' && !job.workflow)) {
    throw new Error('Job record does not match this delegation.');
  }
  return job;
}

export function readDelegation(base, id, selected, lookupWorker) {
  const dir = join(base, id);
  if (!isDirectory(dir)) return null;
  let job = readJob(dir, id);
  if (!job) return null;
  // Keep listing sessions a disk-only operation. Check the worker on the selected session.
  let workerObservation = selected ? observeWorker(job, dir, lookupWorker) : null;
  if (workerObservation?.state === 'stopped') {
    const latest = readJob(dir, id);
    if (!latest) return null;
    if (!sameActiveWorker(job, latest)) workerObservation = null;
    job = latest;
  }

  const now = Date.now();
  const deadline = Date.parse(job.deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error('Job record has no valid deadline.');
  const expired = jobExpired(job, now);
  const dispatch = dispatchError(dir);
  const problem = jobRecordProblem(job, dispatch?.error);
  const status = stateOf(job, problem, expired, workerObservation);
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
    address: field(participant?.canonicalAddress) ?? field(participant?.address),
    teamMember: field(participant?.team?.id),
    teamSource: field(job.teamSource),
    power: field(participant?.power),
    deadlineAt: job.deadlineAt
  };
  if (!selected) return { summary, detail: null };

  const output = status === 'completed' || (job.workflow && status === 'failed') ? field(job.result?.output) : null;
  let progress;
  try { progress = readProgress(dir); }
  catch { progress = { notes: [], count: 0, unreadable: 1 }; }
  const detail = {
    ...summary,
    task: task.slice(0, 2400),
    deliveryState: field(job.deliveryState),
    expired,
    remainingSec: ['starting', 'attempting', 'deliberating', 'awaiting_input'].includes(status)
      ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null,
    workerAddress: field(job.worker?.address),
    workerObservation,
    ...(participant?.team ? { team: {
      role: field(participant.team.role), power: field(participant.power), error: field(participant.powerError)
    } } : {}),
    wait: {
      reason: field(job.waitDetails?.reason),
      status: field(job.waitDetails?.status),
      turn: Number.isSafeInteger(job.waitDetails?.turn) ? job.waitDetails.turn : null
    },
    error: field(problem?.error) ?? field(job.error) ??
      (status === 'invalid' ? 'The saved state and delivery record are inconsistent.' : null),
    nextAction: jobRecovery(status, job.deliveryState),
    timeline: jobTimeline(job, { dispatchFailed: problem?.dispatchFailed ? dispatch : null, status }),
    progress,
    output: output?.slice(0, OUTPUT_LIMIT) ?? null,
    outputTruncated: Boolean(output && output.length > OUTPUT_LIMIT),
    outputPath: output !== null ? recordedOutputPath(dir, job.workflow) : null
  };
  return { summary, detail };
}
