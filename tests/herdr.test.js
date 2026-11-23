import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HerdrClient } from '../lib/herdr.js';
import { alignmentKey, alignmentLabel } from '../herdr/mods/council/runtime/alignment.mjs';

test('HerdrClient initializes with defaults', () => {
  const client = new HerdrClient();
  assert.equal(client.bin, 'hc');
  assert.ok(client.cwd);
});

test('HerdrClient parses JSON correctly', () => {
  const client = new HerdrClient();
  assert.equal(client.parseJson(''), null);
  assert.equal(client.parseJson('not json'), null);
  assert.deepEqual(client.parseJson('{"hello":"world"}'), { hello: 'world' });
});

test('HerdrClient sends only an alignment check before releasing a real brief', t => {
  const testCwd = mkdtempSync(join(tmpdir(), 'council-launch-'));
  t.after(() => rmSync(testCwd, { recursive: true, force: true }));
  const client = new HerdrClient({ cwd: testCwd });
  const launches = [];
  client.exec = args => {
    launches.push(args);
    return { success: true, stdout: JSON.stringify({ address: 't21' }) };
  };
  const sends = [];
  client.send = (...args) => {
    sends.push(args);
    return { success: true, output: JSON.stringify({ started: true, turn: 1 }) };
  };
  const longTask = 'Line 1: Build the feature\nLine 2: Ensure test coverage\nLine 3: Document it';
  const options = {
    name: 'test-agent',
    agent: 'claude',
    permission: 'read',
    cwd: testCwd,
    task: longTask
  };
  const briefPath = join(testCwd, '.agent_workspace', 'default', 'briefs', 'test-agent.md');
  client.waitForAlignment = () => ({ state: 'not_aligned' });
  const blocked = client.launchAgent(options);
  assert.equal(blocked.success, false);
  assert.equal(blocked.address, 't21');
  assert.equal(blocked.alignment, 'not_aligned');
  assert.equal(sends.length, 0);
  assert.equal(existsSync(briefPath), false);
  assert.match(launches[0].at(-1), /Council alignment check/);
  assert.doesNotMatch(launches[0].at(-1), /[\r\n]/);
  assert.doesNotMatch(launches[0].at(-1), /Build the feature/);
  client.waitForAlignment = () => ({ state: 'aligned', turn: 1 });
  const res = client.launchAgent(options);
  assert.equal(res.success, true);
  assert.equal(res.baselineTurn, 1);
  assert.equal(sends.length, 1);
  assert.equal(existsSync(briefPath), true, 'Brief file should be created');
  client.send = () => ({ success: false, attempted: false, alignment: 'needs_reload', error: 'Reload Council in t21.' });
  const stale = client.launchAgent(options);
  assert.equal(stale.success, false);
  assert.equal(stale.alignment, 'needs_reload');
});

test('a Windows batch launcher receives the complete initial notice through Herdr', {
  skip: process.platform !== 'win32' || !process.env.HC_TERMINAL_ID
}, t => {
  const cwd = mkdtempSync(join(tmpdir(), 'council batch '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'record.cjs'), "require('node:fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)))");
  const launcher = join(cwd, 'record.cmd');
  writeFileSync(launcher, '@echo off\r\n@node "%~dp0record.cjs" %*\r\n');
  const client = new HerdrClient({ cwd });
  client.waitForAlignment = address => {
    const wait = client.exec(['wait', '--json', address, '--timeout', '10']);
    const finished = client.parseJson(wait.stdout);
    assert.equal(finished?.exit_code, 0, wait.stderr || wait.stdout);
    client.exec(['rm', address]);
    return { state: 'unconfirmed' };
  };
  const result = client.launchAgent({ name: `batch-${process.pid}`, agent: launcher, task: 'Private assignment' });
  assert.ok(result.address, result.error);
  const received = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8'));
  assert.equal(received.length, 1);
  assert.match(received[0], /Council alignment check/);
  assert.match(received[0], /challenge: [a-f0-9]{32}/);
  assert.doesNotMatch(received[0], /Private assignment|[\r\n]/);
});

function terminal({ state = 'done', turn = 8 } = {}) {
  return { address: 't21', state: 'live', reported: true, turn, pid: 3000, created_ms: 5000, status: { state, app: 'codex' }, labels: {} };
}

test('alignment check reports readiness separately from delivery', () => {
  const client = new HerdrClient();
  const details = terminal({ state: 'working' });
  client.get = () => ({ success: true, details });
  const requests = [];
  let notice = { success: true, stdout: JSON.stringify({ started: true, turn: 8 }) };
  let tagged = true;
  client.exec = args => {
    requests.push(args[0]);
    return args[0] === 'send' ? notice : { success: tagged };
  };
  assert.deepEqual(client.requestAlignment('t21'), { address: 't21', state: 'unconfirmed', request: { status: 'deferred_busy' } });
  assert.deepEqual(requests, []);
  details.status.state = 'idle';
  assert.equal(client.requestAlignment('t21').request.status, 'sent');
  assert.deepEqual(requests, ['label', 'send']);
  notice = { success: true, stdout: JSON.stringify({ started: false, turn: 8 }) };
  assert.equal(client.requestAlignment('t21').request.status, 'uncertain');
  notice = { success: false, stderr: JSON.stringify({ error: { kind: 'status_mismatch' } }) };
  assert.equal(client.requestAlignment('t21').request.status, 'deferred_busy');
  tagged = false;
  assert.equal(client.requestAlignment('t21').request.status, 'failed');
  assert.equal(requests.at(-1), 'label');
  details.labels[alignmentKey] = alignmentLabel(details, 'aligned').split('=')[1];
  assert.equal(client.requestAlignment('t21', { refresh: true }).request.status, 'already_aligned');
});

test('send reports missing terminals and subprocess errors at their source', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'council-send-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const client = new HerdrClient({ cwd, bin: join(cwd, 'missing-hc.exe') });
  client.get = () => ({ success: false, error: 'Terminal t21 no longer exists' });
  const unavailable = client.send('t21', 'Review the change');
  assert.equal(unavailable.attempted, false);
  assert.equal(unavailable.error, 'Terminal t21 no longer exists');

  const details = terminal();
  details.labels[alignmentKey] = alignmentLabel(details, 'aligned').split('=')[1];
  client.get = () => ({ success: true, details });
  const failed = client.send('t21', 'Review the change');
  assert.equal(failed.success, false);
  assert.match(failed.error, /missing-hc\.exe.*ENOENT/i);
});

test('long prompts travel over Herdr stdin exactly once with the original delivery guard', () => {
  const client = new HerdrClient();
  client.terminalId = 't32';
  const details = { ...terminal({ state: 'idle' }), address: 'remote/t21' };
  details.labels[alignmentKey] = alignmentLabel(details, 'aligned').split('=')[1];
  client.get = () => ({ success: true, details });
  const brief = 'Review "parser" at C:\\code\\parser.\r\n    λ → 🧪\r\n'.repeat(1500);
  const ack = { started: true, turn: 8, status: 'idle' };
  const requests = [];
  let replyId = 1;
  client.exec = (args, { input, timeout }) => {
    assert.deepEqual(args, ['connect', '--json']);
    assert.ok(timeout > 0 && timeout <= 1000);
    const request = JSON.parse(input);
    requests.push(request);
    return { success: true, stdout: JSON.stringify({ jsonrpc: '2.0', id: replyId, result: ack }) };
  };

  const sent = client.send('reviewer', brief, { expectedTurn: 8, timeout: 1000 });
  assert.equal(sent.success, true);
  assert.deepEqual(JSON.parse(sent.output), ack);
  assert.deepEqual(requests, [{
    jsonrpc: '2.0', id: 1, method: 'terminal.send',
    params: { terminal: 'remote/t21', text: brief, caller: 't32', if: 'idle', wait: false }
  }]);

  replyId = 2;
  const unconfirmed = client.send('reviewer', brief, { expectedTurn: 8, timeout: 1000 });
  assert.equal(unconfirmed.success, false);
  assert.match(unconfirmed.error, /valid send reply/);
  assert.equal(requests.length, 2, 'Do not retry delivery when the reply cannot be verified');
});

test('guarded capture waits for a stable screen and verifies terminal state through the history read', async () => {
  const client = new HerdrClient();
  const screen = ['Rendering…', 'Partial output', 'Final answer'];
  let visibleReads = 0;
  let historyReads = 0;
  const payload = (text, complete = true) => ({ success: true, stdout: JSON.stringify({ complete, text }) });
  client.get = () => ({ success: true, details: terminal() });
  client.exec = (args, { timeout }) => {
    assert.ok(timeout > 0 && timeout <= 2000);
    assert.deepEqual(args.slice(0, 3), ['read', '--json', '--lines']);
    if (args[3] === '0') return payload(screen[Math.min(visibleReads++, screen.length - 1)]);
    ++historyReads;
    return payload('Old history\nFinal answer');
  };
  const result = await client.captureTurn('t21', 8, { deadlineMs: Date.now() + 2000, quietMs: 20 });
  assert.equal(result.success, true);
  assert.match(result.content, /Final answer/);
  assert.equal(result.captureScope, 'history');
  assert.equal(historyReads, 1);
  assert.ok(visibleReads >= 4);

  client.exec = args => args[3] === '0' ? payload('Visible answer') : payload('Partial history', false);
  const fallback = await client.captureTurn('t21', 8, { deadlineMs: Date.now() + 1000, quietMs: 1 });
  assert.equal(fallback.content, 'Visible answer');
  assert.equal(fallback.captureScope, 'screen');
});

test('guarded capture rejects a turn change during a successful read', async () => {
  const client = new HerdrClient();
  let turn = 8;
  client.get = () => ({ success: true, details: terminal({ turn }) });
  client.exec = () => {
    turn = 9;
    return { success: true, stdout: JSON.stringify({ complete: true, text: 'A different answer' }) };
  };
  const result = await client.captureTurn('t21', 8, { deadlineMs: Date.now() + 1000 });
  assert.equal(result.success, false);
  assert.match(result.error, /could not verify Council turn 8/);
});

test('guarded capture rejects a replacement process even when the completed turn matches', async () => {
  const client = new HerdrClient();
  const details = terminal();
  client.get = () => ({ success: true, details: { ...details, pid: details.pid + 1 } });
  client.exec = () => assert.fail('A different process must never be captured');
  const result = await client.captureTurn(details.address, details.turn, {
    deadlineMs: Date.now() + 1000, identity: `${details.created_ms}:${details.pid}:${details.status.app}`
  });
  assert.equal(result.success, false);
  assert.match(result.error, /changed process/);
});

test('guarded capture bounds a stalled subprocess by the remaining deadline', async () => {
  const client = new HerdrClient({ bin: process.execPath });
  const exec = client.exec.bind(client);
  client.get = () => ({ success: true, details: terminal() });
  client.exec = (_args, options) => exec(['-e', 'setTimeout(() => process.exit(0), 3000)'], options);
  const start = Date.now();
  const result = await client.captureTurn('t21', 8, { deadlineMs: start + 250 });
  assert.equal(result.success, false);
  assert.equal(result.isTimeout, true);
  assert.ok(Date.now() - start < 2000, 'the stalled command must be interrupted');
});
