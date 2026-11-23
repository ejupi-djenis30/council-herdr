import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopId, executeEngine, focusedProject, hostId, invitationWorkerArgs, participantTerminal, peerEngine } from '../herdr/mods/council/machine-engine.js';

test('a focused terminal and participant stay on the originating machine and process', () => {
  const space = { id: 'east/sp1', machine: 'east' };
  const focus = { space: space.id, terminal: 'east/t7', cwd: '/work' };
  assert.equal(focusedProject(focus, space), '/work');
  for (const unexpected of ['west/t7', 't7', 'east/west/t7']) {
    assert.equal(focusedProject({ ...focus, terminal: unexpected }, space), null);
  }
  assert.equal(focusedProject({ ...focus, terminal: 'west/t7', space: 'sp1' }, { id: 'sp1', machine: null }), null);
  assert.equal(hostId(desktopId('sp1', 'east'), 'east'), 'sp1');
  const job = { ownership: 'borrowed', address: 't7', participantCreatedMs: 20, participantPid: 301 };
  const participant = { address: 'east/t7', created_ms: 20, pid: 301, reported: true, state: 'live' };
  assert.equal(participantTerminal(job, 'east', [participant]), participant);
  for (const change of [{ address: 'west/t7' }, { pid: 302 }, { created_ms: 21 }, { state: 'exited' }]) {
    assert.equal(participantTerminal(job, 'east', [{ ...participant, ...change }]), null);
  }
  assert.equal(participantTerminal({ ...job, team: { power: 'off' } }, 'east', [participant]), null);
});

test('Desktop resolves a peer installation and dispatches reads, writes and invitation workers on that peer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'council-peer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'app home');
  const project = join(root, 'space project');
  mkdirSync(project);
  const installer = fileURLToPath(new URL('../herdr/install.js', import.meta.url));
  const installed = spawnSync(process.execPath, [installer, '--app-home', app], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const commands = [];
  const execute = async (command, args, options) => {
    assert.equal(options.on, 'east');
    commands.push(command);
    if (command === 'node') throw new Error('Executable unavailable on PATH');
    const result = spawnSync(command, args, {
      cwd: options.cwd || root, timeout: options.timeout, encoding: 'utf8', env: { ...process.env, HERDR_APP_HOME: app }
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const engine = await peerEngine('east', execute, (path, options) => {
    assert.equal(path, '.config/herdr-app/mods/council/config.json');
    assert.equal(options.on, 'east');
    return JSON.stringify({ node: process.execPath });
  });
  const dispatch = async (script, args) => {
    const output = await executeEngine(execute, engine, script, args, project, 10000);
    assert.equal(output.code, 0, output.stderr);
    return JSON.parse(output.stdout);
  };
  const started = await dispatch('cli', ['debate', 'create', '--question', 'Should we ship?']);
  const { debate } = await dispatch('entry', ['desktop', 'debates', JSON.stringify({ id: started.sessionId })]);
  assert.equal(debate.task, 'Should we ship?');
  assert.deepEqual(commands, ['node', process.execPath, process.execPath, process.execPath]);
  const worker = invitationWorkerArgs(engine, 'test-worker', project, started.sessionId);
  assert.deepEqual(worker.slice(0, 3), ['run', '--on', 'east']);
  assert.deepEqual(worker.slice(-7), ['--cwd', project, '--', engine.node, engine.entry, 'invite', started.sessionId]);
});

test('an offline peer reports a setup error without falling back to a local process', async () => {
  const targets = [];
  await assert.rejects(peerEngine('east', async (_command, _args, options) => {
    targets.push(options.on);
    throw new Error('Peer is offline');
  }), /east.*Peer is offline/);
  assert.deepEqual(targets, ['east']);
});
