export function isJobRecord(job) {
  return Boolean(job && typeof job === 'object' && job.$schema === 'council.job/v1');
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
  return null;
}

export function jobExpired(job, now = Date.now()) {
  return now > new Date(job.deadlineAt).getTime();
}
