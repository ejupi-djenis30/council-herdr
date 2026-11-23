import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CouncilOrchestrator, SUPPORTED_MODES } from '../lib/modes.js';
import { AgentWorkspace } from '../lib/workspace.js';

const cwd = mkdtempSync(join(tmpdir(), 'council-modes-'));
test.after(() => rmSync(cwd, { recursive: true, force: true }));

class MockHerdrClient {
  constructor(options = {}) {
    this.launched = [];
    this.waited = [];
    this.dismissed = [];
    this.castDirectOnLaunch = options.castDirectOnLaunch !== false;
  }

  launchAgent(opts) {
    const address = `t-mock-${this.launched.length}`;
    this.launched.push({ ...opts, address });

    if (this.castDirectOnLaunch && opts.sessionDir) {
      const ws = new AgentWorkspace();
      const authorContent = 'Mock proposal content for author';
      const sha = ws.sha256(authorContent);
      const isReview = opts.name.startsWith('r-');
      let voter = opts.name;
      let role = 'reviewer';
      if (opts.name.includes('auth')) {
        voter = isReview ? 'review-author' : 'council-author';
        role = 'author';
      } else if (opts.name.includes('skep')) {
        voter = 'council-skeptic';
        role = 'skeptic';
      } else if (opts.name.includes('simp')) {
        voter = isReview ? 'review-simplifier' : 'council-simplifier';
        role = 'simplifier';
      } else if (opts.name.includes('rev')) {
        voter = 'review-reviewer';
        role = 'reviewer';
      }

      const ballotPath = join(opts.sessionDir, 'ballots', 'round-1', `${ws.sanitizeName(voter)}.json`);
      if (!existsSync(ballotPath)) {
        ws.castBallot(opts.sessionDir, {
          round: 1,
          voter,
          role,
          agent: opts.agent,
          vote: 'approve',
          score: 9,
          rationale: 'Direct mock ballot approved',
          targetArtifactSha256: sha,
          source: 'direct'
        });
      }
    }

    return {
      success: true,
      name: opts.name,
      address,
      agent: opts.agent,
      details: { address, first_message: { sent: true } }
    };
  }

  wait(name) {
    this.waited.push(name);
    return { success: true, target: name, terminal: name, ended: true, status: 'done', reason: 'status', turn: 1 };
  }

  read(name) {
    const record = this.launched.find(l => l.address === name || l.opts?.name === name || l.name === name);
    const isAuthor = (record?.opts?.name || record?.name || name).includes('auth');
    const content = isAuthor ? 'Mock proposal content for author' : `Mock output for ${record?.opts?.name || record?.name || name}`;
    return { success: true, target: name, content };
  }

  captureTurn(name) {
    return this.read(name);
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
  const orchestrator = new CouncilOrchestrator({ cwd, herdr: mockHerdr });

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
  assert.match(res.report, /Council Deliberation Report/);
});

test('CouncilOrchestrator runs review mode', async () => {
  const mockHerdr = new MockHerdrClient();
  const orchestrator = new CouncilOrchestrator({ cwd, herdr: mockHerdr });

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

test('CouncilOrchestrator runs delegate mode', async () => {
  const mockHerdr = new MockHerdrClient();
  const orchestrator = new CouncilOrchestrator({ cwd, herdr: mockHerdr });

  const res = await orchestrator.runDelegate({
    agent: 'codex',
    task: 'Write parser tests',
    permission: 'read',
    keepTerminals: false
  });

  assert.equal(res.success, true);
  assert.equal(res.agent, 'codex');
  assert.match(res.output, /Mock output for delegate-codex/);
  assert.equal(mockHerdr.dismissed.length, 1);
});

test('CouncilOrchestrator detects and respects directly cast ballots without marker fallback', async () => {
  const mockHerdr = new MockHerdrClient();
  const orchestrator = new CouncilOrchestrator({ cwd, herdr: mockHerdr });
  const testSid = `test-direct-ballot-${Date.now().toString(36)}`;
  const sDir = orchestrator.workspace.resolveSessionDir(testSid);

  let expectedSha;
  const progressEvents = [];
  const res = await orchestrator.runMode({
    mode: 'council',
    sessionId: testSid,
    task: 'Evaluate storage engine design',
    agents: ['claude', 'codex', 'antigravity'],
    keepTerminals: false,
    onProgress(ev) {
      progressEvents.push(ev);
      if (ev.stage === 'author_completed') expectedSha = ev.sha256;
      if (ev.stage === 'waiting_reviewer' && ev.name === 'council-skeptic') {
        orchestrator.workspace.castBallot(sDir, { round: 1, voter: ev.name, role: 'skeptic', agent: 'codex',
          vote: 'reject', score: 2, rationale: 'Direct ballot: fatal race condition in storage engine',
          targetArtifactSha256: expectedSha });
      }
    }
  });

  assert.equal(res.success, true);

  // Verify that ballot_detected was emitted for the direct voter
  const directEvent = progressEvents.find(
    e => e.stage === 'ballot_detected' && e.name === 'council-skeptic'
  );
  assert.ok(directEvent, 'Expected ballot_detected event for council-skeptic');
  assert.equal(directEvent.source, 'direct');

  // Verify that the direct ballot's score and rationale are recorded in the tally
  assert.equal(res.tally.rejectCount, 1);
  assert.ok(
    res.tally.dissent.some(d => d.rationale.includes('fatal race condition')),
    'Direct ballot rationale should be included in tally dissent'
  );
});
