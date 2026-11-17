import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorkspace } from '../lib/workspace.js';

test('AgentWorkspace initializes deterministic session directory structure', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-ws-test-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionId, sessionDir, sessionMeta } = ws.initSession({
      sessionId: 'test-session-1',
      mode: 'council',
      task: 'Build distributed queue',
      context: 'Kafka/RabbitMQ',
      criteria: 'High availability',
      participants: [{ name: 'author', role: 'author', agent: 'claude' }]
    });

    assert.equal(sessionId, 'test-session-1');
    assert.ok(existsSync(join(sessionDir, 'task', 'task.md')));
    assert.ok(existsSync(join(sessionDir, 'task', 'context.md')));
    assert.ok(existsSync(join(sessionDir, 'task', 'criteria.md')));
    assert.ok(existsSync(join(sessionDir, 'session.json')));
    assert.ok(existsSync(join(sessionDir, 'artifacts')));
    assert.ok(existsSync(join(sessionDir, 'ballots')));
    assert.ok(existsSync(join(sessionDir, 'validation')));
    assert.ok(existsSync(join(sessionDir, 'reports')));

    assert.equal(sessionMeta.mode, 'council');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace writes and reads artifacts with SHA-256 verification', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-ws-test-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({
      sessionId: 'test-art',
      mode: 'review',
      task: 'Task'
    });

    const content = '# Design Proposal\nUse Redis Streams.';
    const artRes = ws.writeArtifact(sessionDir, {
      phase: 'deliberation',
      author: 'council-author',
      agent: 'claude',
      content,
      metadata: { role: 'author' }
    });

    assert.ok(existsSync(artRes.artifactPath));
    assert.equal(artRes.sha256, ws.sha256(content));

    // Verify index.jsonl was written
    const indexContent = readFileSync(join(sessionDir, 'artifacts', 'index.jsonl'), 'utf8');
    assert.match(indexContent, /council-author/);
    assert.match(indexContent, new RegExp(artRes.sha256));

    // Read artifact back
    const read = ws.readArtifact(sessionDir, 'deliberation', 'council-author');
    assert.equal(read.content, content);
    assert.equal(read.verified, true);
    assert.equal(read.sha256, artRes.sha256);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace casts and tallies ballots with quorum and dissent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-ws-test-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({
      sessionId: 'test-ballots',
      mode: 'council',
      task: 'Task'
    });

    // Cast 3 ballots
    ws.castBallot(sessionDir, {
      round: 1,
      voter: 'author',
      role: 'author',
      agent: 'claude',
      vote: 'approve',
      score: 9,
      rationale: 'Clean architecture'
    });

    ws.castBallot(sessionDir, {
      round: 1,
      voter: 'skeptic',
      role: 'skeptic',
      agent: 'codex',
      vote: 'amend',
      score: 7,
      rationale: 'Need retry logic for timeouts',
      amendments: ['Add exponential backoff']
    });

    ws.castBallot(sessionDir, {
      round: 1,
      voter: 'simplifier',
      role: 'simplifier',
      agent: 'antigravity',
      vote: 'approve',
      score: 8,
      rationale: 'Ponytail audit passed'
    });

    const tally = ws.tallyBallots(sessionDir, 1, ['author', 'skeptic', 'simplifier'], {
      quorum: 0.67,
      approvalThreshold: 0.6
    });

    assert.equal(tally.castCount, 3);
    assert.equal(tally.quorumMet, true);
    assert.equal(tally.approveCount, 2);
    assert.equal(tally.amendCount, 1);
    assert.equal(tally.passed, true);
    assert.equal(tally.dissent.length, 1);
    assert.equal(tally.dissent[0].voter, 'skeptic');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace representative validation pipeline verifies artifact integrity', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-ws-test-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({
      sessionId: 'test-validation',
      mode: 'council',
      task: 'Task'
    });

    // Write artifact
    const art = ws.writeArtifact(sessionDir, {
      phase: 'deliberation',
      author: 'council-author',
      content: 'Solid solution.'
    });

    // Validate as representative
    const val = ws.validateChoice(sessionDir, {
      representative: 'council-judge',
      round: 1,
      targetArtifact: { phase: 'deliberation', author: 'council-author' },
      verdict: 'validated',
      rationale: 'Quorum met and verified by representative.',
      conditions: ['Ensure unit tests pass']
    });

    assert.equal(val.record.verdict, 'validated');
    assert.equal(val.record.artifactIntegrity, true);
    assert.equal(val.record.verifiedSha256, art.sha256);
    assert.ok(existsSync(val.auditReportPath));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
