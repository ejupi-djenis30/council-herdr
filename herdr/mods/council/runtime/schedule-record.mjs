import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isDirectory, isFile, readText } from './store-files.mjs';
import { probeTerminal } from './worker-observation.mjs';

const scheduleLabel = 'council.schedule';
export const scheduleId = id => {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) throw new Error('Use a schedule ID with letters, numbers, or hyphens.');
  return id.toLowerCase();
};

export function latestAttempt(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
    const match = entry.isDirectory() && /^attempt-([1-9]\d*)$/.exec(entry.name);
    return match ? Math.max(latest, Number(match[1])) : latest;
  }, 0);
}

export function attemptDirectory(dir, attempt) {
  return attempt ? join(dir, `attempt-${attempt}`) : dir;
}

export function workerName(schedule, attempt) {
  return `schedule-${schedule.jobPrefix.slice(-12)}${attempt ? '-' + attempt : ''}`;
}

function readOptional(file, limit) {
  const raw = readText(file, limit);
  return raw === null ? null : JSON.parse(raw);
}

function observeScheduleWorker(lookup, schedule, attempt, address, dir) {
  const name = workerName(schedule, attempt);
  let terminal;
  try { terminal = lookup(address || name, 800); } catch {}
  if (!terminal?.address || (address && terminal.address !== address)) return { state: 'unknown' };
  if (attempt === 0) {
    // Legacy workers have no label. Check the generated name and their exact scheduler command or saved claim.
    let pid;
    try { pid = Number(readText(join(dir, 'worker.lock'), 256)); } catch {}
    const argv = terminal.argv;
    const matchesCommand = Array.isArray(argv) && argv.length === 3 && typeof argv[1] === 'string' &&
      basename(argv[1]) === 'schedules.js' && typeof argv[2] === 'string' && isAbsolute(argv[2]) && resolve(argv[2]) === dir;
    if (terminal.name !== name || !(matchesCommand || (address && pid > 0 && pid === terminal.pid))) return { state: 'unknown' };
  } else if (terminal.labels?.[scheduleLabel] !== `${schedule.jobPrefix}-${attempt}`) {
    return { state: 'unknown' };
  }
  if (terminal.state === 'live') return { state: 'live', address: terminal.address };
  if (terminal.state !== 'finished') return { state: 'unknown' };
  return { state: 'stopped', address: terminal.address, exitCode: terminal.exit_code ?? null };
}

export function readScheduleStatus(dir, id, lookup, limit = Infinity) {
  if (!isDirectory(dir)) throw new Error(`Schedule ${id} is unavailable.`);
  const schedule = readOptional(join(dir, 'schedule.json'), limit);
  if (schedule?.$schema !== 'council.schedule/v1' || schedule.id !== scheduleId(id) ||
      typeof schedule.job?.task !== 'string' || typeof schedule.jobPrefix !== 'string') throw new Error('Invalid schedule record.');
  const attempt = latestAttempt(dir);
  const attemptDir = attemptDirectory(dir, attempt);
  if (!isDirectory(attemptDir)) throw new Error('Invalid scheduler attempt directory.');
  const receipt = readOptional(join(attemptDir, 'dispatch.json'), limit) ?? {};
  const readState = () => {
    const saved = readOptional(join(dir, 'state.json'), limit);
    const state = { ...schedule, state: 'scheduled', index: 0, nextAt: schedule.at, ...saved, attempt };
    if ((saved?.attempt ?? 0) !== attempt || !saved) {
      state.state = receipt.error ? 'dispatch_uncertain' : 'scheduled';
      state.workerAddress = receipt.workerAddress ?? null;
      delete state.error;
      if (receipt.error) state.error = receipt.error;
      if (!attempt && !saved) {
        const legacyError = readOptional(join(dir, 'dispatch-error.json'), limit);
        if (legacyError) Object.assign(state, legacyError, { state: 'dispatch_uncertain' });
      }
    }
    state.workerAddress ??= receipt.workerAddress ?? null;
    if (existsSync(join(dir, 'cancelled'))) Object.assign(state, { state: 'cancelled', nextAt: null });
    return state;
  };
  let state = readState();
  if (!lookup || ['finished', 'cancelled'].includes(state.state)) return state;
  const observation = observeScheduleWorker(lookup, schedule, attempt, state.workerAddress, dir);
  if (observation.state === 'stopped') {
    if (latestAttempt(dir) !== attempt) return readScheduleStatus(dir, id, lookup, limit);
    state = readState();
    if (['finished', 'cancelled'].includes(state.state)) return state;
    return { ...state, workerAddress: observation.address, savedState: state.state, state: 'worker_stopped', outcome: 'worker_stopped',
      workerObservation: observation, nextAction: `Run council schedule resume ${schedule.id} to continue from the saved slot.` };
  }
  if (observation.state === 'live' && state.state === 'dispatch_uncertain') state.state = 'starting';
  return { ...state, workerAddress: state.workerAddress ?? observation.address ?? null, workerObservation: observation, ...(observation.state === 'unknown' ? {
    outcome: 'worker_unknown', nextAction: `Inspect hc get ${state.workerAddress || workerName(schedule, attempt)} and the saved schedule before resuming.`
  } : {}) };
}

export function desktopSchedules(cwd, id, lookup = probeTerminal) {
  const limit = 16 * 1024 * 1024;
  const workspace = join(cwd, '.agent_workspace');
  const base = join(workspace, '.schedules');
  if (id != null) scheduleId(id);
  if (!isDirectory(workspace) || !isDirectory(base)) return id == null ? { schedules: [], errors: [] } : { schedule: null };
  if (id != null) {
    const dir = join(base, scheduleId(id));
    if (!isDirectory(dir)) return { schedule: null };
    const schedule = readScheduleStatus(dir, id, lookup, limit);
    const prefix = schedule.jobPrefix + '-';
    // Overdue slots can be skipped. Link only job directories that actually have a saved run.
    const occurrences = readdirSync(workspace, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix) && /^[1-9]\d*$/.test(entry.name.slice(prefix.length)) &&
        isFile(join(workspace, entry.name, 'job.json')))
      .map(entry => ({ id: entry.name, slot: Number(entry.name.slice(prefix.length)) }))
      .sort((a, b) => b.slot - a.slot);
    return { schedule: { ...schedule, occurrences } };
  }
  const schedules = [];
  const errors = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    try {
      if (!isFile(join(dir, 'schedule.json'))) continue;
      const { id, at, everySec, count, job, state, nextAt } = readScheduleStatus(dir, entry.name, undefined, limit);
      schedules.push({ id, project: cwd, question: job.task.trim().slice(0, 220), mode: job.mode || 'delegate', at, everySec, count, state, nextAt });
    } catch (error) {
      errors.push({ id: entry.name, error: error.message });
    }
  }
  return { schedules, errors };
}
