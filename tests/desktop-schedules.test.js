import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSchedule, submitSchedule } from '../herdr/mods/council/schedule-launch.js';
import { desktopSchedules } from '../herdr/mods/council/runtime/schedule-record.mjs';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';

const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));
const firstRun = '2090-02-05T09:00:00+01:00';
const baseTask = { task: '--inspect the parser', timeout: '120', permission: 'read', agent: 'junie' };
const basics = { id: 'daily', firstRun, repeating: true, interval: '60', runs: '2', task: baseTask };
const noLookup = () => null;

function environment(t) {
  const root = mkdtempSync(join(tmpdir(), 'council-desktop-schedule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stub = join(root, 'transport.mjs');
  const log = join(root, 'starts.jsonl');
  writeFileSync(stub, `import child from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    child.spawnSync = (bin,args) => {
      if (bin !== 'hc') throw Error('Unexpected child process');
      if (args[0] === 'run') appendFileSync(process.env.SCHEDULE_TEST_LOG, JSON.stringify(args)+'\\n');
      return { status: 0, stdout: '{"address":"t901"}', stderr: '' };
    };
    syncBuiltinESMExports();`);
  return { root, log, dispatch(cwd, args) {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, cli, ...args], {
      cwd, encoding: 'utf8', timeout: 10000, env: { ...process.env, SCHEDULE_TEST_LOG: log, HC_TERMINAL_ID: '' }
    });
    return { code: child.status, stdout: child.stdout, stderr: child.stderr };
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
    const target = prepareSchedule(template);
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
      await assert.rejects(submitSchedule('create', prepareSchedule({ ...template, ...changes }), missingAck, read), /Lost acknowledgement/);
    }
    if (mode === 'parallel') await assert.rejects(submitSchedule('create', prepareSchedule({ ...template,
      task: { ...template.task, subtasks: ['one', 'two', 'changed'] } }), missingAck, read), /Lost acknowledgement/);
    assert.equal(read(mode).schedule.at, '2090-02-05T08:00:00.000Z');
  }
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, modes.length);
});

test('schedule lists preserve project origin, skip worker probes and link only saved occurrence jobs', async t => {
  const { root, dispatch } = environment(t);
  for (const project of ['a', 'b']) {
    const cwd = join(root, project);
    mkdirSync(cwd);
    const target = prepareSchedule(basics);
    await submitSchedule('create', target, args => dispatch(cwd, args), id => desktopSchedules(cwd, id, noLookup));
    let lookedUp = false;
    assert.equal(desktopSchedules(cwd, null, () => { lookedUp = true; }).schedules[0].project, cwd);
    assert.equal(lookedUp, false);
  }
  const list = desktopRequest(root, 'schedules', { projects: [], spaceFolders: [root] });
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

test('one-time and indefinite schedule inputs carry explicit timing and reject invalid cadence', () => {
  const now = '2085-01-01T00:00:00.000Z';
  const once = prepareSchedule({ ...basics, repeating: false, firstRun: '' }, now);
  assert.equal(once.at, now);
  assert.equal(once.count, 1);
  assert.equal(once.args.includes('--every'), false);
  const indefinite = prepareSchedule({ ...basics, runs: '' });
  assert.equal(indefinite.args.includes('--count'), false);
  for (const invalid of [{ firstRun: '12/02/91' }, { firstRun: '2027-02-29 10:00' }, { firstRun: '2028-02-31T10:00:00+01:00' },
    { interval: '0' }, { interval: '1e308' }, { runs: '1.8' }, { runs: String(Number.MAX_SAFE_INTEGER) }]) {
    assert.throws(() => prepareSchedule({ ...basics, ...invalid }));
  }
  assert.equal(prepareSchedule({ ...basics, firstRun: '2028-02-29T00:30:00+02:00' }).at, '2028-02-28T22:30:00.000Z');
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
