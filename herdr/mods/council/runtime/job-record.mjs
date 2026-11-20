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
  if (job.state === 'completed' && job.deliveryState !== 'acknowledged') {
    return { corrupt: true, error: 'Completed job record is inconsistent (missing acknowledged delivery)' };
  }
  return null;
}

export function jobExpired(job, now = Date.now()) {
  return now > new Date(job.deadlineAt).getTime();
}

export function jobInterruption(job, expired) {
  if (job.state === 'completed') return null;
  if (job.deliveryState === 'uncertain' || job.state === 'uncertain') return 'uncertain';
  if (job.state === 'failed') {
    if (job.waitDetails?.status === 'blocked' || job.waitDetails?.reason === 'blocked') return 'blocked';
    if (job.failureKind === 'timed_out' || job.waitDetails?.reason === 'timeout' || job.waitDetails?.isTimeout === true) return 'timed_out';
    return null;
  }
  return expired ? 'timed_out' : null;
}

export function jobRecovery(outcome, deliveryState) {
  switch (outcome) {
    case 'uncertain':
      return 'Inspect the terminal and its delivery record before submitting the task again.';
    case 'blocked':
      return 'Open the terminal and resolve any prompt there. Inspect the resulting turn before starting another job.';
    case 'timed_out':
      return deliveryState === 'acknowledged'
        ? 'Council reached its deadline before saving a capture. The agent may still be working. Inspect the existing terminal before starting another job.'
        : 'Council reached its deadline without a saved result. Inspect the delivery record before submitting the task again.';
    default:
      return null;
  }
}
