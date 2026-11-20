import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HerdrClient } from '../lib/herdr.js';

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
  assert.doesNotMatch(launches[0].at(-1), /Build the feature/);
  client.waitForAlignment = () => ({ state: 'aligned', turn: 1 });
  const res = client.launchAgent(options);
  assert.equal(res.success, true);
  assert.equal(res.baselineTurn, 1);
  assert.equal(sends.length, 1);
  assert.equal(existsSync(briefPath), true, 'Brief file should be created');
});
