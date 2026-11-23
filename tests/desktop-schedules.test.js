import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSchedule, submitSchedule } from '../herdr/mods/council/schedule-launch.js';
import { desktopSchedules } from '../herdr/mods/council/runtime/schedule-record.mjs';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';

const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));
const bridge = fileURLToPath(new URL('../herdr/mods/council/runtime/council.mjs', import.meta.url));
const firstRun = '2090-02-05T09:00:00+01:00';
const baseTask = { task: '--inspect the parser', timeout: '120', permission: 'read', agent: 'junie' };
const basics = { id: 'daily', firstRun, repeating: true, interval: '60', runs: '2', task: baseTask };
const noLookup = () => null;
const prepare = draft => prepareSchedule(draft, timing => desktopRequest(process.cwd(), 'schedule-timing', timing));

function environment(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'council-desktop-schedule-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stub = join(root, 'transport.mjs');
  const log = join(root, 'starts.jsonl');
  writeFileSync(stub, `import child from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    child.spawnSync = (bin,args) => {
      if (bin !== 'hc') throw Error('Unexpected child process');
      if (args[0] === 'run') appendFileSync(process.env.SCHEDULE_TEST_LOG, JSON.stringify(args)+'\\n');
      if (args[0] === 'run' && process.env.SCHEDULE_TEST_FAILURE) return { status: 1, stdout: '', stderr: 'Scheduler launch refused' };
      if (args[0] === 'get') return { status: 0, stdout: process.env.SCHEDULE_TEST_WORKER || '{}', stderr: '' };
      return { status: 0, stdout: '{"address":"t901"}', stderr: '' };
    };
    syncBuiltinESMExports();`);
  function run(cwd, args, env) {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, ...args], {
      cwd, encoding: 'utf8', timeout: 10000, env: { ...process.env, SCHEDULE_TEST_LOG: log, HC_TERMINAL_ID: '', ...env }
    });
    return { code: child.status, stdout: child.stdout, stderr: child.stderr };
  }
  return { root, log, dispatch: (cwd, args, env = {}) => run(cwd, [cli, ...args], env),
    request(action, data, zone) {
      const result = run(root, [bridge, 'desktop', action, JSON.stringify(data)], { TZ: zone });
      if (result.code !== 0) throw Error(result.stderr);
      return JSON.parse(result.stdout);
    } };
}

test('Desktop creates and reconnects each scheduled workflow through the CLI with one scheduler per definition', async t => {
  const { root, log, dispatch } = environment(t);
  const agents = ['claude', 'codex', 'junie'];
  const modes = ['delegate', 'council', 'review', 'debate', 'parallel', 'pipeline'];
  const missingAck = () => { throw Error('Lost acknowledgement'); };
  for (const mode of modes) {
    const template = { ...basics, id: mode, task: { ...baseTask, mode, agents, context: 'Scope', criteria: 'Explain',
      subtasks: ['one', 'two', 'three'], stages: agents.map((agent, index) => ({ agent, role: 'author', name: 'Stage ' + index })) } };
    const target = await prepare(template);
    const read = id => desktopSchedules(root, id, noLookup);
    await submitSchedule('create', target, args => {
      const result = dispatch(root, args);
      assert.equal(result.code, 0, result.stderr);
      return missingAck();
    }, read);
    // Explicit same-ID retries and dormant connection failures can both inspect the same saved request.
    await submitSchedule('create', target, args => dispatch(root, args), read);
    await submitSchedule('create', target, missingAck, read);
    for (const changes of [{ interval: '120' }, { firstRun: '2091-02-05T09:00:00Z' },
      { runs: '' }, { task: { ...template.task, permission: 'write' } }]) {
      await assert.rejects(submitSchedule('create', await prepare({ ...template, ...changes }), missingAck, read), /Lost acknowledgement/);
    }
    if (mode === 'parallel') await assert.rejects(submitSchedule('create', await prepare({ ...template,
      task: { ...template.task, subtasks: ['one', 'two', 'changed'] } }), missingAck, read), /Lost acknowledgement/);
    assert.equal(read(mode).schedule.at, '2090-02-05T08:00:00.000Z');
  }
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, modes.length);
});

test('a saved definition or replacement attempt alone cannot acknowledge a scheduler dispatch', async t => {
  const { root, dispatch } = environment(t);
  const read = id => desktopSchedules(root, id, noLookup);
  const lost = () => { throw Error('Lost acknowledgement'); };
  for (const action of ['create', 'resume']) {
    const id = 'failed-' + action;
    let target = await prepare({ ...basics, id });
    const env = { SCHEDULE_TEST_FAILURE: '1' };
    if (action === 'resume') {
      await submitSchedule('create', target, args => dispatch(root, args), read);
      target = read(id).schedule;
      env.SCHEDULE_TEST_WORKER = JSON.stringify({ address: target.workerAddress, state: 'finished',
        labels: { 'council.schedule': target.jobPrefix + '-' + target.attempt } });
    }
    await assert.rejects(submitSchedule(action, target, args => dispatch(root, args, env), read), /Scheduler launch refused/);
    const attempt = action === 'create' ? 1 : 2;
    assert.equal(read(id).schedule.attempt, attempt);
    assert.equal(read(id).schedule.state, 'dispatch_uncertain');
    await assert.rejects(submitSchedule(action, target, lost, read), /Scheduler launch refused/);
    const receipt = join(root, '.agent_workspace', '.schedules', id, 'attempt-' + attempt, 'dispatch.json');
    rmSync(receipt);
    assert.equal(read(id).schedule.state, 'dispatch_uncertain');
    await assert.rejects(submitSchedule(action, target, lost, read), /Lost acknowledgement/);
    writeFileSync(receipt, JSON.stringify({ workerAddress: 't902' }));
    await submitSchedule(action, target, lost, read);
    if (action === 'resume') {
      const newer = join(root, '.agent_workspace', '.schedules', id, 'attempt-3');
      mkdirSync(newer);
      writeFileSync(join(newer, 'dispatch.json'), JSON.stringify({ workerAddress: 't903' }));
      await assert.rejects(submitSchedule(action, target, lost, read), /Lost acknowledgement/);
    }
    // An explicit failure remains visible even if a concurrent client has confirmed a worker.
    const rejected = () => ({ code: 1, stdout: JSON.stringify({ success: false, id, error: 'Concurrent rejection' }) });
    await assert.rejects(submitSchedule(action, target, rejected, read), /Concurrent rejection/);
  }
});

test('schedule lists preserve project origin, skip worker probes and link only saved occurrence jobs', async t => {
  const { root, dispatch } = environment(t);
  const alias = join(root, 'alias-a');
  for (const project of ['a', 'b']) {
    const cwd = join(root, project);
    mkdirSync(cwd);
    const target = await prepare(basics);
    await submitSchedule('create', target, args => dispatch(cwd, args), id => desktopSchedules(cwd, id, noLookup));
    if (project === 'a') {
      symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await submitSchedule('create', target, args => dispatch(alias, args), id => desktopSchedules(alias, id, noLookup));
    }
    let lookedUp = false;
    assert.equal(desktopSchedules(cwd, null, () => { lookedUp = true; }).schedules[0].project, cwd);
    assert.equal(lookedUp, false);
  }
  const list = desktopRequest(root, 'schedules', { projects: [alias], spaceFolders: [root] });
  assert.deepEqual(list.schedules.map(item => item.project).sort(), ['a', 'b'].map(project => join(root, project)));
  const cwd = join(root, 'a');
  const read = id => desktopSchedules(cwd, id, noLookup);
  const { jobPrefix, attempt } = read('daily').schedule;
  const workspace = join(cwd, '.agent_workspace');
  for (const slot of [1, 3, 15]) {
    const dir = join(workspace, jobPrefix + '-' + slot);
    mkdirSync(dir);
    if (slot !== 3) writeFileSync(join(dir, 'job.json'), '{}');
  }
  assert.deepEqual(read('daily').schedule.occurrences.map(run => run.slot), [15, 1]);
  assert.equal(read('daily').schedule.workerObservation.state, 'unknown');
  await assert.rejects(submitSchedule('resume', { id: 'daily', attempt }, () => { throw Error('Interrupted'); }, read), /Interrupted/);
  await submitSchedule('cancel', { id: 'daily' }, args => {
    dispatch(cwd, args);
    throw Error('Interrupted');
  }, read);
  assert.equal(read('daily').schedule.state, 'cancelled');
  assert.equal(desktopSchedules(join(root, 'b'), 'daily', noLookup).schedule.state, 'scheduled');
  assert.throws(() => read('../b'));
});

test('one-time and indefinite schedule inputs carry explicit timing and reject invalid cadence', async () => {
  const before = Date.now();
  const once = await prepare({ ...basics, repeating: false, firstRun: '' });
  assert.ok(Date.parse(once.at) >= before && Date.parse(once.at) <= Date.now());
  assert.deepEqual(await prepare({ ...basics, repeating: false, firstRun: once.at }), once);
  assert.equal(once.count, 1);
  assert.equal(once.args.includes('--every'), false);
  const indefinite = await prepare({ ...basics, runs: '' });
  assert.equal(indefinite.args.includes('--count'), false);
  for (const invalid of [{ firstRun: '12/02/91' }, { firstRun: '2027-02-29 10:00' }, { firstRun: '2028-02-31T10:00:00+01:00' },
    { interval: '0' }, { interval: '1e308' }, { runs: '1.8' }, { runs: String(Number.MAX_SAFE_INTEGER) }]) {
    await assert.rejects(prepare({ ...basics, ...invalid }));
  }
  assert.equal((await prepare({ ...basics, firstRun: '2028-02-29T00:30:00+02:00' })).at, '2028-02-28T22:30:00.000Z');
});

test('invalid calendar slots never reserve the CLI schedule ID and local daylight-saving gaps are rejected', t => {
  const { root, dispatch } = environment(t);
  const create = at => dispatch(root, ['schedule', 'create', '--id', 'calendar', '--at', at, '--task', 'Check calendar']);
  assert.notEqual(create('2090-02-31T09:00:00Z').code, 0);
  assert.equal(create('2090-02-28').code, 0);
  const module = new URL('../herdr/mods/council/runtime/schedule-time.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { parseScheduleTime } from ${JSON.stringify(module)};
     console.log(JSON.stringify([parseScheduleTime('2026-03-29 02:30'), new Date(parseScheduleTime('2026-03-29 03:30')).toISOString()]));`],
  { encoding: 'utf8', env: { ...process.env, TZ: 'Europe/Rome' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [null, '2026-03-29T01:30:00.000Z']);
});

test('Desktop resolves and displays the first and next slot in the project machine’s time zone', async t => {
  const { root, request, dispatch } = environment(t);
  const prepareOn = (firstRun, zone) => prepareSchedule({ ...basics, firstRun }, timing => request('schedule-timing', timing, zone));
  const rome = 'Europe/Rome';
  const summer = await prepareOn('2027-07-01 09:00', rome);
  assert.equal(summer.at, '2027-07-01T07:00:00.000Z');
  assert.equal((await prepareOn('2027-01-01 09:00', rome)).at, '2027-01-01T08:00:00.000Z');
  assert.equal((await prepareOn('2027-07-01 09:00', 'America/New_York')).at, '2027-07-01T13:00:00.000Z');
  assert.equal((await prepareOn('2027-07-01T09:00:00-04:00', rome)).at, '2027-07-01T13:00:00.000Z');
  await assert.rejects(prepareOn('2027-03-28 02:30', rome), /existing date and time/);
  assert.equal(dispatch(root, summer.args).code, 0);
  for (const zone of [rome, 'America/New_York']) {
    const label = new Date(summer.at).toLocaleString(undefined, { timeZone: zone, timeZoneName: 'shortOffset' });
    const [summary] = request('schedules', {}, zone).schedules;
    assert.equal(summary.nextAtLocal, label);
    const detail = request('schedules', { id: summer.id }, zone).schedule;
    assert.equal(detail.atLocal, label);
    assert.equal(detail.nextAtLocal, label);
  }
});
