import test from 'node:test';
import assert from 'node:assert/strict';
import { CouncilOrchestrator, SUPPORTED_MODES } from '../lib/modes.js';

class MockHerdrClient {
  constructor() {
    this.launched = [];
    this.waited = [];
    this.dismissed = [];
  }

  launchAgent(opts) {
    this.launched.push(opts);
    return { success: true, name: opts.name, agent: opts.agent };
  }

  wait(name) {
    this.waited.push(name);
    return { success: true, target: name, output: 'done' };
  }

  read(name) {
    return { success: true, target: name, content: `Mock output from ${name}` };
  }

  dismiss(name) {
    this.dismissed.push(name);
    return { success: true, target: name };
  }
}

test('CouncilOrchestrator rejects unsupported modes', async () => {
  const orchestrator = new CouncilOrchestrator({ herdr: new MockHerdrClient() });
  await assert.rejects(
    async () => orchestrator.runMode({ mode: 'invalid_mode', task: 'test' }),
    /Unsupported mode/
  );
});

test('CouncilOrchestrator rejects missing task', async () => {
  const orchestrator = new CouncilOrchestrator({ herdr: new MockHerdrClient() });
  await assert.rejects(
    async () => orchestrator.runMode({ mode: 'council', task: '' }),
    /A task description is required/
  );
});

test('CouncilOrchestrator runs council mode and cleans up terminals', async () => {
  const mockHerdr = new MockHerdrClient();
  const orchestrator = new CouncilOrchestrator({ herdr: mockHerdr });

  const res = await orchestrator.runMode({
    mode: 'council',
    task: 'Determine architecture',
    agents: ['claude', 'codex', 'antigravity'],
    keepTerminals: false
  });

  assert.equal(res.success, true);
  assert.equal(mockHerdr.launched.length, 3);
  assert.equal(mockHerdr.waited.length, 3);
  assert.equal(mockHerdr.dismissed.length, 3);
  assert.match(res.report, /Full Council Deliberation/);
});

test('CouncilOrchestrator runs review mode', async () => {
  const mockHerdr = new MockHerdrClient();
  const orchestrator = new CouncilOrchestrator({ herdr: mockHerdr });

  const res = await orchestrator.runMode({
    mode: 'review',
    task: 'Review auth.js',
    agents: ['claude', 'codex', 'junie'],
    keepTerminals: false
  });

  assert.equal(res.success, true);
  assert.equal(mockHerdr.launched.length, 3);
  assert.match(res.report, /Peer Review & Simplification Report/);
  assert.equal(mockHerdr.dismissed.length, 3);
});

test('CouncilOrchestrator runs debate mode', async () => {
  const mockHerdr = new MockHerdrClient();
  const orchestrator = new CouncilOrchestrator({ herdr: mockHerdr });

  const res = await orchestrator.runMode({
    mode: 'debate',
    task: 'REST vs gRPC for internal services',
    agents: ['claude', 'codex', 'antigravity'],
    keepTerminals: false
  });

  assert.equal(res.success, true);
  assert.equal(mockHerdr.launched.length, 3);
  assert.match(res.report, /Structured Debate & Verdict Report/);
});

test('CouncilOrchestrator runs parallel mode', async () => {
  const mockHerdr = new MockHerdrClient();
  const orchestrator = new CouncilOrchestrator({ herdr: mockHerdr });

  const res = await orchestrator.runMode({
    mode: 'parallel',
    task: 'Investigate performance',
    subtasks: ['Profile CPU', 'Profile Memory', 'Profile I/O'],
    agents: ['claude', 'codex', 'antigravity'],
    keepTerminals: false
  });

  assert.equal(res.success, true);
  assert.equal(mockHerdr.launched.length, 3);
  assert.match(res.report, /Parallel Fan-Out Report/);
});

test('CouncilOrchestrator runs pipeline mode', async () => {
  const mockHerdr = new MockHerdrClient();
  const orchestrator = new CouncilOrchestrator({ herdr: mockHerdr });

  const res = await orchestrator.runMode({
    mode: 'pipeline',
    task: 'Build payment webhook',
    stages: [
      { name: 'Schema', role: 'author' },
      { name: 'Handler', role: 'author' },
      { name: 'Tests', role: 'reviewer' }
    ],
    agents: ['claude', 'codex'],
    keepTerminals: false
  });

  assert.equal(res.success, true);
  assert.equal(mockHerdr.launched.length, 3);
  assert.match(res.report, /Sequential Pipeline Execution Report/);
});

test('CouncilOrchestrator runs delegate mode', async () => {
  const mockHerdr = new MockHerdrClient();
  const orchestrator = new CouncilOrchestrator({ herdr: mockHerdr });

  const res = await orchestrator.runDelegate({
    agent: 'codex',
    task: 'Write parser tests',
    permission: 'read',
    keepTerminals: false
  });

  assert.equal(res.success, true);
  assert.equal(res.agent, 'codex');
  assert.match(res.output, /Mock output from delegate-codex/);
  assert.equal(mockHerdr.dismissed.length, 1);
});
