import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { HerdrClient } from '../lib/herdr.js';
import { JobManager } from '../lib/jobs.js';
import { JobWorker } from '../lib/job-worker.js';
import { callTeamMember } from '../lib/team.js';

async function inProject(run) {
  const project = mkdtempSync(join(tmpdir(), 'council-team-'));
  try { await run(project, new TeamStore(project)); }
  finally { rmSync(project, { recursive: true, force: true }); }
}

const lead = { id: 'lead', agent: 'codex', role: 'Lead', model: 'model-local', permission: 'write' };
const reviewer = { id: 'qa', agent: 'claude', role: 'QA reviewer', reportsTo: 'lead' };
const turnDone = address => ({ success: true, ended: true, terminal: address, reason: 'status', status: 'done', turn: 2 });
const identity = { pid: 100, createdMs: 321 };

test('Team uses project roles with optional hierarchy and rejects unknown or circular managers', async () => inProject(async (project, team) => {
  assert.equal(team.list().members.length, 0);
  team.set(lead);
  const roster = desktopRequest(project, 'team-set', reviewer);
  assert.deepEqual(roster.members.map(({ id, reportsTo, state }) => [id, reportsTo, state]), [
    ['lead', '', 'off'], ['qa', 'lead', 'off']
  ]);
  assert.throws(() => team.set({ ...lead, reportsTo: 'qa' }), /acyclic/);
  assert.throws(() => team.set({ ...reviewer, reportsTo: 'missing' }), /Unknown member/);
  assert.throws(() => team.set({ ...reviewer, model: '--help' }), /model ID/);
  assert.deepEqual(team.list(), roster);
}));

test('Team hands off to a peer, confirms shutdown after saving output, and restores archived context on a new call', async () => inProject(async (project, team) => {
  team.set(lead);
  team.set(reviewer);
  const dispatched = [];
  const client = { terminalId: null, get: () => ({ details: { pid: 100, created_ms: 321 } }) };
  const manager = new JobManager({ cwd: project, herdr: client,
    workerLauncher(job) { dispatched.push(job); return { success: true }; } });
  const first = { member: 'lead', task: 'Plan the rollout', sessionId: 'lead-one' };
  await callTeamMember(manager, first);
  team.set({ ...lead, agent: 'claude', role: 'Coordinator', model: '' });
  const reconnected = await callTeamMember(manager, first);
  assert.equal(reconnected.reconnect, true);
  assert.equal(dispatched.length, 1);
  assert.equal(reconnected.participant.team.role, 'Lead');

  const leadWorker = new JobWorker({ sessionDir: dispatched[0].sessionDir, herdr: {
    launchAgent(args) {
      assert.equal(args.model, 'model-local');
      assert.match(args.context(), /Direct reports: qa/);
      return { success: true, address: 't1', identity, baselineTurn: 1 };
    },
    wait: () => turnDone('t1'),
    captureTurn(address, turn) {
      assert.equal(address, 't1');
      assert.equal(turn, 2);
      return { success: true, content: 'QA called in qa-one. Follow up after testing.' };
    },
    stopCompletedTeamTurn(address, options) {
      assert.equal(address, 't1');
      assert.equal(options.turn, 2);
      assert.deepEqual(options.identity, identity);
      const job = manager.readJobRecord('lead-one').job;
      assert.equal(job.participant.power, 'stopping');
      assert.match(readFileSync(job.result.artifactPath, 'utf8'), /qa-one/);
      return { success: true };
    }
  }, hooks: { async beforeWait() {
    client.terminalId = 't1';
    const call = await callTeamMember(manager, { member: 'qa', task: 'Test the rollout', sessionId: 'qa-one' });
    assert.match(call.handoff, /end this turn/);
    assert.equal(manager.readJobRecord('qa-one').job.teamSource, 'lead-one');
    await assert.rejects(callTeamMember(manager, { ...first, sessionId: 'lead-duplicate' }), /cannot call its own/);
    client.terminalId = null;
  } } });
  assert.equal((await leadWorker.execute()).success, true);
  assert.equal((await manager.getResult('lead-one')).participant.power, 'off');
  assert.equal(team.list().members[0].state, 'off');
  assert.equal(dispatched.length, 2, 'powering off creates no automatic follow-up');

  await callTeamMember(manager, { ...first, task: 'Handle the QA findings', sessionId: 'lead-two' });
  assert.equal(dispatched[0].job.participant.name, dispatched[2].job.participant.name);
  let launches = 0;
  const nextWorker = new JobWorker({ sessionDir: dispatched[2].sessionDir, herdr: {
    launchAgent(args) {
      if (++launches === 1) return { success: false, errorKind: 'name_taken' };
      assert.match(args.context(), /Your previous turn: lead-one/);
      assert.match(args.context(), /serving as Coordinator/);
      return { success: true, address: 't2', identity: { pid: 101, createdMs: 322 }, baselineTurn: 1 };
    },
    wait: () => ({ ...turnDone('t2'), success: false, isBlocked: true, status: 'blocked', reason: 'blocked' }),
    stopCompletedTeamTurn() { assert.fail('blocked work must be preserved'); }
  } });
  assert.equal((await nextWorker.execute()).success, false);
  assert.equal(launches, 2);
  assert.equal(team.list().members[0].state, 'attention');
}));

test('Team requires the same process and a confirmed exit before cleaning up a terminal', () => {
  const herdr = new HerdrClient();
  const args = { name: 'team-name', turn: 2, identity };
  const details = { address: 't1', name: args.name, created_ms: 321, pid: 100,
    turn: 2, state: 'live', status: { state: 'done' } };
  let stopped = { ...details, state: 'finished', finished_ms: 987 };
  const commands = [];
  herdr.get = () => ({ details });
  herdr.exec = input => {
    commands.push(input);
    return { success: true, stdout: JSON.stringify(stopped) };
  };
  assert.equal(herdr.stopCompletedTeamTurn('t1', { ...args, turn: 1 }).success, false);
  details.records = { reviewer: { state: 'working' } };
  assert.equal(herdr.stopCompletedTeamTurn('t1', args).success, false);
  assert.deepEqual(commands, []);
  delete details.records;
  stopped = details;
  assert.equal(herdr.stopCompletedTeamTurn('t1', args).success, false);
  assert.deepEqual(commands, [['kill', '--json', 't1']]);
  stopped = { ...details, state: 'finished', finished_ms: 987 };
  assert.equal(herdr.stopCompletedTeamTurn('t1', args).success, true);
  assert.deepEqual(commands.slice(1), [['kill', '--json', 't1'], ['rm', 't1']]);
});
