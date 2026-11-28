import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeEngine } from '../herdr/mods/council/machine-engine.js';
import { WorkItems, workItemActionEnabled, workItemScreenVisible } from '../herdr/mods/council/work-item-actions.js';

// Use the committed e43ae3d wire examples. The child process below implements a
// deterministic fixture protocol, with its own files in an isolated workspace.
const examples = JSON.parse(readFileSync(new URL('../specs/002-work-item-review/contracts/examples.json', import.meta.url)));
// Exact policy vectors from the shared implementation amendment. The spec PR
// owns integration of that amendment into the published contract.
const policyFixtures = JSON.parse(readFileSync(new URL('./fixtures/work-item-review-policy.json', import.meta.url)));
const id = examples.legacy.item.id;
const role = { id: 'verifier', role: 'Fixture verifier' };
const actor = { actor: 'Release lead' };
const makeScope = (project, machine = null, space = 'fixture-space', cli = '/mock/installed/bin/council.js') => ({
  project, anchor: project, space, engine: { machine, node: process.execPath, cli }
});
const local = makeScope(examples.legacy.project);
const peer = makeScope('D:\\Shared workspace\\Other project', 'fixture-peer', 'peer-space');
const wire = (record, project) => ({ code: record.success ? 0 : 1, stdout: JSON.stringify({ ...record, project }), stderr: '' });
const summarize = ({ result, criteria, lifecycle, ...item }) => {
  const { review, decision, integrity, actions, ...summary } = lifecycle;
  return { ...item, lifecycle: summary };
};
const queue = (...items) => ({ success: true, items: items.map(summarize), errors: [] });
const receipt = (requestId, revision, event = 'triaged', replay = false) => ({ requestId, event, revision, replay });
const hashTuple = tuple => createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function harness(answer, team = async project => ({ members: [project === peer.project ? { ...role, role: 'Peer-only verifier' } : role] })) {
  const calls = [];
  let active;
  const focus = scope => { active = { space: { id: scope.space, machine: scope.engine.machine }, workspaceActive: true, target: scope.anchor }; };
  focus(local);
  const work = new WorkItems({
    lifecycle: true,
    visible: screen => workItemScreenVisible(screen, active),
    runCli: (cwd, args, engine) => executeEngine(async (program, argv, options) => {
      const call = { program, argv, ...options };
      calls.push(call);
      return answer(argv.slice(1), call);
    }, engine, 'cli', args, cwd, 30_000),
    readTeam: (cwd, engine) => {
      calls.push({ cwd, on: engine.machine, team: true });
      return team(cwd, engine);
    }
  });
  return { work, focus, calls };
}

const verb = argv => argv?.slice(1, 3).filter(value => !value.startsWith('--')).join(' ');
const submitted = argv => JSON.parse(argv[argv.indexOf('--input-json') + 1]);

test('queue filters stay on the selected machine and a late read cannot replace a newer selection', async () => {
  const first = deferred();
  const { work, focus, calls } = harness((args, call) => args.includes('--needs-attention')
    ? first.promise : wire(examples.list, call.cwd));
  await work.showList(local);
  const previous = work.current;
  const filter = work.filter(previous, { roleId: 'verifier', state: 'in_review', attention: true });
  const obsolete = work.current;
  focus(peer);
  await work.showList(peer);
  const current = work.current;
  first.resolve(wire(queue(examples.formalRejected.item), local.project));
  await filter;
  assert.equal(work.current, current);
  assert.equal(obsolete.items, undefined);
  assert.equal(current.roles[0].role, 'Peer-only verifier');
  assert.deepEqual(calls.find(call => call.argv?.includes('--needs-attention')), {
    program: process.execPath,
    argv: [local.engine.cli, 'work-item', 'list', '--sort', 'priority', '--role', 'verifier', '--state', 'in_review', '--needs-attention'],
    cwd: local.project, on: null, timeout: 30_000
  });
  assert.equal(calls.find(call => call.on === 'fixture-peer' && call.argv).cwd, peer.project);
  focus(local);
  await work.showList(local);
  assert.deepEqual(work.current.filters, { roleId: 'verifier', state: 'in_review', attention: true });
  await work.filter(work.current, {});
  assert.deepEqual(work.current.filters, {});
});

test('a compatible v1 engine remains readable and must never receive a legacy delegation from Workspace', async () => {
  const legacy = structuredClone(examples.legacy);
  delete legacy.item.lifecycle;
  const { work, calls } = harness((args, call) => {
    if (args.includes('--sort')) return wire({ success: false, error: { code: 'invalid_input', message: 'Unknown list option.' } }, call.cwd);
    return wire(verb(args) === 'list' ? { success: true, items: [legacy.item], errors: [] } : legacy, call.cwd);
  });
  await work.showList();
  await work.showList(local);
  assert.equal(work.current.legacy, true);
  await work.open(work.current, id);
  await work.startMutation(work.current, 'delegate');
  await work.confirmMutation(work.current, actor);
  await work.delegate(work.current);
  assert.equal(work.current.form, undefined);
  assert.deepEqual(calls.filter(call => call.argv).map(call => call.argv[2]), ['list', 'list', 'show']);
});

test('a lost reply recovers the saved receipt and a current item through read-only requests on its original machine', async () => {
  const response = deferred();
  let payload;
  const { work, calls, focus } = harness((args, call) => {
    if (verb(args) === 'list') return wire(examples.list, call.cwd);
    if (verb(args) === 'triage') { payload = submitted(args); return response.promise; }
    if (verb(args) === 'history') return wire({ success: true, id, receipt: receipt(payload.requestId, 2) }, call.cwd);
    return wire(payload ? examples.triaged : examples.legacy, call.cwd);
  });
  focus(peer);
  await work.restore(peer, id);
  const screen = work.current;
  await work.startMutation(screen, 'triage');
  assert.equal(screen.form.roles[0].role, 'Peer-only verifier');
  work.selectMutation(screen, 'priority', 'high');
  const saving = work.confirmMutation(screen, { ...actor, title: screen.item.title, criteria: screen.item.criteria.join('\n'), nextAction: '' });
  focus(local);
  await work.showList(local);
  const newQueue = work.current;
  response.reject(new Error('transport acknowledgement lost'));
  await saving;
  assert.equal(work.current, newQueue);
  assert.equal(screen.item.lifecycle.revision, 1);
  const originalRead = calls.filter(call => call.argv && ['history', 'show'].includes(call.argv[2])).at(-2);
  assert.deepEqual(originalRead.argv, [peer.engine.cli, 'work-item', 'history', '--id', id, '--request-id', payload.requestId]);
  assert.equal(originalRead.cwd, peer.project);
  assert.equal(originalRead.on, peer.engine.machine);
  focus(peer);
  await work.restore(peer, id);
  assert.equal(work.current.item.lifecycle.revision, 2);
  assert.equal(work.current.receipt.requestId, payload.requestId);
  assert.equal(calls.filter(call => call.argv?.[2] === 'triage').length, 1);
});

test('successful off-screen writes retain a scoped receipt and require only Show on return', async t => {
  const scopes = [
    ['another project on the same machine', makeScope('D:\\Neighbor project', peer.engine.machine, peer.space)],
    ['the same path on another machine', makeScope(peer.project, 'other-peer', 'other-space')]
  ];
  for (const [name, other] of scopes) await t.test(name, async () => {
    const reply = deferred();
    let input;
    let committed = false;
    let showCaughtUp = false;
    const writes = [];
    const { work, calls, focus } = harness((args, call) => {
      if (verb(args) === 'close') {
        input = submitted(args);
        writes.push(call);
        return reply.promise;
      }
      if (verb(args) === 'history') throw new Error('History temporarily unavailable');
      if (committed && showCaughtUp && call.cwd === peer.project && call.on === peer.engine.machine) {
        return wire(examples.closed, call.cwd);
      }
      return wire(examples.inReview, call.cwd);
    });
    focus(peer);
    await work.restore(peer, id);
    const original = work.current;
    await work.startMutation(original, 'close');
    const closing = work.confirmMutation(original, { ...actor, reason: 'Reviewed current criteria.', nextAction: 'Publish.' });
    focus(other);
    await work.restore(other, id);
    const otherScreen = work.current;
    const known = receipt(input.requestId, 5, 'closed');
    committed = true;
    reply.resolve(wire({ ...examples.closed, receipt: known }, peer.project));
    await closing;
    assert.equal(work.current, otherScreen);
    assert.equal(otherScreen.item.lifecycle.revision, 4);
    assert.equal(otherScreen.receipt, undefined);
    assert.equal(work.mutation(otherScreen), undefined);
    assert.equal(original.item.lifecycle.revision, 4);
    assert.deepEqual(work.mutation(original)?.receipt, known);

    focus(peer);
    const startOfRecovery = calls.length;
    await work.restore(peer, id);
    assert.equal(work.current.item.lifecycle.revision, 4);
    assert.deepEqual(work.mutation(work.current)?.receipt, known);
    assert.equal(work.mutation(work.current)?.phase, 'unresolved');
    await work.replayMutation(work.current);
    showCaughtUp = true;
    await work.refresh(work.current);
    assert.equal(work.current.item.lifecycle.state, 'closed');
    assert.deepEqual(work.current.receipt, known);
    assert.equal(work.mutation(work.current), undefined);
    assert.deepEqual(calls.slice(startOfRecovery).map(call => [call.argv.slice(1), call.cwd, call.on]), [
      [['work-item', 'show', '--id', id], peer.project, peer.engine.machine],
      [['work-item', 'show', '--id', id], peer.project, peer.engine.machine]
    ]);
    assert.deepEqual(writes.map(call => [call.cwd, call.on]), [[peer.project, peer.engine.machine]]);
  });
});

test('an absent receipt permits only explicitly replaying the same v2 delegation argv', async () => {
  const sends = [];
  const { work } = harness((args, call) => {
    if (verb(args) === 'delegate') {
      sends.push(args);
      throw new Error('process reply lost');
    }
    if (verb(args) === 'history') return wire({ success: true, id, receipt: null }, call.cwd);
    return wire(examples.triaged, call.cwd);
  });
  await work.restore(local, id);
  const screen = work.current;
  await work.startMutation(screen, 'delegate');
  await work.confirmMutation(screen, actor);
  const attempt = work.mutation(screen);
  assert.equal(attempt.phase, 'missing');
  await work.refresh(screen);
  await work.confirmMutation(screen, { actor: 'Different lead' });
  assert.deepEqual(sends, [['work-item', 'delegate', '--id', id, '--if-revision', '2', '--request-id',
    attempt.input.requestId, '--actor', actor.actor]]);
  await work.replayMutation(screen);
  assert.deepEqual(sends, [sends[0], sends[0]]);
});

test('new evidence at the same revision invalidates a submitted close and requires a new confirmation and request ID', async () => {
  let current = structuredClone(examples.inReview);
  const confirmations = [];
  const { work } = harness((args, call) => {
    if (verb(args) === 'close') {
      confirmations.push(submitted(args));
      if (confirmations.length === 1) {
        current.item.lifecycle.review.evidenceToken = 'c'.repeat(64);
        throw new Error('response lost while evidence changed');
      }
      return wire({ ...examples.closed, receipt: receipt(confirmations[1].requestId, 5, 'closed') }, call.cwd);
    }
    if (verb(args) === 'history') return wire({ success: true, id, receipt: null }, call.cwd);
    return wire(current, call.cwd);
  });
  await work.restore(local, id);
  const screen = work.current;
  await work.startMutation(screen, 'close');
  const fields = { ...actor, reason: examples.closeInput.reason, nextAction: examples.closeInput.nextAction };
  await work.confirmMutation(screen, fields);
  assert.equal(screen.form.stale, true);
  assert.equal(work.mutation(screen), undefined);
  await work.replayMutation(screen);
  await work.confirmMutation(screen, fields);
  assert.equal(confirmations.length, 1);
  await work.startMutation(screen, 'close');
  await work.confirmMutation(screen, fields);
  assert.equal(confirmations.length, 2);
  assert.notEqual(confirmations[0].requestId, confirmations[1].requestId);
  assert.equal(confirmations[1].evidenceToken, 'c'.repeat(64));
  assert.equal(screen.item.lifecycle.state, 'closed');
});

test('formal rejection or provisional evidence cannot accept, and a verified formal and archived link stays scoped', async () => {
  const original = structuredClone(examples.formalProvisional);
  original.item.lifecycle.actions.close = true; // A contradictory permission flag is insufficient.
  const { work, focus, calls } = harness((args, call) => {
    if (args.includes('--review-id')) return wire(examples.archivedReview, call.cwd);
    return wire(args.at(-1) === id ? examples.reopened : original, call.cwd);
  });
  focus(peer);
  await work.restore(peer, original.item.id);
  await work.startMutation(work.current, 'close');
  assert.equal(work.current.form, undefined);
  assert.equal(workItemActionEnabled(examples.formalRejected.item, 'close'), false);
  assert.equal(workItemActionEnabled(examples.inReview.item, 'close'), true);
  assert.deepEqual(work.formalLink(work.current), {
    tab: 'reviews', id: 'review-release-notes', project: peer.project, machine: peer.engine.machine
  });
  const obsolete = work.current;
  await work.restore(peer, id, examples.archivedReview.archivedReview.id);
  assert.equal(work.formalLink(obsolete), null);
  assert.equal(work.current.archived.review.capture.output, examples.inReview.item.result.output);
  assert.deepEqual(calls.at(-1).argv.slice(1), ['work-item', 'show', '--id', id, '--review-id', 'review-4']);
  assert.equal(calls.at(-1).cwd, peer.project);
  assert.equal(work.sessionLink(work.current, 'reviews', '../another-project'), null);
});

function approvedFormal() {
  const record = structuredClone(examples.formalRejected);
  const lifecycle = record.item.lifecycle;
  lifecycle.formalRequired = true;
  lifecycle.reviewState = 'approved';
  lifecycle.actions.close = true;
  Object.assign(lifecycle.review.formal, { state: 'approved', verdict: 'validated' });
  lifecycle.review.evidenceToken = hashTuple([lifecycle.review.snapshotSha256, 'approved', lifecycle.review.formal.manifestSha256]);
  return record;
}

test('only current formal approval with a verified, coherent binding may enable or submit Close', async t => {
  const invalidReferences = {
    'all references absent': (_, review) => Object.assign(review.formal, {
      sessionId: null, round: null, proposalSha256: null, manifestSha256: null
    }),
    'session path is unsafe': (_, review) => { review.formal.sessionId = '../review'; },
    'session ID is not canonical': (_, review) => { review.formal.sessionId = 'con-review'; },
    'round is missing': (_, review) => { review.formal.round = null; },
    'proposal digest is malformed': (_, review) => { review.formal.proposalSha256 = 'not-a-digest'; },
    'manifest changed without a new evidence token': (_, review) => { review.formal.manifestSha256 = 'f'.repeat(64); },
    'approved projection contradicts the verdict': (_, review) => { review.formal.verdict = 'rejected'; },
    'lifecycle projection contradicts approval': item => { item.lifecycle.reviewState = 'provisional'; },
    'review is from a different cycle': (_, review) => { review.cycle++; },
    'capture is unverified': (_, review) => { review.capture.verified = false; },
    'the current attempt is different': item => { item.job.sessionId = 'another-attempt'; },
    'snapshot does not bind the frozen definition': (_, review) => {
      review.snapshotSha256 = 'a'.repeat(64);
      review.evidenceToken = hashTuple([review.snapshotSha256, 'approved', review.formal.manifestSha256]);
    }
  };
  for (const [name, damage] of Object.entries(invalidReferences)) await t.test(name, async () => {
    const damaged = approvedFormal();
    damage(damaged.item, damaged.item.lifecycle.review);
    let projection = approvedFormal();
    const { work, calls } = harness((_args, call) => wire(projection, call.cwd));
    const targetId = damaged.item.id;
    await work.restore(local, targetId);
    const screen = work.current;
    await work.startMutation(screen, 'close');
    assert.equal(screen.form?.operation, 'close');
    projection = damaged;
    // Obsolete confirmations must not send after a newer projection arrives.
    await work.refresh(screen);
    await work.confirmMutation(screen, { ...actor, reason: 'Reviewed.', nextAction: 'Publish.' });
    await work.restore(local, targetId);
    assert.equal(workItemActionEnabled(work.current.item, 'close'), false);
    await work.startMutation(work.current, 'close');
    assert.equal(work.current.form, undefined);
    assert.ok(calls.every(call => call.argv?.[2] === 'show'));
  });

  const approved = approvedFormal();
  const submittedClose = [];
  const { work } = harness((args, call) => {
    if (verb(args) !== 'close') return wire(approved, call.cwd);
    const input = submitted(args);
    submittedClose.push(input);
    const closed = structuredClone(approved);
    Object.assign(closed.item.lifecycle, { state: 'closed', revision: 6 });
    return wire({ ...closed, receipt: receipt(input.requestId, 6, 'closed') }, call.cwd);
  });
  await work.restore(local, approved.item.id);
  await work.startMutation(work.current, 'close');
  await work.confirmMutation(work.current, { ...actor, reason: 'Reviewed.', nextAction: 'Publish.' });
  assert.equal(work.current.item.lifecycle.state, 'closed');
  assert.equal(submittedClose.length, 1);
  assert.equal(submittedClose[0].reviewId, approved.item.lifecycle.review.id);
  assert.equal(submittedClose[0].evidenceToken, approved.item.lifecycle.review.evidenceToken);
});

function policyCase({ base, lifecycleOverride, omitLifecycleFields }) {
  const projection = structuredClone(policyFixtures[base] ?? examples[base]);
  Object.assign(projection.item.lifecycle, lifecycleOverride);
  for (const field of omitLifecycleFields) delete projection.item.lifecycle[field];
  return projection;
}

test('the shared policy fixtures resolve Start review using an explicit true, false or absent flag', async t => {
  for (const fixture of policyFixtures.reviewPolicyCases) await t.test(fixture.name, async () => {
    const projection = policyCase(fixture);
    const { lifecycle } = projection.item;
    const writes = [];
    const { work, focus, calls } = harness((args, call) => {
      if (verb(args) !== 'review start') return wire(projection, call.cwd);
      const input = submitted(args);
      writes.push(input);
      const revision = input.ifRevision + 1;
      const started = structuredClone(projection);
      started.item.lifecycle.revision = revision;
      return wire({ ...started, receipt: receipt(input.requestId, revision, 'review_started') }, call.cwd);
    });
    if (fixture.name === 'required-after-return-before-attach') {
      assert.equal(lifecycle.cycle, 2);
      assert.equal(lifecycle.decision.disposition, 'changes_requested');
      assert.equal(lifecycle.decision.formal, null);
    }
    focus(peer);
    await work.restore(peer, projection.item.id);
    const screen = work.current;
    await work.startMutation(screen, 'start');
    assert.equal(screen.form.policyUnknown, lifecycle.formalRequired === undefined);
    assert.deepEqual(screen.form.formalRequired ? ['formal'] : ['operator', 'formal'], fixture.allowedPolicies);
    work.selectMutation(screen, 'roleId', 'verifier');
    work.selectMutation(screen, 'policy', 'operator');
    if (fixture.allowedPolicies.length === 1) {
      assert.equal(screen.form.policy, 'formal');
      screen.form.policy = 'operator';
      await work.confirmMutation(screen, actor);
      assert.match(screen.error, /requires formal review/);
      assert.equal(writes.length, 0);
      work.selectMutation(screen, 'policy', 'formal');
    }
    await work.confirmMutation(screen, actor);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].policy, fixture.allowedPolicies[0]);
    assert.ok(calls.every(call => call.cwd === peer.project && call.on === peer.engine.machine));
  });
});

test('an operator confirmation becomes stale if the current detail requires formal review or omits the requirement', async t => {
  for (const value of [true, undefined]) await t.test(String(value), async () => {
    let projection = policyCase(policyFixtures.reviewPolicyCases.find(fixture => fixture.name === 'explicitly-optional'));
    const { work, calls } = harness((_args, call) => wire(projection, call.cwd));
    await work.restore(local, id);
    const screen = work.current;
    await work.startMutation(screen, 'start');
    work.selectMutation(screen, 'roleId', 'verifier');
    const original = screen.form;
    assert.equal(original.policy, 'operator');

    projection = structuredClone(projection);
    if (value === undefined) delete projection.item.lifecycle.formalRequired;
    else projection.item.lifecycle.formalRequired = value;
    await work.refresh(screen);
    assert.equal(original.stale, true);
    await work.confirmMutation(screen, actor);
    assert.ok(calls.every(call => call.team || call.argv[2] === 'show'));

    await work.startMutation(screen, 'start');
    assert.notEqual(screen.form, original);
    assert.equal(screen.form.policy, 'formal');
  });
});

test('attach and return use the frozen review, never interpret a rejected formal verdict as closure, and retain the selected project', async () => {
  const formalId = examples.formalRejected.item.id;
  const pending = structuredClone(examples.formalRejected);
  const lifecycle = pending.item.lifecycle;
  lifecycle.revision = 4;
  lifecycle.reviewState = 'pending';
  lifecycle.actions.attachFormal = true;
  Object.assign(lifecycle.review.formal, { state: 'pending', sessionId: null, round: null, verdict: null,
    proposalSha256: null, manifestSha256: null, dissent: [] });
  const callsToWrite = [];
  const { work, focus, calls } = harness((args, call) => {
    if (verb(args) === 'show') return wire(pending, call.cwd);
    const input = submitted(args);
    callsToWrite.push({ operation: args[2], input });
    if (args[2] === 'attach') return wire({ ...examples.formalRejected, receipt: receipt(input.requestId, 5, 'review_attached') }, call.cwd);
    const returned = structuredClone(examples.reopened);
    returned.item.id = formalId;
    returned.item.lifecycle.decision.disposition = 'changes_requested';
    returned.item.lifecycle.decision.formal = examples.formalRejected.item.lifecycle.review.formal;
    returned.receipt = receipt(input.requestId, 6, 'review_returned');
    return wire(returned, call.cwd);
  });
  focus(peer);
  await work.restore(peer, formalId);
  const screen = work.current;
  await work.startMutation(screen, 'attach');
  await work.confirmMutation(screen, { ...actor, formalSessionId: '../other-project', round: '1' });
  assert.match(screen.error, /session ID/);
  assert.equal(callsToWrite.length, 0);
  await work.confirmMutation(screen, { ...actor, formalSessionId: 'review-release-notes', round: '1' });
  assert.equal(screen.item.lifecycle.review.formal.state, 'rejected');
  assert.equal(workItemActionEnabled(screen.item, 'close'), false);
  await work.startMutation(screen, 'return');
  work.selectMutation(screen, 'roleId', 'verifier');
  await work.confirmMutation(screen, { ...actor, reason: 'A reviewer found an unclear instruction.', nextAction: 'Rewrite the upgrade step.' });
  assert.equal(screen.item.lifecycle.cycle, 2);
  assert.equal(screen.item.lifecycle.decision.disposition, 'changes_requested');
  assert.equal(screen.item.job, null);
  assert.deepEqual(callsToWrite.map(({ operation, input }) => [operation, input.reviewId, input.ifRevision, input.evidenceToken]), [
    ['attach', 'review-4', 4, undefined],
    ['return', 'review-4', 5, examples.formalRejected.item.lifecycle.review.evidenceToken]
  ]);
  assert.ok(calls.every(call => call.cwd === peer.project && call.on === peer.engine.machine));
});

test('a stale revision rejection with a failed read requires a successful refresh before a fresh confirmation', async () => {
  let afterRejection = false;
  let available = false;
  const { work, calls } = harness((args, call) => {
    if (verb(args) === 'delegate') {
      afterRejection = true;
      return wire(examples.conflict, call.cwd);
    }
    if (verb(args) === 'history') return wire({ success: true, id, receipt: null }, call.cwd);
    if (afterRejection && !available) throw new Error('temporarily disconnected');
    return wire(available ? examples.reopened : examples.triaged, call.cwd);
  });
  await work.restore(local, id);
  const screen = work.current;
  await work.startMutation(screen, 'delegate');
  const oldForm = screen.form;
  await work.confirmMutation(screen, actor);
  assert.equal(oldForm.stale, true);
  assert.equal(screen.staleRead, true);
  await work.startMutation(screen, 'delegate');
  assert.equal(screen.form, oldForm);
  await work.replayMutation(screen);
  assert.equal(calls.filter(call => call.argv?.[2] === 'delegate').length, 1);
  available = true;
  await work.refresh(screen);
  await work.startMutation(screen, 'delegate');
  assert.notEqual(screen.form, oldForm);
  assert.equal(screen.form.item.lifecycle.revision, 6);
});

const engineScript = String.raw`
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [noun, action, ...args] = process.argv.slice(2);
assert.equal(noun, 'work-item');
const project = process.cwd();
const file = 'fixture.json';
const state = JSON.parse(fs.readFileSync(file));
const get = option => args.includes(option) ? args[args.indexOf(option) + 1] : null;
const result = body => console.log(JSON.stringify({ success: true, project, ...body }));
const summary = ({ result, criteria, lifecycle, ...item }) => {
  const { actions, review, integrity, decision, ...rest } = lifecycle;
  return { ...item, lifecycle: rest };
};
const priorities = ['none', 'low', 'medium', 'high', 'urgent'];
fs.appendFileSync('calls.jsonl', JSON.stringify({ action, args }) + '\n');
if (action === 'list') {
  assert.equal(get('--sort'), 'priority');
  const items = [state.item, ...state.other].filter(item =>
    (!get('--role') || item.roleId === get('--role')) &&
    (!get('--state') || item.lifecycle.state === get('--state')) &&
    (!args.includes('--needs-attention') || item.lifecycle.needsAttention));
  items.sort((a, b) => priorities.indexOf(b.lifecycle.priority) - priorities.indexOf(a.lifecycle.priority) ||
    b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const malformed = { ...summary(state.other[0]), id: 'wi-malformed', lifecycle: { revision: -1 } };
  result({ items: [...items.map(summary), malformed], errors: [{ id: 'wi-unreadable', code: 'integrity_error', message: 'Missing row.' }] });
} else if (action === 'show') {
  const item = [state.item, ...state.other].find(item => item.id === get('--id'));
  assert.ok(item);
  result({ item, ...(get('--review-id') ? { archivedReview: state.archived } : {}) });
} else if (action === 'history') {
  assert.equal(get('--id'), state.item.id);
  if (get('--request-id')) result({ id: state.item.id, receipt: state.receipts[get('--request-id')] ?? null });
  else {
    const events = state.events.filter(event => !get('--before') || event.revision < Number(get('--before')));
    result({ id: state.item.id, events: events.slice(0, 2),
      nextBeforeRevision: events.length > 2 ? events[1].revision : null, integrity: null });
  }
} else {
  const op = action === 'review' ? args[0] : action;
  const input = action === 'delegate' ? { id: get('--id'), ifRevision: Number(get('--if-revision')),
    actor: get('--actor'), requestId: get('--request-id') } : JSON.parse(get('--input-json'));
  assert.equal(input.id, state.item.id);
  assert.equal(input.ifRevision, state.item.lifecycle.revision);
  assert.equal(input.actor, 'Release lead');
  assert.match(input.requestId, /^[a-z0-9][a-z0-9-]{0,63}$/);
  const revision = input.ifRevision + 1;
  const item = state.item;
  const lifecycle = item.lifecycle;
  if (op === 'triage') {
    if (input.patch.priority) lifecycle.priority = input.patch.priority;
    if (input.patch.nextAction) lifecycle.nextAction = input.patch.nextAction;
    if (input.patch.blockedBy) lifecycle.blockedBy = input.patch.blockedBy.map(id => {
        const target = state.other.find(item => item.id === id);
        return { id, title: target.title, state: target.lifecycle.state };
    });
  } else if (op === 'delegate') {
    assert.equal(item.roleId, 'verifier');
    Object.assign(item, { state: 'result_ready', result: state.candidate.result, canDelegate: false, job: state.candidate.job });
    lifecycle.guidance = 'Freeze the saved handoff for review.';
    Object.assign(lifecycle.actions, { editDefinition: false, delegate: false, startReview: true });
  } else if (op === 'start') {
    assert.equal(input.reviewOwnerRoleId, 'verifier');
    assert.equal(input.policy, 'operator');
    Object.assign(lifecycle, { state: 'in_review', reviewState: 'operator', review: state.candidate.lifecycle.review,
      guidance: state.candidate.lifecycle.guidance,
      actions: state.candidate.lifecycle.actions });
  } else if (op === 'note') {
    assert.equal(input.reviewId, lifecycle.review.id);
    assert.equal(input.kind, 'dissent');
    lifecycle.review.notes.push({ kind: input.kind, actor: input.actor, text: input.text,
      at: '2026-11-28T09:06:00.000Z', revision });
  } else if (op === 'close') {
    assert.equal(input.reviewId, lifecycle.review.id);
    assert.equal(input.evidenceToken, lifecycle.review.evidenceToken);
    assert.equal(input.decision, 'accept');
    Object.assign(lifecycle, { state: 'closed', nextAction: input.nextAction, actions: state.closed.actions, guidance: state.closed.guidance,
      decision: { ...state.closed.decision, id: 'decision-' + revision, actor: input.actor, reason: input.reason,
        nextAction: input.nextAction } });
  } else if (op === 'reopen') {
    assert.equal(input.decisionId, lifecycle.decision.id);
    assert.equal(input.snapshotSha256, lifecycle.decision.snapshotSha256);
    assert.equal(input.roleId, 'verifier');
    state.archived = lifecycle.review;
    Object.assign(item, { state: 'draft', result: null, job: null });
    Object.assign(lifecycle, { state: 'open', review: null, reviewState: null, cycle: 2, workRevision: 2, guidance: state.reopened.guidance,
      nextAction: input.nextAction, actions: state.reopened.actions });
  } else assert.fail('Unexpected fixture operation ' + op);
  lifecycle.revision = revision;
  const receipt = { requestId: input.requestId, event: op, revision, replay: false };
  const references = [lifecycle.review?.id ?? lifecycle.decision?.reviewId, lifecycle.decision?.id, item.job?.sessionId];
  state.events.unshift({ revision, actor: input.actor, type: op, at: '2026-11-28T09:06:00.000Z',
    requestId: input.requestId, cycle: lifecycle.cycle, workRevision: lifecycle.workRevision,
    references: Object.fromEntries(['reviewId', 'decisionId', 'sessionId'].map((key, index) => [key, references[index]])
      .filter(([, value]) => value)) });
  state.receipts[input.requestId] = receipt;
  fs.writeFileSync(file, JSON.stringify(state));
  result({ item, receipt });
}
`;

test('ten-item Workspace fixture uses real Node processes, pages frozen evidence and reopens without launching another attempt', async t => {
  // The child reports process.cwd(). On macOS the temporary root can be a symlink.
  const qa = realpathSync(mkdtempSync(join(tmpdir(), 'cou-workspace-lifecycle-')));
  t.after(() => rmSync(qa, { recursive: true, force: true }));
  const cli = join(qa, 'fixture-cli.cjs');
  writeFileSync(cli, engineScript);
  const project = join(qa, 'Nested project é');
  const sibling = join(qa, 'Adjacent project');
  mkdirSync(project);
  mkdirSync(sibling);
  const item = structuredClone(examples.legacy.item);
  item.lifecycle.formalRequired = false;
  const initial = {
    item,
    other: Array.from({ length: 9 }, (_, index) => ({
      ...examples.closed.item, id: 'wi-neighbor-' + index, title: 'Fixture work item ' + index,
      roleId: index % 2 === 0 ? 'verifier' : 'other',
      lifecycle: { ...examples.closed.item.lifecycle, priority: index === 0 ? 'urgent' : 'low', needsAttention: index === 0 }
    })),
    candidate: examples.inReview.item, closed: examples.closed.item.lifecycle, reopened: examples.reopened.item.lifecycle,
    events: [], receipts: {}
  };
  for (const root of [project, sibling]) writeFileSync(join(root, 'fixture.json'), JSON.stringify(initial));
  const scope = makeScope(project, null, 'isolated-space', cli);
  let reads = 0;
  const work = new WorkItems({ lifecycle: true, runCli: (cwd, args, engine) => {
    assert.equal(engine, scope.engine);
    assert.equal(cwd, project);
    return { code: 0, stdout: execFileSync(engine.node, [engine.cli, ...args], { cwd, encoding: 'utf8', windowsHide: true }) };
  }, readTeam: async cwd => {
    assert.equal(cwd, project);
    reads++;
    return { members: [role] };
  } });

  await work.showList(scope);
  assert.equal(work.current.error, '');
  assert.equal(work.current.items.length, 10);
  assert.equal(work.current.items[0].id, 'wi-neighbor-0');
  assert.deepEqual(work.current.errors.map(error => error.id), ['wi-unreadable', 'wi-malformed']);
  await work.filter(work.current, { roleId: 'verifier', state: 'closed', attention: true });
  assert.deepEqual(work.current.items.map(item => item.id), ['wi-neighbor-0']);
  await work.filter(work.current, {});
  await work.open(work.current, id);
  const screen = work.current;

  await work.startMutation(screen, 'triage');
  work.selectMutation(screen, 'priority', 'high');
  work.selectMutation(screen, 'blockedBy', 'wi-neighbor-0');
  await work.confirmMutation(screen, { ...actor, title: screen.item.title, criteria: screen.item.criteria.join('\n'),
    nextAction: 'Check the refreshed release notes.' });
  assert.equal(screen.item.lifecycle.blockedBy[0].state, 'closed');
  assert.equal(screen.item.lifecycle.priority, 'high');

  await work.startMutation(screen, 'delegate');
  await work.confirmMutation(screen, actor);
  assert.equal(screen.item.result.source, 'terminal_screen');
  assert.equal(workItemActionEnabled(screen.item, 'close'), false);
  await work.startMutation(screen, 'triage');
  work.selectMutation(screen, 'priority', 'urgent');
  await work.confirmMutation(screen, { ...actor, title: 'Do not alter the reserved definition', criteria: 'Changed',
    nextAction: screen.item.lifecycle.nextAction });
  assert.equal(screen.item.title, examples.legacy.item.title);

  await work.startMutation(screen, 'start');
  work.selectMutation(screen, 'roleId', 'verifier');
  await work.confirmMutation(screen, actor);
  assert.equal(screen.item.lifecycle.review.capture.output, examples.inReview.item.result.output);
  await work.startMutation(screen, 'note');
  work.selectMutation(screen, 'noteKind', 'dissent');
  await work.confirmMutation(screen, { ...actor, text: 'The step requires another example.' });
  assert.equal(screen.item.lifecycle.review.notes[0].kind, 'dissent');
  await work.startMutation(screen, 'close');
  await work.confirmMutation(screen, { ...actor, reason: 'The saved criteria pass.', nextAction: 'Publish the notes.' });
  assert.equal(screen.item.lifecycle.state, 'closed');

  work.leave();
  await work.restore(scope, id);
  const restored = work.current;
  await work.loadHistory(restored);
  assert.equal(restored.history.events.length, 2);
  const cursor = restored.history.nextBeforeRevision;
  await work.loadHistory(restored, true);
  assert.equal(restored.history.events.length, 4);
  assert.ok(restored.history.events[2].revision < cursor);
  await work.startMutation(restored, 'reopen');
  work.selectMutation(restored, 'roleId', 'verifier');
  await work.confirmMutation(restored, { ...actor, reason: 'Release text changed.', nextAction: 'Read the new paragraph.' });
  assert.equal(restored.item.lifecycle.cycle, 2);
  assert.equal(restored.item.lifecycle.workRevision, 2);
  assert.equal(restored.item.job, null);
  await work.openArchived(restored, restored.item.lifecycle.decision.reviewId);
  assert.equal(restored.archived.review.capture.output, examples.inReview.item.result.output);
  assert.equal(restored.archived.review.notes[0].kind, 'dissent');
  assert.ok(reads >= 4);
  const commands = readFileSync(join(project, 'calls.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(commands.filter(command => command.action === 'delegate').length, 1);
  assert.equal(JSON.parse(readFileSync(join(sibling, 'fixture.json'))).item.lifecycle.revision, 1);
});
