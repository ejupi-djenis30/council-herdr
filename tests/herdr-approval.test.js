import test from 'node:test';
import assert from 'node:assert/strict';
import { followBlockedTurn } from '../lib/herdr-approval.js';
import { terminalIdentity } from '../herdr/mods/council/runtime/alignment.mjs';

const target = 't21';
const blocked = {
  address: target, state: 'live', turn: 8, pid: 3000, created_ms: 5000, reported: true,
  status: { state: 'blocked', app: 'junie', kind: 'permission' }
};
const snapshot = terminal => ({ channel: null, seq: 100, terminals: [terminal] });
const event = (type, data) => ({ jsonrpc: '2.0', method: 'event', params: { terminal: target, type, data } });
const status = state => event('status', { reported: true, status: { state, app: 'junie' } });
const turn = (state, number) => event('turn', { state, turn: number });
const done = [status('done'), turn('done', 9)];

function follow(events, onProgress = () => {}) {
  return followBlockedTurn(events.map(value => JSON.stringify(value)), {
    target, blockedTurn: 8, identity: terminalIdentity(blocked), onProgress
  });
}

test('follows two approval prompts through the exact Herdr status and turn transitions', async () => {
  const progress = [];
  const result = await follow([
    snapshot(blocked), status('working'), status('blocked'), turn('blocked', 9), status('working'), status('done'), turn('done', 10)
  ], state => progress.push(state));
  assert.deepEqual(progress, [
    { status: 'blocked', turn: 8 }, { status: 'working', turn: 8 }, { status: 'blocked', turn: 9 }, { status: 'working', turn: 9 }
  ]);
  assert.deepEqual(result, { success: true, turn: 10, status: 'done' });
});

test('refuses to capture when the approval continuation cannot be established', async () => {
  for (const events of [
    [snapshot({ ...blocked, pid: 3001 }), status('working'), ...done],
    [snapshot({ ...blocked, status: { ...blocked.status, state: 'working' } }), ...done],
    [snapshot(blocked), ...done],
    [snapshot(blocked), status('idle'), status('working'), ...done],
    [snapshot(blocked), status('working'), status('done'), turn('done', 10)],
    [snapshot(blocked), status('working'), event('restarted'), ...done],
    [snapshot(blocked), status('working'), snapshot(blocked), ...done],
    [snapshot(blocked), status('working')]
  ]) {
    const result = await follow(events);
    assert.equal(result.success, false);
    assert.match(result.error, /Could not verify approval continuation/);
  }
});
