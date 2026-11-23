import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HerdrClient } from './herdr.js';
import { JobManager } from './jobs.js';
import { atomicWrite } from './workspace.js';
import { workflowInputs } from './workflow-job.js';

const entry = fileURLToPath(import.meta.url);
const scheduleLabel = 'council.schedule';
const scheduleId = id => {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) throw new Error('Use a schedule ID with letters, numbers, or hyphens.');
  return id.toLowerCase();
};

function latestAttempt(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
    const match = entry.isDirectory() && /^attempt-([1-9]\d*)$/.exec(entry.name);
    return match ? Math.max(latest, Number(match[1])) : latest;
  }, 0);
}

function attemptDirectory(dir, attempt) {
  return attempt ? join(dir, `attempt-${attempt}`) : dir;
}

function workerName(schedule, attempt) {
  return `schedule-${schedule.jobPrefix.slice(-12)}${attempt ? '-' + attempt : ''}`;
}

function readOptional(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function observeScheduleWorker(herdr, schedule, attempt, address, dir) {
  const name = workerName(schedule, attempt);
  let probe;
  try { probe = herdr.get?.(address || name, { timeout: 800 }); } catch {}
  const terminal = probe?.success && probe.details;
  if (!terminal?.address || (address && terminal.address !== address)) return { state: 'unknown' };
  if (attempt === 0) {
    // Legacy workers have no label. Check the generated name and their exact scheduler command or saved claim.
    let pid;
    try { pid = Number(readFileSync(join(dir, 'worker.lock'), 'utf8')); } catch {}
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

export class ScheduleManager {
  constructor({ cwd = process.cwd(), herdr = new HerdrClient({ cwd }) } = {}) {
    this.cwd = resolve(cwd);
    this.herdr = herdr;
    this.base = join(this.cwd, '.agent_workspace', '.schedules');
  }

  path(id) { return join(this.base, scheduleId(id)); }

  status(id) {
    const dir = this.path(id);
    const schedule = JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8'));
    if (schedule.$schema !== 'council.schedule/v1' || schedule.id !== scheduleId(id)) throw new Error('Invalid schedule record.');
    const attempt = latestAttempt(dir);
    const attemptDir = attemptDirectory(dir, attempt);
    const receipt = readOptional(join(attemptDir, 'dispatch.json')) ?? {};
    const readState = () => {
      const saved = readOptional(join(dir, 'state.json'));
      const state = { ...schedule, state: 'scheduled', index: 0, nextAt: schedule.at, ...saved, attempt };
      if ((saved?.attempt ?? 0) !== attempt || !saved) {
        state.state = receipt.error ? 'dispatch_uncertain' : 'scheduled';
        state.workerAddress = receipt.workerAddress ?? null;
        delete state.error;
        if (receipt.error) state.error = receipt.error;
        if (!attempt && !saved) {
          const legacyError = readOptional(join(dir, 'dispatch-error.json'));
          if (legacyError) Object.assign(state, legacyError, { state: 'dispatch_uncertain' });
        }
      }
      state.workerAddress ??= receipt.workerAddress ?? null;
      if (existsSync(join(dir, 'cancelled'))) Object.assign(state, { state: 'cancelled', nextAt: null });
      return state;
    };
    let state = readState();
    if (['finished', 'cancelled'].includes(state.state)) return state;
    const observation = observeScheduleWorker(this.herdr, schedule, attempt, state.workerAddress, dir);
    if (observation.state === 'stopped') {
      if (latestAttempt(dir) !== attempt) return this.status(id);
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

  list() {
    if (!existsSync(this.base)) return [];
    return readdirSync(this.base, { withFileTypes: true }).filter(entry => entry.isDirectory() &&
      existsSync(join(this.base, entry.name, 'schedule.json'))).map(({ name }) => this.status(name));
  }

  create({ id = randomUUID(), at, everySec, count, job }) {
    id = scheduleId(id);
    if (typeof job?.task !== 'string' || !job.task.trim()) throw new Error('A schedule requires a task.');
    if ((job.permission !== undefined && !['read', 'write'].includes(job.permission)) ||
        (job.timeoutSec !== undefined && (!Number.isFinite(job.timeoutSec) || job.timeoutSec <= 0))) {
      throw new Error('Use read or write permission and a positive job timeout.');
    }
    workflowInputs(job, job.mode || 'delegate');
    const first = at === undefined ? Date.now() : Date.parse(at);
    const interval = everySec === undefined ? null : Number(everySec);
    const total = count === undefined ? (interval === null ? 1 : null) : Number(count);
    if (!Number.isFinite(first) || (interval !== null && (!Number.isFinite(interval) || interval < 1)) ||
        (total !== null && (!Number.isSafeInteger(total) || total < 1)) || (interval === null && total !== 1)) {
      throw new Error('Use a valid start time, a repeat interval of at least one second, and a positive repeat count.');
    }

    const dir = this.path(id);
    mkdirSync(this.base, { recursive: true });
    try { mkdirSync(dir); } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Schedule ${id} already exists.`);
      throw error;
    }
    const schedule = { $schema: 'council.schedule/v1', id, at: new Date(first).toISOString(), everySec: interval,
      count: total, jobPrefix: `scheduled-${randomUUID()}`, job };
    atomicWrite(join(dir, 'schedule.json'), JSON.stringify(schedule, null, 2));
    return this.#dispatch(schedule, 1);
  }

  #dispatch(schedule, attempt) {
    const { id } = schedule;
    const dir = this.path(id);
    const attemptDir = attemptDirectory(dir, attempt);
    // A unique directory claims this replacement. Concurrent clients cannot launch the same attempt.
    try { mkdirSync(attemptDir); } catch (error) {
      if (error.code === 'EEXIST') return { success: false, id, error: 'Another client already dispatched this scheduler attempt. Check schedule status.' };
      throw error;
    }
    const dispatched = this.herdr.exec(['run', '--bg', '--outlive-parent', '--no-notify', '--json', '--name', workerName(schedule, attempt),
      '--label', `${scheduleLabel}=${schedule.jobPrefix}-${attempt}`, '--cwd', this.cwd, '--', process.execPath, entry, dir, String(attempt)], { timeout: 10000 });
    const workerAddress = dispatched.success ? this.herdr.parseJson(dispatched.stdout)?.address : null;
    const receiptFile = join(attemptDir, 'dispatch.json');
    if (!workerAddress) {
      const error = dispatched.stderr || dispatched.error?.message || 'Herdr did not confirm scheduler dispatch.';
      atomicWrite(receiptFile, JSON.stringify({ error }));
      return { success: false, id, error, nextAction: `Inspect council schedule status ${id}.` };
    }
    atomicWrite(receiptFile, JSON.stringify({ workerAddress }));
    return { success: true, id, at: schedule.at, everySec: schedule.everySec, count: schedule.count, workerAddress, attempt };
  }

  resume(id) {
    const schedule = this.status(id);
    if (schedule.state !== 'worker_stopped') return { success: false, id: schedule.id, state: schedule.state,
      error: 'Resume requires a positively identified, stopped scheduler with an unfinished schedule.',
      ...(schedule.nextAction ? { nextAction: schedule.nextAction } : {}) };
    return this.#dispatch(schedule, schedule.attempt + 1);
  }

  cancel(id) {
    readFileSync(join(this.path(id), 'schedule.json'), 'utf8');
    const file = join(this.path(id), 'cancelled');
    if (!existsSync(file)) {
      try { writeFileSync(file, new Date().toISOString(), { flag: 'wx' }); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    return this.status(id);
  }
}

function waitForSlot(dir, time) {
  if (time <= Date.now() || existsSync(join(dir, 'cancelled'))) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error); else resolve();
    };
    const watcher = watch(dir, () => { if (existsSync(join(dir, 'cancelled'))) finish(); });
    const timer = setTimeout(() => finish(), Math.min(time - Date.now(), 2 ** 31 - 1));
    watcher.once('error', finish);
    if (existsSync(join(dir, 'cancelled'))) finish();
  });
}

export async function runSchedule(dir, manager, attempt = existsSync(join(dir, 'attempt-1')) ? 1 : 0) {
  const file = join(dir, 'schedule.json');
  const schedule = JSON.parse(readFileSync(file, 'utf8'));
  if (schedule.$schema !== 'council.schedule/v1') throw new Error('Invalid schedule.');
  if (!Number.isSafeInteger(attempt) || attempt < 0 || latestAttempt(dir) !== attempt) throw new Error('Scheduler attempt has been superseded or is invalid.');
  const claim = join(attemptDirectory(dir, attempt), 'worker.lock');
  writeFileSync(claim, String(process.pid), { flag: 'wx' });
  const statePath = join(dir, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { index: 0, lastJob: null };
  state.attempt = attempt;
  state.workerAddress = manager.herdr?.terminalId ?? null;
  delete state.error;
  const save = () => atomicWrite(statePath, JSON.stringify(state, null, 2));
  const cancelled = () => existsSync(join(dir, 'cancelled'));
  try {
    const origin = Date.parse(schedule.at);
    const interval = (schedule.everySec ?? 0) * 1000;
    while ((schedule.count === null || state.index < schedule.count) && !cancelled()) {
      const time = origin + state.index * interval;
      state.state = 'scheduled';
      state.nextAt = new Date(time).toISOString();
      save();
      while (!cancelled() && time > Date.now()) await waitForSlot(dir, time);
      if (cancelled()) break;

      const sessionId = `${schedule.jobPrefix}-${state.index + 1}`;
      state.state = 'dispatching';
      state.lastJob = { sessionId };
      save();
      // startJob reconnects to an existing slot's durable record before launching any worker.
      const job = await manager.startJob({ ...schedule.job, sessionId });
      state.lastJob = { sessionId, success: job.success, ...(job.reconnect ? { reconnect: true } : {}),
        ...(job.error ? { error: job.error } : {}), ...(job.nextAction && (job.reconnect || !job.success) ? { nextAction: job.nextAction } : {}) };
      // When a scheduler wakes late, launch once and advance to the next future slot.
      const next = interval ? Math.floor((Date.now() - origin) / interval) + 1 : state.index + 1;
      state.index = Math.max(state.index + 1, next);
      save();
    }
    state.state = cancelled() ? 'cancelled' : 'finished';
    state.nextAt = null;
    save();
  } catch (error) {
    state.state = 'failed';
    state.error = error.message;
    save();
    throw error;
  } finally {
    // The claim remains on disk after an abrupt termination for inspection.
    unlinkSync(claim);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === entry) {
  const dir = resolve(process.argv[2]);
  const cwd = dirname(dirname(dirname(dir)));
  // Older installs dispatched the worker without an attempt argument.
  runSchedule(dir, new JobManager({ cwd }), Number(process.argv[3] ?? 0)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
