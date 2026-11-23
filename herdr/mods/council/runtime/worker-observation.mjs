import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isDirectory, readText } from './store-files.mjs';

export const workerLabel = 'council.worker';

function activeWorker(job) {
  return ['starting', 'deliberating'].includes(job?.state) && job.worker?.status === 'claimed' ? job.worker : null;
}

export function sameActiveWorker(before, after) {
  const current = activeWorker(after);
  const previous = activeWorker(before);
  return Boolean(current && previous && current.label === previous.label &&
    current.address === previous.address && current.pid === previous.pid);
}

function probeTerminal(address, timeout) {
  const result = spawnSync('hc', ['get', '--json', address], { timeout, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? JSON.parse(result.stdout) : null;
}

function retainedClaim(sessionDir, pid) {
  try {
    const locks = join(sessionDir, '.locks');
    if (!isDirectory(locks)) return false;
    const record = readText(join(locks, 'worker.lock'), 4096);
    return record !== null && JSON.parse(record)?.pid === pid;
  } catch {
    return null;
  }
}

export function observeWorker(job, sessionDir, lookup = probeTerminal) {
  const worker = activeWorker(job);
  if (!worker) return null;
  const { address, pid, label } = worker;
  if (typeof address !== 'string' || !/^t[0-9a-z]+$/.test(address) || !Number.isSafeInteger(pid) || pid <= 0 ||
      typeof label !== 'string' || !label) return { state: 'unknown' };

  let terminal;
  try { terminal = lookup(address, 800); } catch { return { state: 'unknown' }; }
  if (terminal?.address !== address || terminal.pid !== pid || terminal.labels?.[workerLabel] !== label) {
    return { state: 'unknown' };
  }
  if (terminal.state === 'live') return { state: 'live' };
  if (terminal.state !== 'finished') return { state: 'unknown' };
  return {
    state: 'stopped',
    exitCode: Number.isInteger(terminal.exit_code) ? terminal.exit_code : null,
    reason: typeof terminal.reason === 'string' ? terminal.reason : null,
    retainedClaim: retainedClaim(sessionDir, pid)
  };
}
