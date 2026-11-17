import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAgentName,
  buildAgentLaunchArgs,
  buildHcRunArgs,
  SUPPORTED_AGENTS
} from '../lib/recipes.js';

test('normalizeAgentName handles aliases and case', () => {
  assert.equal(normalizeAgentName('Claude'), 'claude');
  assert.equal(normalizeAgentName('claude-code'), 'claude');
  assert.equal(normalizeAgentName('CODEX'), 'codex');
  assert.equal(normalizeAgentName('openai-codex'), 'codex');
  assert.equal(normalizeAgentName('antigravity'), 'antigravity');
  assert.equal(normalizeAgentName('agy'), 'antigravity');
  assert.equal(normalizeAgentName('junie'), 'junie');
  assert.equal(normalizeAgentName('unknown-agent'), 'unknown-agent');
});

test('buildAgentLaunchArgs for Claude Code', () => {
  const readArgs = buildAgentLaunchArgs('claude', 'read', 'Inspect bug');
  assert.deepEqual(readArgs, ['claude', '--permission-mode', 'plan', 'Inspect bug']);

  const writeArgs = buildAgentLaunchArgs('claude', 'write', 'Fix bug');
  assert.deepEqual(writeArgs, ['claude', '--permission-mode', 'acceptEdits', 'Fix bug']);
});

test('buildAgentLaunchArgs for Codex enforces --no-daemon', () => {
  const readArgs = buildAgentLaunchArgs('codex', 'read', 'Task');
  assert.deepEqual(readArgs, ['codex', '--no-daemon', '-s', 'read-only', '-a', 'never', 'Task']);

  const writeArgs = buildAgentLaunchArgs('codex', 'write', 'Task');
  assert.deepEqual(writeArgs, ['codex', '--no-daemon', '-s', 'workspace-write', '-a', 'never', 'Task']);
});

test('buildAgentLaunchArgs for Antigravity uses -i flag before task', () => {
  const readArgs = buildAgentLaunchArgs('antigravity', 'read', 'Task');
  assert.deepEqual(readArgs, ['agy', '--mode', 'plan', '-i', 'Task']);

  const writeArgs = buildAgentLaunchArgs('agy', 'write', 'Task');
  assert.deepEqual(writeArgs, ['agy', '--mode', 'accept-edits', '-i', 'Task']);
});

test('buildAgentLaunchArgs for Junie uses --prompt= flag to maintain interactivity', () => {
  const readArgs = buildAgentLaunchArgs('junie', 'read', 'Task');
  assert.deepEqual(readArgs, ['junie', '--plan', '--prompt=Task']);

  const writeArgs = buildAgentLaunchArgs('junie', 'write', 'Task');
  assert.deepEqual(writeArgs, ['junie', '--prompt=Task']);
});

test('buildHcRunArgs passes arguments safely after -- delimiter', () => {
  const args = buildHcRunArgs({
    name: 'council-author',
    cwd: 'C:\\test\\dir',
    agent: 'claude',
    permission: 'read',
    task: 'Do review'
  });

  assert.equal(args[0], 'run');
  assert.equal(args[1], '--bg');
  assert.equal(args[2], '--name');
  assert.equal(args[3], 'council-author');
  assert.equal(args[4], '--cwd');
  assert.equal(args[5], 'C:\\test\\dir');
  assert.equal(args[6], '--');
  assert.deepEqual(args.slice(7), ['claude', '--permission-mode', 'plan', 'Do review']);
});
