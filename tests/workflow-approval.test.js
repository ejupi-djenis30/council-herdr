import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CouncilOrchestrator } from '../lib/modes.js';
import { HerdrClient } from '../lib/herdr.js';
import { JobManager } from '../lib/jobs.js';
import { JobWorker } from '../lib/job-worker.js';
import { readDelegation } from '../herdr/mods/council/runtime/delegations.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'council-approval-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const launches = [];
  const captures = [];
  const dismissed = [];
  const herdr = {
    launchAgent() {
      const address = `t${launches.length + 1}`;
      launches.push(address);
      return { success: true, address, terminalIdentity: address + ':junie', baselineTurn: 4, details: { first_message: { sent: true } } };
    },
    wait(terminal) {
      return { success: false, ended: true, isBlocked: true, terminal, status: 'blocked', reason: 'status', turn: 5 };
    },
    waitForApproval(target, turn, { identity, onProgress }) {
      assert.equal(identity, target + ':junie');
      assert.equal(turn, 5);
      onProgress({ status: 'blocked', turn });
      onProgress({ status: 'working', turn });
      return { success: true, status: 'done', turn: 6 };
    },
    captureTurn(target, turn, { identity }) {
      assert.equal(identity, target + ':junie');
      assert.equal(turn, 6);
      captures.push(target);
      return { success: true, content: 'Evidence from ' + target };
    },
    dismiss(target, options) {
      assert.deepEqual(options, { identity: target + ':junie', turn: 6 });
      dismissed.push(target);
    }
  };
  return { cwd, herdr, launches, captures, dismissed };
}

for (const [mode, participants] of [['delegate', 1], ['review', 3], ['council', 3], ['parallel', 2], ['debate', 3], ['pipeline', 2]]) {
  test(`${mode} captures each proven approval continuation and preserves formal voting requirements`, async t => {
    const { cwd, herdr, launches, captures, dismissed } = fixture(t);
    const progress = [];
    const result = await new CouncilOrchestrator({ cwd, herdr }).runMode({ mode,
      task: 'Examine the parser', stages: [{ name: 'Research' }, { name: 'Conclude' }], subtasks: ['Inspect', 'Compare'],
      onProgress: event => { if (event.stage === 'approval_progress') progress.push(event); }
    });
    if (['council', 'review'].includes(mode)) {
      assert.equal(result.status, 'failed_quorum');
      assert.equal(result.authorized, false);
    } else assert.equal(result.success, true);
    assert.equal(launches.length, participants);
    assert.deepEqual(captures, launches);
    assert.deepEqual(dismissed, launches);
    for (const address of launches) {
      assert.deepEqual(progress.filter(event => event.terminal === address).map(({ status }) => status), ['blocked', 'working', 'done']);
    }
  });
}

test('a wrong blocked turn, address, or missing identity cannot enter approval recovery', async t => {
  const { cwd, herdr } = fixture(t);
  const orchestrator = new CouncilOrchestrator({ cwd, herdr });
  const blocked = herdr.wait('t1');
  herdr.waitForApproval = () => assert.fail('unrelated assignment');
  for (const [event, identity] of [[{ ...blocked, turn: 7 }, 'id'], [{ ...blocked, terminal: 't2' }, 'id'], [blocked, null]]) {
    herdr.wait = () => event;
    assert.equal((await orchestrator.waitForParticipant('t1', { afterTurn: 4, identity })).success, false);
  }
});

test('failed approval continuity prevents capture, dismissal and downstream handoff', async t => {
  const { cwd, herdr, launches, captures, dismissed } = fixture(t);
  herdr.waitForApproval = () => ({ success: false, error: 'The terminal restarted' });
  const result = await new CouncilOrchestrator({ cwd, herdr }).runMode({
    mode: 'pipeline', task: 'Inspect and summarize', stages: [{ name: 'Inspect' }, { name: 'Summarize' }]
  });
  assert.equal(result.success, false);
  assert.match(result.report, /terminal restarted/);
  assert.deepEqual(launches, ['t1']);
  assert.deepEqual(captures, []);
  assert.deepEqual(dismissed, []);
});

test('a background approval exposes the actual participant in Desktop, status and result until the original deadline', async t => {
  const { cwd, herdr, captures } = fixture(t);
  const manager = new JobManager({ cwd, herdr, workerLauncher: () => ({ success: true, address: 't72' }) });
  const started = await manager.startJob({ mode: 'pipeline', sessionId: 'approval', task: 'Inspect', stages: [{ name: 'Inspect' }] });
  assert.equal(started.success, true);
  const base = join(cwd, '.agent_workspace');
  const sessionDir = join(base, 'approval');
  const job = JSON.parse(readFileSync(join(sessionDir, 'job.json'), 'utf8'));
  let resume;
  const resumed = new Promise(resolve => { resume = resolve; });
  herdr.waitForApproval = async (_target, turn, { onProgress, deadlineMs }) => {
    assert.equal(deadlineMs, Date.parse(job.deadlineAt));
    onProgress({ status: 'blocked', turn });
    await resumed;
    onProgress({ status: 'working', turn });
    return { success: true, status: 'done', turn: 6 };
  };
  const execution = new JobWorker({ sessionDir, herdr }).execute();
  try {
    const status = await manager.getStatus('approval');
    const result = await manager.getResult('approval');
    const { detail } = readDelegation(base, 'approval', true);
    assert.equal(status.outcome, 'awaiting_input');
    assert.equal(status.waitDetails.terminal, 't1');
    assert.equal(result.ready, false);
    assert.equal(result.waitDetails.terminal, 't1');
    assert.equal(detail.status, 'awaiting_input');
    assert.equal(detail.address, 't1');
  } finally { resume(); }
  assert.equal((await execution).success, true);
  assert.deepEqual(captures, ['t1']);
  assert.equal((await manager.getResult('approval')).outcome, 'completed');
});

test('cleanup preserves a newly active turn or replacement process after collecting a participant', () => {
  const client = new HerdrClient();
  const expected = { address: 't12', state: 'live', pid: 42, created_ms: 9001, reported: true, status: { state: 'done', app: 'junie' }, turn: 6 };
  client.exec = () => assert.fail('a changed terminal must be preserved');
  for (const details of [{ ...expected, turn: 7 }, { ...expected, pid: 43 }, { ...expected, status: { state: 'working', app: 'junie' } },
    { ...expected, records: { child: { state: 'working' } } }]) {
    client.get = () => ({ success: true, details });
    assert.equal(client.dismiss('t12', { turn: 6, identity: '9001:42:junie' }).success, false);
  }
});
