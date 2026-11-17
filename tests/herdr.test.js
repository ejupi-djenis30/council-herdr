import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
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

test('HerdrClient writes brief file for multiline tasks', () => {
  const testCwd = process.cwd();
  const client = new HerdrClient({ cwd: testCwd });

  // Mock exec to avoid calling real hc during unit test
  const originalExec = client.exec;
  let capturedArgs = null;
  client.exec = (args) => {
    capturedArgs = args;
    return { success: true, stdout: 'started', stderr: '', code: 0 };
  };

  const longTask = 'Line 1: Build the feature\nLine 2: Ensure test coverage\nLine 3: Document it';
  const res = client.launchAgent({
    name: 'test-agent',
    agent: 'claude',
    permission: 'read',
    cwd: testCwd,
    task: longTask
  });

  assert.equal(res.success, true);
  const briefPath = join(testCwd, '.agent_workspace', 'default', 'briefs', 'test-agent.md');
  assert.equal(existsSync(briefPath), true, 'Brief file should be created');

  // Cleanup brief file
  try { unlinkSync(briefPath); } catch {}
  client.exec = originalExec;
});
