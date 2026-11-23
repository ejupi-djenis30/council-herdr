import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CouncilOrchestrator, SUPPORTED_MODES } from '../lib/modes.js';

function fixture(t, { blocked } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'council-workflow-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const events = [];
  const prompts = [];
  const herdr = {
    launchAgent(options) {
      prompts.push(options);
      const address = `t${prompts.length}`;
      events.push(`launch ${address}`);
      return { success: true, address, baselineTurn: 4, details: { first_message: { sent: true } } };
    },
    wait(address) {
      events.push(`wait ${address}`);
      if (address === blocked) return { success: false, isBlocked: true, error: 'Awaiting input' };
      return { success: true, terminal: address, ended: true, reason: 'status', status: 'done', turn: 5 };
    },
    captureTurn(address, turn) {
      events.push(`capture ${address}`);
      assert.equal(turn, 5);
      return { success: true, content: `Evidence collected from ${address}` };
    },
    dismiss(address) { events.push(`dismiss ${address}`); }
  };
  return { events, prompts, orchestrator: new CouncilOrchestrator({ cwd, herdr }) };
}

test('debate collects both arguments before giving the judge exact saved references', async t => {
  const { orchestrator, events, prompts } = fixture(t);
  const result = await orchestrator.runMode({ mode: 'debate', task: 'Compare two parser strategies' });
  assert.ok(SUPPORTED_MODES.includes('debate'));
  assert.equal(result.success, true);
  assert.equal(result.authorized, false);
  assert.deepEqual(events.slice(0, 7), ['launch t1', 'launch t2', 'wait t1', 'capture t1', 'wait t2', 'capture t2', 'launch t3']);
  const saved = JSON.parse(readFileSync(join(result.sessionDir, 'validation', 'verdict.json'), 'utf8'));
  for (const artifact of saved.artifacts.slice(0, 2)) {
    assert.ok(prompts[2].task.includes(artifact.path));
    assert.ok(prompts[2].task.includes(artifact.sha256));
    assert.equal(readFileSync(artifact.path, 'utf8'), result.findings[artifact.name]);
  }
  assert.equal(existsSync(join(result.sessionDir, 'reports', 'report.md')), false);
  assert.deepEqual(readdirSync(join(result.sessionDir, 'ballots')), []);
  assert.match(result.report, /Evidence collected from t3/);
});

test('parallel keeps incomplete terminals and saves successful assignments', async t => {
  const { orchestrator, events, prompts } = fixture(t, { blocked: 't2' });
  const result = await orchestrator.runMode({ mode: 'parallel', task: 'Diagnose throughput', subtasks: ['Profile CPU', 'Inspect disk'] });
  assert.ok(SUPPORTED_MODES.includes('parallel'));
  assert.equal(result.success, false);
  assert.match(prompts[0].task, /Profile CPU/);
  assert.match(prompts[1].task, /Inspect disk/);
  assert.deepEqual(events, ['launch t1', 'launch t2', 'wait t1', 'capture t1', 'wait t2', 'dismiss t1']);
  assert.equal(result.execution['parallel-worker-2'].error, 'Awaiting input');
  assert.match(readFileSync(result.reportPath, 'utf8'), /parallel-worker-2 \(t2\) Awaiting input/);
});

test('debate prevents a judge handoff when a saved argument changes', async t => {
  const { orchestrator, prompts } = fixture(t);
  const capture = orchestrator.herdr.captureTurn;
  orchestrator.herdr.captureTurn = (address, turn) => {
    if (address === 't2') {
      writeFileSync(join(prompts[0].sessionDir, 'artifacts', 'arguments', 'debate-side-a', 'artifact.md'), 'Altered argument');
    }
    return capture(address, turn);
  };
  const result = await orchestrator.runMode({ mode: 'debate', task: 'Compare two parser strategies' });
  assert.equal(result.success, false);
  assert.equal(prompts.length, 2);
  assert.match(result.execution['debate-judge'].error, /changed before handoff/);
});

test('pipeline hands off the saved previous stage and stops before missing input', async t => {
  const { orchestrator, events, prompts } = fixture(t, { blocked: 't2' });
  const result = await orchestrator.runMode({ mode: 'pipeline', task: 'Review parser options', permission: 'write', stages: [
    { name: 'Evidence', task: 'Read the parser implementation', agent: 'junie' },
    { name: 'Check', role: 'reviewer' }, { name: 'Summarize' }
  ] });
  assert.ok(SUPPORTED_MODES.includes('pipeline'));
  assert.equal(result.success, false);
  assert.equal(prompts[0].agent, 'junie');
  assert.equal(prompts[1].permission, 'read');
  assert.match(prompts[1].task, /pipeline-stage-1[\\/]artifact\.md/);
  assert.match(prompts[1].task, /SHA-256: [a-f0-9]{64}/);
  assert.deepEqual(events, ['launch t1', 'wait t1', 'capture t1', 'launch t2', 'wait t2', 'dismiss t1']);
  assert.equal(result.participants[2].status, 'not started');
  await assert.rejects(orchestrator.runMode({ mode: 'parallel', task: 'Do other work', sessionId: result.sessionId }), /already exists/);
});
