import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentWorkspace, sanitizeName, atomicWrite } from '../lib/workspace.js';

test('sanitizeName protects against Windows reserved device names, case, and dots', () => {
  assert.equal(sanitizeName('CON'), 'node-con');
  assert.equal(sanitizeName('prn'), 'node-prn');
  assert.equal(sanitizeName('aux'), 'node-aux');
  assert.equal(sanitizeName('aux.txt'), 'node-aux-txt');
  assert.equal(sanitizeName('COM1'), 'node-com1');
  assert.equal(sanitizeName('Council-Author...'), 'council-author');
  assert.equal(sanitizeName('  Reviewer-1  '), 'reviewer-1');
  assert.equal(sanitizeName('my_agent/test'), 'my-agent-test');
});

test('atomicWrite creates directories and writes atomically', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-atomic-'));
  try {
    const file = join(tmp, 'nested', 'dir', 'test.txt');
    atomicWrite(file, 'Hello world');
    assert.equal(readFileSync(file, 'utf8'), 'Hello world');

    // Overwrite atomically
    atomicWrite(file, 'Hello updated');
    assert.equal(readFileSync(file, 'utf8'), 'Hello updated');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

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

test('AgentWorkspace writes and reads artifacts with SHA-256 and metadata', () => {
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

    // Verify meta.json has size and mtime
    const meta = JSON.parse(readFileSync(artRes.metaPath, 'utf8'));
    assert.equal(meta.byteLength, Buffer.byteLength(content, 'utf8'));
    assert.ok(meta.mtime);

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

test('AgentWorkspace tallies ballots deterministically with sorted order', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-ws-test-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({
      sessionId: 'test-ballots',
      mode: 'council',
      task: 'Task'
    });

    // Cast ballots in arbitrary order
    ws.castBallot(sessionDir, {
      round: 1,
      voter: 'zebra-voter',
      role: 'simplifier',
      agent: 'antigravity',
      vote: 'approve',
      score: 8,
      rationale: 'Ponytail audit passed'
    });

    ws.castBallot(sessionDir, {
      round: 1,
      voter: 'alpha-voter',
      role: 'author',
      agent: 'claude',
      vote: 'approve',
      score: 10,
      rationale: 'Clean architecture'
    });

    ws.castBallot(sessionDir, {
      round: 1,
      voter: 'beta-voter',
      role: 'skeptic',
      agent: 'codex',
      vote: 'amend',
      score: 7,
      rationale: 'Need retry logic for timeouts',
      amendments: ['Add exponential backoff']
    });

    const tally = ws.tallyBallots(sessionDir, 1, ['zebra-voter', 'alpha-voter', 'beta-voter'], {
      quorum: 0.67,
      approvalThreshold: 0.6
    });

    assert.equal(tally.castCount, 3);
    assert.equal(tally.quorumMet, true);
    assert.equal(tally.approveCount, 2);
    assert.equal(tally.amendCount, 1);
    assert.equal(tally.passed, true);

    // Verify deterministic sorting: score 10 first (alpha), score 8 second (zebra), score 7 third (beta)
    assert.equal(tally.sortedBallots[0].voter, 'alpha-voter');
    assert.equal(tally.sortedBallots[1].voter, 'zebra-voter');
    assert.equal(tally.sortedBallots[2].voter, 'beta-voter');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace elects representative deterministically', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-ws-test-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({
      sessionId: 'test-election',
      mode: 'council',
      task: 'Task'
    });

    ws.castBallot(sessionDir, { round: 1, voter: 'bob', role: 'author', score: 9 });
    ws.castBallot(sessionDir, { round: 1, voter: 'alice', role: 'judge', score: 9 });
    ws.castBallot(sessionDir, { round: 1, voter: 'charlie', role: 'skeptic', score: 7 });

    const election = ws.electRepresentative(sessionDir, 1, ['bob', 'alice', 'charlie']);
    // alice and bob both have score 9; lexicographic tie-breaker elects 'alice'
    assert.equal(election.elected, 'alice');
    assert.equal(election.rule, 'highest-score-then-lexicographic-name');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace detects post-vote mutation and refuses promotion', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-ws-test-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({
      sessionId: 'test-mutation',
      mode: 'council',
      task: 'Task'
    });

    const art = ws.writeArtifact(sessionDir, {
      phase: 'deliberation',
      author: 'council-author',
      content: 'Original unmutated solution.'
    });

    // Simulate malicious post-vote file modification on disk
    writeFileSync(art.artifactPath, 'Tampered solution with security backdoor!', 'utf8');

    // Run representative validation checking against original hash
    const val = ws.validateChoice(sessionDir, {
      representative: 'council-judge',
      round: 1,
      targetArtifact: { phase: 'deliberation', author: 'council-author' },
      expectedSha256: art.sha256,
      verdict: 'validated'
    });

    assert.equal(val.passed, false);
    assert.equal(val.record.verdict, 'vetoed');
    assert.equal(val.record.artifactIntegrity, false);
    assert.equal(val.record.mutationDetected, true);

    // Promotion must be refused
    const promo = ws.saveFinalDeliverables(sessionDir, {
      markdownReport: '# Malicious Report',
      verdictJson: {},
      validationPassed: val.passed
    });

    assert.equal(promo.promoted, false);
    assert.match(promo.reason, /mutation/i);
    assert.equal(existsSync(join(sessionDir, 'reports', 'report.md')), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace reports metaMissing when meta.json is absent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-meta-test-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({ sessionId: 'meta-check', mode: 'review', task: 'Task' });
    const art = ws.writeArtifact(sessionDir, { phase: 'draft', author: 'author', content: 'test' });

    // Remove meta.json
    unlinkSync(art.metaPath);

    const read = ws.readArtifact(sessionDir, 'draft', 'author');
    assert.equal(read.content, 'test');
    assert.equal(read.metaMissing, true);
    assert.equal(read.verified, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace tracks invalid unparseable ballots without flipping quorum', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-invalid-ballot-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({ sessionId: 'invalid-ballot', mode: 'council', task: 'Task' });

    ws.castBallot(sessionDir, { round: 1, voter: 'valid-voter', role: 'author', vote: 'approve', score: 9 });

    // Write a corrupt/unparseable ballot
    const corruptPath = join(sessionDir, 'ballots', 'round-1', 'corrupt-voter.json');
    writeFileSync(corruptPath, '{ corrupt json !!!', 'utf8');

    const tally = ws.tallyBallots(sessionDir, 1, ['valid-voter', 'corrupt-voter'], { quorum: 1.0 });

    assert.equal(tally.castCount, 2);
    assert.equal(tally.validCastCount, 1);
    assert.equal(tally.invalidCount, 1);
    assert.equal(tally.invalidBallots[0].voter, 'corrupt-voter');
    assert.equal(tally.quorumMet, true); // Quorum met because both voters cast something
    assert.equal(tally.approveCount, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace persists election audit details in validation record', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-election-audit-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({ sessionId: 'election-audit', mode: 'council', task: 'Task' });

    ws.castBallot(sessionDir, { round: 1, voter: 'bob', role: 'author', score: 8 });
    ws.castBallot(sessionDir, { round: 1, voter: 'alice', role: 'judge', score: 9 });

    const election = ws.electRepresentative(sessionDir, 1, ['bob', 'alice']);
    const val = ws.validateChoice(sessionDir, {
      representative: election.elected,
      election,
      round: 1,
      verdict: 'validated'
    });

    assert.equal(val.record.representative, 'alice');
    assert.ok(val.record.election);
    assert.equal(val.record.election.elected, 'alice');
    assert.equal(val.record.election.rule, 'highest-score-then-lexicographic-name');
    assert.equal(val.record.election.candidates.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace resolves session directories from ID or path', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-resolve-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const resolvedFromId = ws.resolveSessionDir('my-session');
    assert.equal(resolvedFromId, join(tmp, '.agent_workspace', 'my-session'));

    // Plain ID without separators never collides with cwd folder of same name
    const cwdColDir = join(process.cwd(), 'test-cwd-col');
    try {
      mkdirSync(cwdColDir, { recursive: true });
      assert.equal(ws.resolveSessionDir('test-cwd-col'), join(tmp, '.agent_workspace', 'test-cwd-col'));
    } finally {
      try { rmSync(cwdColDir, { recursive: true, force: true }); } catch {}
    }

    // Explicit path with separator resolves directly
    const explicitRelPath = './custom-dir';
    assert.equal(ws.resolveSessionDir(explicitRelPath), resolve(explicitRelPath));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AgentWorkspace castBallot validates vote enum and normalizes round', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'council-vote-val-'));
  try {
    const ws = new AgentWorkspace(tmp);
    const { sessionDir } = ws.initSession({ sessionId: 'val-test', mode: 'council', task: 'Task' });

    // Invalid vote throws
    assert.throws(
      () => ws.castBallot(sessionDir, { voter: 'v1', vote: 'banana' }),
      /Must be one of: approve, reject, amend/
    );

    // Valid votes with mixed case are normalized
    const res = ws.castBallot(sessionDir, { voter: 'v2', vote: '  APPROVE  ', round: '1.9' });
    assert.equal(res.ballot.vote, 'approve');
    assert.equal(res.ballot.round, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
