import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_DEFINITIONS,
  formatParticipantBrief,
  formatCouncilReport
} from '../lib/formatters.js';

test('ROLE_DEFINITIONS includes all core Council roles', () => {
  assert.ok(ROLE_DEFINITIONS.author);
  assert.ok(ROLE_DEFINITIONS.reviewer);
  assert.ok(ROLE_DEFINITIONS.skeptic);
  assert.ok(ROLE_DEFINITIONS.simplifier);
  assert.ok(ROLE_DEFINITIONS.judge);
});

test('formatParticipantBrief generates well-structured markdown', () => {
  const brief = formatParticipantBrief({
    role: 'skeptic',
    name: 'council-skeptic',
    agent: 'codex',
    mode: 'council',
    task: 'Evaluate the caching layer',
    context: 'Using in-memory LRU',
    criteria: 'Max memory 512MB'
  });

  assert.match(brief, /# Council Member Brief: council-skeptic/);
  assert.match(brief, /Critical Skeptic/);
  assert.match(brief, /Evaluate the caching layer/);
  assert.match(brief, /Using in-memory LRU/);
  assert.match(brief, /Max memory 512MB/);
  assert.match(brief, /Reporting.*Contract/);
  assert.doesNotMatch(brief, /council_cast_ballot/);
});

test('a formal reviewer receives the exact ballot assignment and complete CLI flags', () => {
  const sessionDir = '/project with spaces/.agent_workspace/review-session';
  const digest = 'b'.repeat(64);
  const brief = formatParticipantBrief({
    role: 'reviewer',
    name: 'review-reviewer',
    agent: 'junie',
    mode: 'review',
    task: 'Review the proposal',
    ballot: { sessionDir, round: 2, targetArtifactSha256: digest }
  });

  const [, ballotFields] = brief.match(/```json\n([\s\S]+?)\n```/);
  assert.deepEqual(JSON.parse(ballotFields), {
    sessionId: sessionDir,
    round: 2,
    voter: 'review-reviewer',
    role: 'reviewer',
    agent: 'junie',
    targetArtifactSha256: digest
  });
  const [, ballotCommand] = brief.match(/`(council cast-ballot [^`]+)`/);
  for (const flag of ['session', 'round', 'voter', 'role', 'agent', 'vote', 'score', 'rationale', 'target-sha']) {
    assert.ok(ballotCommand.includes(`--${flag} `), `missing --${flag}`);
  }
  assert.match(brief, /screen markers are provisional evidence only/);
});

test('a Council author is assigned a ballot to bind to their saved proposal', () => {
  const sessionDir = '/project/.agent_workspace/council-session';
  const artifactPath = `${sessionDir}/artifacts/draft/council-author/artifact.md`;
  const brief = formatParticipantBrief({
    role: 'author',
    name: 'council-author',
    agent: 'codex',
    mode: 'council',
    task: 'Author a proposal',
    sessionPaths: { artifactPath },
    ballot: { sessionDir, round: 1 }
  });

  const [, ballotFields] = brief.match(/```json\n([\s\S]+?)\n```/);
  assert.deepEqual(JSON.parse(ballotFields), {
    sessionId: sessionDir,
    round: 1,
    voter: 'council-author',
    role: 'author',
    agent: 'codex'
  });
  assert.ok(brief.includes(artifactPath));
  assert.match(brief, /SHA-256 of the exact saved proposal bytes/);
});

test('formatCouncilReport collates findings and synthesis', () => {
  const report = formatCouncilReport({
    title: 'Test Council Report',
    mode: 'council',
    task: 'Sample task',
    participants: [
      { name: 'p1', role: 'author', agent: 'claude', status: 'completed' }
    ],
    findings: {
      p1: 'I propose design X.'
    },
    synthesis: 'Analysis of options.',
    verdict: 'Approved.'
  });

  assert.match(report, /# Test Council Report/);
  assert.match(report, /Mode: COUNCIL/i);
  assert.match(report, /I propose design X/);
  assert.match(report, /Analysis of options/);
  assert.match(report, /Approved/);
});
