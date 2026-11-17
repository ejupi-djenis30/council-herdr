// Reviewer-owned acceptance regressions (docs/independent-review.md, owner
// contracts in docs/owner-brief.md). Encodes the direct-only authorization
// decision as reproducible node:test cases over temp dirs: 18 orchestrator
// scenarios (council/review x 9), 6 delegate scenarios and the real `hc`
// wait payload shapes captured from the installed CLI. Nothing here imports
// from .council/ and no real terminals are spawned (herdr is mocked).
// Red results on the implementer's WIP are expected; product code stays
// owned by the implementer — do not change lib/ to make these green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CouncilOrchestrator } from '../lib/modes.js';
import { AgentWorkspace } from '../lib/workspace.js';
import { HerdrClient } from '../lib/herdr.js';

const DIRECT_PROPOSAL = 'DIRECT_PROPOSAL_42\n[VOTE: approve] [SCORE: 9] [RATIONALE: exact proposal satisfies the task]\n';
const ORCHESTRATOR_SCENARIOS = [
  'healthy', 'reviewer-timeout', 'author-read-failed', 'no-votes', 'all-reject',
  'direct-proposal', 'missing-address', 'delivery-not-sent', 'screen-only'
];
const DELEGATE_SCENARIOS = ['healthy', 'timeout', 'blocked', 'read-failed', 'missing-address', 'delivery-not-sent'];

// Real `hc wait` payload shapes captured from the installed CLI.
const REAL_WAIT_PAYLOADS = {
  idle: { children: [], ended: true, exit_code: null, reason: 'status', signal: null, status: 'idle', terminal: 't-fixture', turn: 0 },
  blocked: { children: [], ended: true, exit_code: null, reason: 'status', signal: null, status: 'blocked', terminal: 't-fixture', turn: 0 },
  working: { children: [], ended: false, exit_code: null, reason: 'timeout', signal: null, status: 'working', terminal: 't-fixture', turn: 0 },
  done: { children: [], ended: true, exit_code: null, reason: 'status', signal: null, status: 'done', terminal: 't-fixture', turn: 0 }
};

// Real hc wait contract: only unambiguous completion counts as success.
const WAIT_CASES = [
  ['startup-idle', REAL_WAIT_PAYLOADS.idle, false],
  ['blocked', REAL_WAIT_PAYLOADS.blocked, false],
  ['working-timeout', REAL_WAIT_PAYLOADS.working, false],
  ['message-with-stale-done', { ...REAL_WAIT_PAYLOADS.done, reason: 'message', ended: false }, false],
  ['unknown-payload', { something: 'unexpected' }, false],
  ['malformed-json', 'not-json', false],
  ['fresh-done', { ...REAL_WAIT_PAYLOADS.done, turn: 1 }, true],
  ['successful-process-exit', { ended: true, reason: 'exit', exit_code: 0, terminal: 't-fixture', turn: 1, children: [] }, true]
];

async function withTempDir(run) {
  const tmp = mkdtempSync(join(tmpdir(), 'council-acceptance-'));
  try {
    return await run(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function participants(mode) {
  return mode === 'council'
    ? { names: ['council-author', 'council-skeptic', 'council-simplifier'], roles: ['author', 'skeptic', 'simplifier'] }
    : { names: ['review-author', 'review-reviewer', 'review-simplifier'], roles: ['author', 'reviewer', 'simplifier'] };
}

function screenTextFor(scenario, index, marker) {
  if (scenario === 'no-votes') return 'No explicit ballot was submitted.';
  return `${index === 0 ? 'SCREEN_PROPOSAL' : 'REVIEW_FINDING'}\n[VOTE: ${marker}] [SCORE: 9] [RATIONALE: exact proposal was inspected]`;
}

// Herdr mock implementing the owner's orchestrator fixture semantics for one scenario.
function orchestratorHerdr(cwd, mode, scenario) {
  const { names, roles } = participants(mode);
  const marker = scenario === 'all-reject' ? 'reject' : 'approve';
  const launched = [];
  const dismissed = [];
  const locate = target => launched.find(record => record.address === target || record.opts.name === target);
  const herdr = {
    launchAgent(opts) {
      const address = `t${2000 + launched.length}`;
      const index = launched.length;
      launched.push({ address, opts, index });
      if (scenario === 'direct-proposal' && index === 0) {
        const phase = mode === 'council' ? 'draft' : 'proposal';
        mkdirSync(join(opts.sessionDir, 'artifacts', phase, `${mode}-author`), { recursive: true });
        writeFileSync(join(opts.sessionDir, 'artifacts', phase, `${mode}-author`, 'artifact.md'), DIRECT_PROPOSAL);
      }
      if (scenario !== 'no-votes' && scenario !== 'screen-only') {
        const workspace = new AgentWorkspace(cwd);
        workspace.castBallot(opts.sessionDir, {
          round: 1,
          voter: names[index],
          role: roles[index],
          agent: 'codex',
          vote: marker,
          score: 9,
          rationale: 'Direct submission for this exact proposal.',
          targetArtifactSha256: workspace.sha256(scenario === 'direct-proposal' ? DIRECT_PROPOSAL : screenTextFor(scenario, 0, marker)),
          source: 'direct'
        });
      }
      return {
        success: true,
        name: opts.name,
        ...(scenario === 'missing-address' ? {} : { address }),
        details: {
          ...(scenario === 'missing-address' ? {} : { address }),
          turn: 0,
          first_message: { sent: scenario !== 'delivery-not-sent' }
        }
      };
    },
    get(target) {
      return { success: true, details: { address: target, state: 'live', reported: true, turn: 1, status: { state: 'done' } } };
    },
    wait(target) {
      const record = locate(target);
      if (scenario === 'reviewer-timeout' && record && record.index > 0) {
        return { success: false, isTimeout: true, ended: false, status: 'working', reason: 'timeout', turn: 0, terminal: target, error: 'Reviewer still working.' };
      }
      return { success: true, ended: true, status: 'done', reason: 'status', turn: 1, terminal: target };
    },
    read(target) {
      const record = locate(target);
      const content = screenTextFor(scenario, record ? record.index : 0, marker);
      return {
        success: !(scenario === 'author-read-failed' && record && record.index === 0),
        content,
        error: 'Read failure with stale content.'
      };
    },
    dismiss(target) {
      dismissed.push(target);
      return { success: true };
    }
  };
  return { herdr, launched, dismissed };
}

function promotedReport(sessionDir) {
  return Boolean(sessionDir) && existsSync(join(sessionDir, 'reports', 'report.md'));
}

function markdownFilesUnder(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter(name => name.endsWith('.md'))
    .map(name => join(dir, name))
    .filter(path => existsSync(path));
}

// Readable provisional evidence: result.report or any markdown under validation/.
function provisionalEvidence(result) {
  const parts = [];
  if (typeof result.report === 'string') parts.push(result.report);
  if (result.sessionDir) {
    for (const file of markdownFilesUnder(join(result.sessionDir, 'validation'))) {
      parts.push(readFileSync(file, 'utf8'));
    }
  }
  return parts.join('\n');
}

// --- Orchestrator: 18 direct-only authorization scenarios (council/review x 9)

for (const mode of ['council', 'review']) {
  for (const scenario of ORCHESTRATOR_SCENARIOS) {
    test(`acceptance: ${mode}/${scenario} honors direct-only authorization`, async () => {
      await withTempDir(async cwd => {
        const { herdr, launched, dismissed } = orchestratorHerdr(cwd, mode, scenario);
        const result = await new CouncilOrchestrator({ cwd, herdr }).runMode({
          mode,
          task: 'Assess this exact proposal.',
          agents: ['codex', 'codex', 'codex']
        });
        const expected = scenario === 'healthy' || scenario === 'direct-proposal';
        assert.equal(result.success, expected, `success must be ${expected} (status: ${result.status})`);

        // Failed agents are preserved, never dismissed.
        const failedAddresses = scenario === 'reviewer-timeout' ? launched.slice(1).map(record => record.address) : [];
        for (const address of failedAddresses) {
          assert.ok(!dismissed.includes(address), `failed agent ${address} must not be dismissed`);
        }

        // Direct proposal: handoff and findings carry the exact direct text.
        if (scenario === 'direct-proposal') {
          for (const record of launched.slice(1)) {
            assert.ok(record.opts.task.includes('DIRECT_PROPOSAL_42'), 'reviewer handoff must carry the direct proposal');
            assert.ok(!record.opts.task.includes('SCREEN_PROPOSAL'), 'reviewer handoff must not fall back to screen text');
          }
          assert.equal(result.findings?.[`${mode}-author`], DIRECT_PROPOSAL, 'findings must keep the full direct proposal, newlines included');
        }

        // Screen-only: informational evidence can never authorize a promotion.
        if (scenario === 'screen-only') {
          assert.equal(result.status, 'provisional', 'screen-only run must stay provisional');
          assert.equal(result.authorized, false, 'screen-only run must not be authorized');
          assert.notEqual(result.validation?.verdict, 'validated', 'screen evidence must not manufacture a validated verdict');
          const evidence = provisionalEvidence(result);
          assert.match(evidence, /next/i, 'provisional outcome must include next actions');
          assert.ok(evidence.includes('REVIEW_FINDING'), 'screen evidence must be preserved as informational');
        }

        // Promotion only for the authorized outcomes.
        assert.equal(promotedReport(result.sessionDir), expected, 'report promotion must match authorized outcomes');
      });
    });
  }
}

// --- Delegate: 6 execution scenarios

for (const scenario of DELEGATE_SCENARIOS) {
  test(`acceptance: delegate/${scenario} honors execution and cleanup contract`, async () => {
    await withTempDir(async cwd => {
      const address = 't-fixture-specialist';
      const dismissed = [];
      const herdr = {
        launchAgent(opts) {
          return {
            success: true,
            name: opts.name,
            ...(scenario === 'missing-address' ? {} : { address }),
            details: {
              ...(scenario === 'missing-address' ? {} : { address }),
              turn: 0,
              first_message: { sent: scenario !== 'delivery-not-sent' }
            }
          };
        },
        get(target) {
          return { success: true, details: { address: target, state: 'live', turn: 1, status: { state: 'done' } } };
        },
        wait(target) {
          if (scenario === 'timeout' || scenario === 'blocked') {
            return {
              success: false,
              target,
              status: scenario === 'blocked' ? 'blocked' : 'working',
              ended: false,
              isBlocked: scenario === 'blocked',
              isTimeout: scenario === 'timeout',
              error: scenario
            };
          }
          return { success: true, target, ended: true, status: 'done', reason: 'status', turn: 1 };
        },
        read(target) {
          return {
            success: scenario !== 'read-failed',
            target,
            content: 'ACTUAL_SPECIALIST_RESULT=42',
            error: scenario === 'read-failed' ? 'Read failed with stale data.' : null
          };
        },
        dismiss(target) {
          dismissed.push(target);
          return { success: true };
        }
      };
      const result = await new CouncilOrchestrator({ cwd, herdr }).runDelegate({
        agent: 'codex',
        task: 'Return the actual specialist result.',
        keepTerminals: false
      });
      const expected = scenario === 'healthy';
      assert.equal(result.success, expected, `success must be ${expected} (status: ${result.status})`);
      assert.equal(promotedReport(result.sessionDir), expected, 'promotion must match the only success scenario');
      if (expected) {
        assert.deepEqual(dismissed, [address], 'healthy delegate dismisses exactly its own agent address');
      } else {
        assert.ok(!dismissed.includes(address), 'failed delegate must not dismiss the agent');
      }
    });
  });
}

// --- Real hc wait contract (HerdrClient.wait over captured payload shapes)

for (const [scenario, payload, expected] of WAIT_CASES) {
  test(`acceptance: hc wait ${scenario} -> success ${expected}`, () => {
    const client = new HerdrClient();
    client.exec = () => ({ success: true, code: 0, stdout: typeof payload === 'string' ? payload : JSON.stringify(payload), stderr: '' });
    const result = client.wait('t-fixture', { timeoutSec: 1 });
    assert.equal(result.success, expected, `wait must resolve success=${expected} (reason: ${result.reason}, status: ${result.status})`);
  });
}
