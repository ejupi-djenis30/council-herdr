import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleManager, runSchedule } from '../lib/schedules.js';
import { JobManager } from '../lib/jobs.js';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'council-schedule-recovery-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const workers = [];
  const herdr = {
    parseJson: JSON.parse,
    exec(args) {
      const name = args[args.indexOf('--name') + 1];
      const [key, value] = args[args.indexOf('--label') + 1].split('=');
      const address = `t${20 + workers.length}`;
      workers.push({ name, address, labels: { [key]: value }, state: 'live' });
      return { success: true, stdout: JSON.stringify({ address }) };
    },
    get(target) {
      const details = workers.find(worker => [worker.address, worker.name].includes(target));
      return { success: Boolean(details), details };
    }
  };
  return { cwd, workers, herdr, schedules: new ScheduleManager({ cwd, herdr }) };
}

test('schedule resume requires the matching stopped worker and claims a replacement once', t => {
  const { schedules, workers, herdr, cwd } = fixture(t);
  schedules.create({ id: 'audit', job: { task: 'Audit the release' } });
  const [first] = workers;
  assert.equal(schedules.status('audit').workerAddress, first.address);
  assert.equal(schedules.list()[0].workerObservation.state, 'live');
  assert.equal(schedules.resume('audit').success, false);

  first.state = 'finished';
  const label = first.labels['council.schedule'];
  first.labels['council.schedule'] = 'another-schedule';
  assert.equal(schedules.status('audit').outcome, 'worker_unknown');
  assert.equal(schedules.resume('audit').success, false);
  first.labels['council.schedule'] = label;
  const stopped = schedules.status('audit');
  assert.equal(stopped.state, 'worker_stopped');
  assert.match(stopped.nextAction, /schedule resume audit/);
  assert.equal(schedules.resume('audit').success, true);
  // Model a second CLI client that already observed the previous attempt stop.
  const concurrent = new ScheduleManager({ cwd, herdr });
  concurrent.status = () => stopped;
  assert.equal(concurrent.resume('audit').success, false);
  assert.equal(workers.length, 2);
  assert.equal(schedules.status('audit').workerAddress, workers[1].address);
  schedules.cancel('audit');
  workers[1].state = 'finished';
  assert.equal(schedules.status('audit').state, 'cancelled');
  assert.equal(schedules.resume('audit').success, false);
});

test('resume reconnects to the same job after a crash between slot dispatch and checkpoint', async t => {
  const { schedules, workers, cwd } = fixture(t);
  const job = { task: 'Draft the release' };
  schedules.create({ id: 'draft', job });
  const dir = schedules.path('draft');
  const slot = `${schedules.status('draft').jobPrefix}-1`;
  let launches = 0;
  const jobs = new JobManager({ cwd, workerLauncher() { launches++; return { success: true, address: 't90' }; } });
  assert.equal((await jobs.startJob({ ...job, sessionId: slot })).success, true);
  const before = jobs.readJobRecord(slot).job;
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ index: 0, state: 'dispatching', attempt: 1, workerAddress: 't20', lastJob: { sessionId: slot } }));
  const claim = join(dir, 'attempt-1', 'worker.lock');
  writeFileSync(claim, '811');
  workers[0].state = 'finished';
  const resume = schedules.resume('draft');
  assert.equal(resume.success, true);
  assert.equal(readFileSync(claim, 'utf8'), '811');
  await assert.rejects(runSchedule(dir, jobs, 1), /superseded/);
  jobs.herdr.terminalId = resume.workerAddress;
  await runSchedule(dir, jobs, resume.attempt);
  const status = schedules.status('draft');
  assert.equal(status.state, 'finished');
  assert.equal(status.lastJob.sessionId, slot);
  assert.equal(status.lastJob.success, true);
  assert.equal(status.lastJob.reconnect, true);
  assert.ok(status.lastJob.nextAction.includes(slot));
  assert.deepEqual(jobs.readJobRecord(slot).job, before);
  assert.equal(launches, 1);
  assert.equal(schedules.resume('draft').success, false);
});

test('a pre-label worker with a retained matching PID can resume at its original saved slot', async t => {
  const { schedules, workers } = fixture(t);
  const dir = schedules.path('legacy');
  mkdirSync(dir, { recursive: true });
  const schedule = { $schema: 'council.schedule/v1', id: 'legacy', at: new Date(Date.now() - 1500).toISOString(),
    everySec: 1, count: 2, jobPrefix: 'scheduled-123456789abc', job: { task: 'Legacy review' } };
  writeFileSync(join(dir, 'schedule.json'), JSON.stringify(schedule));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ state: 'scheduled', workerAddress: 't100', index: 1 }));
  writeFileSync(join(dir, 'worker.lock'), '52');
  const legacy = { address: 't100', name: 'schedule-123456789abc', state: 'finished', pid: 53 };
  workers.push(legacy);
  assert.equal(schedules.resume('legacy').success, false);
  legacy.pid = 52;
  const resume = schedules.resume('legacy');
  assert.equal(resume.success, true);
  const slots = [];
  await runSchedule(dir, { startJob(job) { slots.push(job.sessionId); return { success: true }; } }, resume.attempt);
  assert.deepEqual(slots, ['scheduled-123456789abc-2']);
  assert.equal(schedules.status('legacy').state, 'finished');
});

test('an unconfirmed scheduler launch cannot trigger another dispatch on an inconclusive lookup', t => {
  const { schedules, herdr, workers } = fixture(t);
  const launch = herdr.exec;
  herdr.exec = args => {
    launch(args);
    return { success: false, stderr: 'Lost acknowledgement' };
  };
  assert.equal(schedules.create({ id: 'uncertain', job: { task: 'Review change' } }).success, false);
  const lookup = herdr.get;
  herdr.get = () => ({ success: false });
  assert.equal(schedules.status('uncertain').state, 'dispatch_uncertain');
  assert.equal(schedules.resume('uncertain').success, false);
  herdr.get = lookup;
  assert.equal(schedules.status('uncertain').workerObservation.state, 'live');
  assert.equal(schedules.resume('uncertain').success, false);
  assert.equal(workers.length, 1);
});
