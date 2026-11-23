// Reviewer-owned acceptance regressions (docs/independent-review.md, owner
// contracts in docs/owner-brief.md). Encodes the direct-only authorization
// decision as reproducible node:test cases over temp dirs: 18 orchestrator
// scenarios (council/review x 9), 6 delegate scenarios, the real `hc`
// wait payload shapes captured from the installed CLI, the `--children all`
// aggregate wait contract (owner gate: CLI exit 0 alone is not completion)
// and the 4 MCP tool surfaces (a failing herdr method must set isError,
// never print "Failed ..." as a positive tool result). Nothing here imports
// from .council/ and no real terminals are spawned (herdr is mocked).
// Red results on the implementer's WIP are expected; product code stays
// owned by the implementer — do not change lib/ to make these green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CouncilOrchestrator } from '../lib/modes.js';
import { AgentWorkspace } from '../lib/workspace.js';
import { HerdrClient } from '../lib/herdr.js';
import { CouncilMcpServer } from '../lib/mcp-server.js';

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
  ['done-turn0', REAL_WAIT_PAYLOADS.done, false],
  ['fresh-done', { ...REAL_WAIT_PAYLOADS.done, turn: 1 }, true],
  ['successful-process-exit', { ended: true, reason: 'exit', exit_code: 0, terminal: 't-fixture', turn: 1, children: [] }, true]
];

// hc wait --children all: the aggregate payload obeys the same wait contract
// as a single terminal — a CLI exit 0 carrying status timeout/message/blocked
// is NOT completion; success requires the children to be actually completed.
// Field names mirror the real captured wait shapes; the aggregate composition
// (aggregate status + children list) is modeled per the owner's gate.
const ALL_CHILDREN_CASES = [
  ['all-timeout', { ...REAL_WAIT_PAYLOADS.working, terminal: 'all', children: [{ ...REAL_WAIT_PAYLOADS.done, terminal: 't-child-1', turn: 1 }] }, false],
  ['all-message', { ...REAL_WAIT_PAYLOADS.done, reason: 'message', ended: false, terminal: 'all', children: [{ ...REAL_WAIT_PAYLOADS.done, terminal: 't-child-1', turn: 1 }] }, false],
  ['all-blocked', { ...REAL_WAIT_PAYLOADS.blocked, terminal: 'all', children: [{ ...REAL_WAIT_PAYLOADS.done, terminal: 't-child-1', turn: 1 }] }, false],
  ['all-children-completed', { ...REAL_WAIT_PAYLOADS.done, terminal: 'all', turn: 1, children: [{ ...REAL_WAIT_PAYLOADS.done, terminal: 't-child-1', turn: 1 }, { ...REAL_WAIT_PAYLOADS.done, terminal: 't-child-2', turn: 1 }] }, true]
];

async function withTempDir(run) {
  const tmp = resolve(mkdtempSync(join(tmpdir(), 'council-acceptance-')));
  const osTmp = resolve(tmpdir());
  try {
    return await run(tmp);
  } finally {
    // Windows policy: only ever rmSync a resolved path inside the OS temp dir.
    if (tmp.startsWith(osTmp) && tmp !== osTmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
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

// Real hc wait contracts as HerdrClient.wait outputs, per the owner's real event
// stream (.council/owner-review/hc-real-events.txt): status and turn are separate;
// hc wait blocks while working, so the first task stays at turn 0 and done lands
// at turn 1. A real timeout is a failure, so there is no synthetic middle timeout
// entry. Startup must be waited out, not failed; only a fresh done (turn >= 1)
// completes. Last entry repeats.
const STARTUP_WAIT_PLAN = [
  { success: false, ended: true, reason: 'status', status: 'idle', turn: 0, children: [] },
  { success: true, ended: true, reason: 'status', status: 'done', turn: 1 }
];
const MESSAGE_THEN_DONE_PLAN = [
  { success: false, ended: false, reason: 'message', status: 'working', turn: 0 },
  { success: true, ended: true, reason: 'status', status: 'done', turn: 1 }
];

// Herdr mock implementing the owner's orchestrator fixture semantics for one scenario.
// options.waitPlan feeds every target a sequence of wait results to model startup
// progression; get() then reports working at turn 0 so no false done can be read from it.
function orchestratorHerdr(cwd, mode, scenario, options = {}) {
  const { names, roles } = participants(mode);
  const marker = scenario === 'all-reject' ? 'reject' : 'approve';
  const waitPlan = options.waitPlan || null;
  const waitPolls = {};
  const firstWait = {};
  const lastWait = {};
  const cleanupBeforeDone = [];
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
      if (waitPlan) {
        return { success: true, details: { address: target, state: 'live', turn: 0, status: { state: 'working' } } };
      }
      return { success: true, details: { address: target, state: 'live', reported: true, turn: 1, status: { state: 'done' } } };
    },
    wait(target) {
      waitPolls[target] = (waitPolls[target] || 0) + 1;
      if (waitPlan) {
        const result = { terminal: target, ...waitPlan[Math.min(waitPolls[target] - 1, waitPlan.length - 1)] };
        if (waitPolls[target] === 1) firstWait[target] = result;
        lastWait[target] = result;
        return result;
      }
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
      if (waitPlan && lastWait[target] && lastWait[target].status !== 'done') cleanupBeforeDone.push(target);
      dismissed.push(target);
      return { success: true };
    }
  };
  return { herdr, launched, dismissed, waitPolls, firstWait, lastWait, cleanupBeforeDone };
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

// Provisional evidence contract: ONLY a markdown persisted under validation/
// counts (owner brief). result.report/nextActions in the response object do
// not satisfy persistence — saveFinalDeliverables must write the readable
// provisional report even when validationPassed is false.
function persistedValidationMarkdown(result) {
  const validationDir = result.sessionDir ? join(result.sessionDir, 'validation') : null;
  return markdownFilesUnder(validationDir).map(path => readFileSync(path, 'utf8')).join('\n');
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

        // Screen-only: informational evidence can never authorize a promotion,
        // and the outcome must be PERSISTED under validation/ (owner brief) —
        // the in-response report alone does not satisfy the contract.
        if (scenario === 'screen-only') {
          assert.equal(result.status, 'provisional', 'screen-only run must stay provisional');
          assert.equal(result.authorized, false, 'screen-only run must not be authorized');
          assert.equal(result.validation?.verdict, 'provisional', 'returned record must keep the provisional verdict');
          const evidence = persistedValidationMarkdown(result);
          assert.ok(evidence.trim().length > 0, 'the provisional outcome must be persisted as markdown under validation/ (result.report alone does not satisfy the brief)');
          assert.ok(evidence.includes('REVIEW_FINDING'), 'persisted screen evidence must be preserved as informational');
          assert.match(evidence, /cast[-_]ballot/, 'persisted outcome must contain the concrete cast-ballot action, not a generic next-steps header');
          assert.match(evidence, /provisional/i, 'persisted verdict must stay consistent with the returned record');
          assert.doesNotMatch(evidence, /VALIDATED by/i, 'mechanical tally must never be persisted as an agent sign-off');
          assert.match(evidence, /mechanical/i, 'persisted outcome must disclose mechanical aggregation (no agent synthesis turn)');
        }

        // Promotion only for the authorized outcomes.
        assert.equal(promotedReport(result.sessionDir), expected, 'report promotion must match authorized outcomes');
      });
    });
  }
}

// --- Delegate: 6 execution scenarios + startup timing

function delegateHerdr(scenario, options = {}) {
  const address = 't-fixture-specialist';
  const dismissed = [];
  const waitPlan = options.waitPlan || null;
  const waitPolls = {};
  const firstWait = {};
  const lastWait = {};
  const cleanupBeforeDone = [];
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
      if (waitPlan) {
        return { success: true, details: { address: target, state: 'live', turn: 0, status: { state: 'working' } } };
      }
      return { success: true, details: { address: target, state: 'live', turn: 1, status: { state: 'done' } } };
    },
    wait(target) {
      waitPolls[target] = (waitPolls[target] || 0) + 1;
      if (waitPlan) {
        const result = { target, ...waitPlan[Math.min(waitPolls[target] - 1, waitPlan.length - 1)] };
        if (waitPolls[target] === 1) firstWait[target] = result;
        lastWait[target] = result;
        return result;
      }
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
    captureTurn(target) { return this.read(target); },
    dismiss(target) {
      if (waitPlan && lastWait[target] && lastWait[target].status !== 'done') cleanupBeforeDone.push(target);
      dismissed.push(target);
      return { success: true };
    }
  };
  return { herdr, dismissed, waitPolls, firstWait, lastWait, cleanupBeforeDone, address };
}

for (const scenario of DELEGATE_SCENARIOS) {
  test(`acceptance: delegate/${scenario} honors execution and cleanup contract`, async () => {
    await withTempDir(async cwd => {
      const { herdr, dismissed, address } = delegateHerdr(scenario);
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

// --- Startup timing: a real agent starts idle at turn 0; failing on the first
// poll loses the work (proven live by the owner's Codex smoke test).

test('acceptance: council waits out agent startup (idle turn 0 -> working -> done) within the deadline', async () => {
  await withTempDir(async cwd => {
    const { herdr, waitPolls, firstWait, lastWait, cleanupBeforeDone } = orchestratorHerdr(cwd, 'council', 'healthy', { waitPlan: STARTUP_WAIT_PLAN });
    const result = await new CouncilOrchestrator({ cwd, herdr }).runMode({
      mode: 'council',
      task: 'Assess this exact proposal.',
      agents: ['codex', 'codex', 'codex'],
      timeoutSec: 15
    });
    assert.equal(result.success, true, `a startup reaching done must succeed (status: ${result.status})`);
    assert.ok(Object.keys(waitPolls).length > 0 && Math.min(...Object.values(waitPolls)) >= 2, 'orchestrator must poll wait again for the fresh done instead of failing on the first idle report');
    for (const target of Object.keys(firstWait)) {
      assert.equal(firstWait[target].success, false, 'raw wait at startup is incomplete');
      assert.equal(lastWait[target].status, 'done', 'the workflow must continue until wait reports done');
      assert.ok(lastWait[target].turn >= 1, 'completion must be a fresh done, not the stale done at turn 0');
    }
    assert.deepEqual(cleanupBeforeDone, [], 'no agent may be cleaned up before its wait reports done');
    assert.equal(promotedReport(result.sessionDir), true, 'the completed startup run promotes its report');
  });
});

test('acceptance: review waits out a message turn before done within the deadline', async () => {
  await withTempDir(async cwd => {
    const { herdr, waitPolls, firstWait, lastWait, cleanupBeforeDone } = orchestratorHerdr(cwd, 'review', 'healthy', { waitPlan: MESSAGE_THEN_DONE_PLAN });
    const result = await new CouncilOrchestrator({ cwd, herdr }).runMode({
      mode: 'review',
      task: 'Assess this exact proposal.',
      agents: ['codex', 'codex', 'codex'],
      timeoutSec: 15
    });
    assert.equal(result.success, true, `a message -> done startup must succeed (status: ${result.status})`);
    assert.ok(Object.keys(waitPolls).length > 0 && Math.min(...Object.values(waitPolls)) >= 2, 'orchestrator must poll wait again after a message event');
    for (const target of Object.keys(firstWait)) {
      assert.equal(firstWait[target].success, false, 'raw wait after a message event is still incomplete');
      assert.equal(lastWait[target].status, 'done', 'the workflow must continue until wait reports done');
      assert.ok(lastWait[target].turn >= 1, 'completion must be a fresh done, not the stale done at turn 0');
    }
    assert.deepEqual(cleanupBeforeDone, [], 'no agent may be cleaned up before its wait reports done');
  });
});

test('acceptance: delegate waits out agent startup (idle turn 0 -> working -> done) within the deadline', async () => {
  await withTempDir(async cwd => {
    const { herdr, dismissed, address, waitPolls, firstWait, lastWait, cleanupBeforeDone } = delegateHerdr('healthy', { waitPlan: STARTUP_WAIT_PLAN });
    const result = await new CouncilOrchestrator({ cwd, herdr }).runDelegate({
      agent: 'codex',
      task: 'Return the actual specialist result.',
      keepTerminals: false,
      timeoutSec: 15
    });
    assert.equal(result.success, true, `a delegate startup reaching done must succeed (status: ${result.status})`);
    assert.ok(Object.keys(waitPolls).length > 0 && Math.min(...Object.values(waitPolls)) >= 2, 'delegate must poll wait again for the fresh done instead of failing on the first idle report');
    for (const target of Object.keys(firstWait)) {
      assert.equal(firstWait[target].success, false, 'raw wait at startup is incomplete');
      assert.equal(lastWait[target].status, 'done', 'the delegate must continue until wait reports done');
      assert.ok(lastWait[target].turn >= 1, 'completion must be a fresh done, not the stale done at turn 0');
    }
    assert.deepEqual(cleanupBeforeDone, [], 'no agent may be cleaned up before its wait reports done');
    assert.deepEqual(dismissed, [address], 'delegate dismisses its own agent only after completion');
  });
});

// --- Real hc wait contract (HerdrClient.wait over captured payload shapes)

for (const [scenario, payload, expected] of WAIT_CASES) {
  test(`acceptance: hc wait ${scenario} -> success ${expected}`, () => {
    const client = new HerdrClient();
    client.exec = () => ({ success: true, code: 0, stdout: typeof payload === 'string' ? payload : JSON.stringify(payload), stderr: '' });
    const result = client.wait('t-fixture', { timeoutSec: 1 });
    assert.equal(result.success, expected, `wait must resolve success=${expected} (reason: ${result.reason}, status: ${result.status})`);
  });
}

// --- hc wait --children all (owner gate: waitAllChildren must not treat a
// CLI exit 0 as completion; the aggregate payload obeys the wait contract)

for (const [scenario, payload, expected] of ALL_CHILDREN_CASES) {
  test(`acceptance: hc wait --children all ${scenario} -> success ${expected}`, () => {
    const client = new HerdrClient();
    client.exec = () => ({ success: true, code: 0, stdout: JSON.stringify(payload), stderr: '' });
    const result = client.waitAllChildren({ timeoutSec: 1 });
    assert.equal(result.success, expected, `waitAllChildren must resolve success=${expected} (status: ${result.details?.status}, reason: ${result.details?.reason})`);
  });
}

// --- MCP public surfaces: a failing herdr method must surface isError, never
// a positive tool result that merely prints "Failed ..." (owner gate)

const MCP_FAILURE_CASES = [
  ['council_wait', 'wait', { target: 't-fixture' }, { success: false, target: 't-fixture', output: '', error: 'Turn timed out for t-fixture' }],
  ['council_read', 'read', { target: 't-fixture' }, { success: false, target: 't-fixture', content: '', error: 'Read failed with stale content.' }],
  ['council_send', 'send', { target: 't-fixture', message: 'hello' }, { success: false, target: 't-fixture', output: '', error: 'Send failed: unreachable terminal' }],
  ['council_dismiss', 'dismiss', { target: 't-fixture' }, { success: false, target: 't-fixture', killOutput: 'kill failed', rmOutput: 'rm failed' }]
];

for (const [tool, method, args, failure] of MCP_FAILURE_CASES) {
  test(`acceptance: MCP ${tool} marks a failing herdr ${method} as isError`, async () => {
    const server = new CouncilMcpServer({ cwd: tmpdir() });
    const responses = [];
    server.send = response => responses.push(response);
    let calls = 0;
    server.herdr[method] = () => { calls += 1; return failure; };
    await server.handleMessage({ id: 7, method: 'tools/call', params: { name: tool, arguments: args } });
    assert.equal(calls, 1, 'the tool must call the herdr method exactly once');
    const envelope = responses[0];
    assert.ok(envelope && envelope.result, 'the server must answer with a result envelope, not a protocol error');
    assert.ok(!envelope.error, 'a tool-level failure is signaled via isError, not a JSON-RPC error');
    assert.equal(envelope.result.isError, true, 'a failing herdr method must surface isError: true, not a positive tool result');
  });
}
