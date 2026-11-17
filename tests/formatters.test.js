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
  assert.match(brief, /Reporting Contract/);
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
