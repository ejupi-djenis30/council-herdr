import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptDirectory, latestAttempt, readScheduleStatus, scheduleId, workerName } from '../herdr/mods/council/runtime/schedule-record.mjs';
import { fitsScheduleDates, parseScheduleTime } from '../herdr/mods/council/runtime/schedule-time.mjs';
import { HerdrClient } from './herdr.js';
import { JobManager } from './jobs.js';
import { atomicWrite } from './workspace.js';
import { workflowInputs } from './workflow-job.js';

const entry = fileURLToPath(import.meta.url);
const scheduleLabel = 'council.schedule';

export class ScheduleManager {
  constructor({ cwd = process.cwd(), herdr = new HerdrClient({ cwd }) } = {}) {
    this.cwd = resolve(cwd);
    this.herdr = herdr;
    this.base = join(this.cwd, '.agent_workspace', '.schedules');
  }

  path(id) { return join(this.base, scheduleId(id)); }

  status(id) {
    return readScheduleStatus(this.path(id), id, (target, timeout) => {
      const probe = this.herdr.get?.(target, { timeout });
      return probe?.success ? probe.details : null;
    });
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
    const first = at === undefined ? Date.now() : parseScheduleTime(at);
    const interval = everySec === undefined ? null : Number(everySec);
    const total = count === undefined ? (interval === null ? 1 : null) : Number(count);
    if (!Number.isFinite(first) || (interval !== null && (!Number.isFinite(interval) || interval < 1)) ||
        (total !== null && (!Number.isSafeInteger(total) || total < 1)) || (interval === null && total !== 1) ||
        !fitsScheduleDates(first, interval, total)) {
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
