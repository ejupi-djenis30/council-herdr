import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TeamStore } from '../herdr/mods/council/runtime/team.mjs';
import { WorkItemStore } from '../herdr/mods/council/runtime/work-item-store.mjs';
import { LifecycleStore, hashBytes, hashTuple } from '../herdr/mods/council/runtime/work-item-lifecycle-store.mjs';
import { workItemOperation } from '../lib/work-items.js';

const definition = { id: 'wi-lifecycle', title: 'Review', roleId: 'dev', criteria: ['One'] };
async function setup(t) {
  const project = mkdtempSync(join(tmpdir(), 'council-lifecycle-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  new TeamStore(project).set({ id: 'dev', agent: 'codex', role: 'Developer' });
  const created = await workItemOperation('create', definition, { project });
  assert.equal(created.success, true);
  return { project, store: new WorkItemStore(project) };
}

test('v2 marker claims the same immutable slot and legacy delegate fails closed', async t => {
  const { project, store } = await setup(t);
  const journal = new LifecycleStore(store, definition.id);
  const bytes = store.readRaw(definition.id, 1);
  assert.equal(journal.activate(bytes), true);
  const slot = store.read(definition.id, 2);
  assert.equal(slot.definitionSha256, hashBytes(bytes));
  assert.equal(journal.activate(bytes), false);
  let sends = 0;
  const result = await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async () => { sends++; } });
  assert.equal(result.error.code, 'revision_required');
  assert.equal(sends, 0);
});

test('journal publication is no-replace and damaged suffix retains a sound prefix', async t => {
  const { store } = await setup(t);
  const journal = new LifecycleStore(store, definition.id);
  const def = store.readRaw(definition.id, 1);
  journal.activate(def);
  const slot = store.readRaw(definition.id, 2);
  const anchor = hashTuple([hashBytes(def), hashBytes(slot)]);
  const event = { $schema: 'council.work-item-event/v2', id: definition.id, revision: 2, expectedRevision: 1,
    previousSha256: anchor, requestId: 'triage-1', requestSha256: hashTuple(['triage']), at: new Date().toISOString(),
    actor: 'Lead', type: 'triaged', data: { priority: 'high' } };
  assert.equal(journal.append(event), true);
  assert.equal(journal.append(event), false);
  assert.equal(journal.read(1, def, slot).revision, 2);
  writeFileSync(join(journal.directory(), '00000004.json'), '{}');
  const result = journal.read(1, def, slot);
  assert.equal(result.revision, 2);
  assert.equal(result.events.length, 1);
  assert.equal(result.integrity.code, 'integrity_error');
});

test('triage revisions and request replay are durable, and a v2 attempt dispatches at most once', async t => {
  const { project } = await setup(t);
  const mutation = { id: definition.id, ifRevision: 1, requestId: 'triage-1', actor: 'Lead', patch: { priority: 'high', nextAction: 'Review.' } };
  const triaged = await workItemOperation('triage', mutation, { project });
  assert.equal(triaged.success, true, JSON.stringify(triaged));
  assert.equal(triaged.item.lifecycle.revision, 2);
  assert.equal(triaged.item.lifecycle.priority, 'high');
  const replay = await workItemOperation('triage', mutation, { project });
  assert.equal(replay.receipt.replay, true);
  const stale = await workItemOperation('triage', { ...mutation, requestId: 'triage-2' }, { project });
  assert.equal(stale.error.code, 'conflict');
  assert.equal(stale.error.currentRevision, 2);
  let starts = 0;
  const attempt = { id: definition.id, ifRevision: 2, requestId: 'attempt-1', actor: 'Lead', timeoutSec: 45 };
  const first = await workItemOperation('delegate', attempt, { project, callTeamMember: async (_manager, input) => { starts++; assert.equal(input.workItemBinding.cycle, 1); } });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.item.lifecycle.revision, 3);
  assert.equal(first.item.job.outcome, 'unconfirmed_start');
  const second = await workItemOperation('delegate', attempt, { project, callTeamMember: async () => { starts++; } });
  assert.equal(second.receipt.replay, true);
  assert.equal(starts, 1);
  assert.equal((await workItemOperation('delegate', { id: definition.id }, { project })).error.code, 'revision_required');
});

test('operator review freezes a legacy capture, records dissent, closes and reopens without losing evidence', async t => {
  const { project, store } = await setup(t);
  const legacy = await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async (_manager, call) => {
    const dir = join(store.base, call.sessionId);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
      mode: 'delegate', workItemId: definition.id, participant: { team: { id: 'dev' }, address: 't1' },
      state: 'completed', deliveryState: 'acknowledged', deadlineAt: new Date(Date.now() + 60000).toISOString(),
      result: { output: 'Evidence output', captureScope: 'history', completedAt: new Date().toISOString(), turn: 2 } }));
  } });
  assert.equal(legacy.item.state, 'result_ready');
  const start = await workItemOperation('review', { action: 'start', id: definition.id, ifRevision: 2,
    requestId: 'review-1', actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'operator' }, { project });
  assert.equal(start.success, true, JSON.stringify(start));
  assert.equal(start.item.lifecycle.state, 'in_review');
  assert.equal(start.item.lifecycle.review.capture.output, 'Evidence output');
  assert.equal(start.item.lifecycle.review.capture.source, 'terminal_screen');
  const review = start.item.lifecycle.review;
  const note = await workItemOperation('review', { action: 'note', id: definition.id, ifRevision: 3,
    requestId: 'note-1', actor: 'Lead', reviewId: review.id, kind: 'dissent', text: 'Check later.' }, { project });
  assert.equal(note.success, true, JSON.stringify(note));
  assert.equal(note.item.lifecycle.review.notes[0].kind, 'dissent');
  const close = await workItemOperation('close', { id: definition.id, ifRevision: 4, requestId: 'close-1', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Criteria met.', nextAction: 'Ship.' }, { project });
  assert.equal(close.success, true, JSON.stringify(close));
  assert.equal(close.item.lifecycle.state, 'closed');
  const decision = close.item.lifecycle.decision;
  const reopened = await workItemOperation('reopen', { id: definition.id, ifRevision: 5, requestId: 'reopen-1', actor: 'Lead',
    decisionId: decision.id, snapshotSha256: review.snapshotSha256, reason: 'New work.', roleId: 'dev', nextAction: 'Check again.' }, { project });
  assert.equal(reopened.success, true, JSON.stringify(reopened));
  assert.equal(reopened.item.lifecycle.cycle, 2);
  assert.equal(reopened.item.job, null);
  const archived = await workItemOperation('show', { id: definition.id, reviewId: review.id }, { project });
  assert.equal(archived.archivedReview.capture.output, 'Evidence output');
  assert.equal(archived.archivedReview.notes[0].kind, 'dissent');
});

test('competing processes publish only one v2 attempt for a cycle', async t => {
  const { project } = await setup(t);
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const module = pathToFileURL(join(process.cwd(), 'lib', 'work-items.js')).href;
  const marker = join(project, 'attempts.txt');
  const script = `import { appendFileSync } from 'node:fs'; import { workItemOperation } from ${JSON.stringify(module)};
    const r = await workItemOperation('delegate', { id:'wi-lifecycle', ifRevision:1, requestId:process.argv[3], actor:'Lead' },
      { project:process.argv[1], callTeamMember:async()=>appendFileSync(process.argv[2], 'start\\n') }); console.log(JSON.stringify(r));`;
  const run = request => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, project, marker, request]);
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject); child.on('close', code => code ? reject(new Error(error)) : resolve(JSON.parse(output)));
  });
  const results = await Promise.all([run('race-one'), run('race-two')]);
  assert.equal(results.filter(result => result.success).length, 1);
  assert.equal(results.find(result => !result.success).error.code, 'conflict');
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(marker, 'utf8'), 'start\n');
});

test('filters and history retain project scope and original definition replay', async t => {
  const first = await setup(t);
  const second = await setup(t);
  const edited = await workItemOperation('triage', { id: definition.id, ifRevision: 1, requestId: 'edit', actor: 'Lead',
    patch: { title: 'Changed', blockedBy: ['wi-missing'], priority: 'urgent' } }, { project: first.project });
  assert.equal(edited.item.title, 'Changed');
  assert.equal(edited.item.lifecycle.workRevision, 2);
  assert.equal(edited.item.lifecycle.needsAttention, true);
  const replay = await workItemOperation('create', definition, { project: first.project });
  assert.equal(replay.item.title, 'Changed');
  assert.equal((await workItemOperation('show', { id: definition.id }, { project: second.project })).item.title, 'Review');
  assert.equal((await workItemOperation('list', { needsAttention: true, sort: 'priority' }, { project: first.project })).items.length, 1);
  assert.equal((await workItemOperation('list', { needsAttention: false }, { project: first.project })).items.length, 0);
  const receipt = await workItemOperation('history', { id: definition.id, requestId: 'edit' }, { project: first.project });
  assert.equal(receipt.receipt.revision, 2);
  const page = await workItemOperation('history', { id: definition.id, limit: 1 }, { project: first.project });
  assert.equal(page.events[0].type, 'triaged');
  assert.equal(page.nextBeforeRevision, 2);
});

test('a reopened second cycle starts one bound Team job and preserves the original handoff', async t => {
  const { project, store } = await setup(t);
  const { JobManager } = await import('../lib/jobs.js');
  await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async (_manager, call) => {
    const dir = join(store.base, call.sessionId);
    const { mkdirSync } = await import('node:fs'); mkdirSync(dir);
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
      mode: 'delegate', workItemId: definition.id, participant: { team: { id: 'dev' } }, state: 'completed',
      deliveryState: 'acknowledged', deadlineAt: new Date(Date.now() + 60000).toISOString(), result: { output: 'Old handoff' } }));
  } });
  const review = await workItemOperation('review', { action: 'start', id: definition.id, ifRevision: 2, requestId: 'review', actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'operator' }, { project });
  const returned = await workItemOperation('review', { action: 'return', id: definition.id, ifRevision: 3, requestId: 'return', actor: 'Lead',
    reviewId: review.item.lifecycle.review.id, evidenceToken: review.item.lifecycle.review.evidenceToken,
    reason: 'More changes.', roleId: 'dev', nextAction: 'Revise.' }, { project });
  assert.equal(returned.item.lifecycle.cycle, 2);
  let launches = 0, job;
  const manager = new JobManager({ cwd: project, herdr: { terminalId: null, get: () => ({ success: false }) },
    workerLauncher: event => { launches++; job = event.job; return { success: true }; } });
  const input = { id: definition.id, ifRevision: 4, requestId: 'second-attempt', actor: 'Lead', timeoutSec: 55 };
  const started = await workItemOperation('delegate', input, { project, manager });
  assert.equal(started.success, true, JSON.stringify(started));
  assert.equal(launches, 1);
  assert.equal(job.workItemBinding.cycle, 2);
  assert.equal(job.workItemBinding.workRevision, 2);
  assert.equal(job.timeoutSec, 55);
  assert.match(job.task, /1\. One/);
  assert.equal(started.item.job.linked, true);
  const replayed = await workItemOperation('delegate', input, { project, manager });
  assert.equal(replayed.receipt.replay, true);
  assert.equal(launches, 1);
  assert.equal(replayed.item.job.deadlineAt, job.deadlineAt);
  const archived = await workItemOperation('show', { id: definition.id, reviewId: review.item.lifecycle.review.id }, { project });
  assert.equal(archived.archivedReview.capture.output, 'Old handoff');
  const path = join(store.base, started.item.job.sessionId, 'job.json');
  const { readFileSync } = await import('node:fs');
  const altered = JSON.parse(readFileSync(path, 'utf8'));
  altered.workItemBinding.cycle = 1;
  writeFileSync(path, JSON.stringify(altered));
  const mismatched = await workItemOperation('show', { id: definition.id, reviewId: review.item.lifecycle.review.id }, { project });
  assert.equal(mismatched.item.job.linked, false);
  assert.equal(mismatched.item.job.outcome, 'integrity_error');
  assert.equal(mismatched.archivedReview.capture.output, 'Old handoff');
});

test('a lost attempt-publication acknowledgement never triggers or replays dispatch', async t => {
  const { project } = await setup(t);
  const original = LifecycleStore.prototype.append;
  t.after(() => { LifecycleStore.prototype.append = original; });
  LifecycleStore.prototype.append = function (event) {
    original.call(this, event);
    throw new Error('lost acknowledgement');
  };
  let sends = 0;
  const input = { id: definition.id, ifRevision: 1, requestId: 'lost-attempt', actor: 'Lead' };
  const options = { project, callTeamMember: async () => { sends++; } };
  const first = await workItemOperation('delegate', input, options);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.receipt.replay, true);
  assert.equal(first.item.job.outcome, 'unconfirmed_start');
  LifecycleStore.prototype.append = original;
  const reopened = await workItemOperation('delegate', input, options);
  assert.equal(reopened.receipt.replay, true);
  assert.equal(reopened.item.job.sessionId, first.item.job.sessionId);
  assert.equal(sends, 0);
});

test('damaged journal suffix preserves the valid prefix and refuses uncertain request lookup', async t => {
  const { project, store } = await setup(t);
  const saved = await workItemOperation('triage', { id: definition.id, ifRevision: 1, requestId: 'saved', actor: 'Lead', patch: { priority: 'high' } }, { project });
  assert.equal(saved.success, true);
  const journal = new LifecycleStore(store, definition.id);
  writeFileSync(join(journal.directory(), '00000003.json'), Buffer.from([0xff]));
  const shown = await workItemOperation('show', { id: definition.id }, { project });
  assert.equal(shown.item.lifecycle.revision, 2);
  assert.equal(shown.item.lifecycle.priority, 'high');
  assert.equal(shown.item.lifecycle.integrity.code, 'integrity_error');
  assert.equal(shown.item.lifecycle.actions.triage, false);
  const known = await workItemOperation('history', { id: definition.id, requestId: 'saved' }, { project });
  assert.equal(known.receipt.revision, 2);
  const unknown = await workItemOperation('history', { id: definition.id, requestId: 'unknown' }, { project });
  assert.equal(unknown.error.code, 'integrity_error');
});

test('ten project-local items filter, sort and retain blocker links through an alias', async t => {
  const { project } = await setup(t);
  const { symlinkSync } = await import('node:fs');
  const alias = `${project}-alias`;
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rmSync(alias, { force: true }));
  for (let index = 0; index < 9; index++) {
    const item = { id: `wi-${index}`, title: `Item ${index}`, roleId: 'dev', criteria: ['Check'] };
    assert.equal((await workItemOperation('create', item, { project })).success, true);
  }
  const high = await workItemOperation('triage', { id: 'wi-1', ifRevision: 1, requestId: 'high', actor: 'Lead',
    patch: { priority: 'urgent', blockedBy: ['wi-2'] } }, { project: alias });
  assert.equal(high.success, true);
  const cycle = await workItemOperation('triage', { id: 'wi-2', ifRevision: 1, requestId: 'cycle', actor: 'Lead',
    patch: { blockedBy: ['wi-1'] } }, { project });
  assert.equal(cycle.success, true);
  const listed = await workItemOperation('list', { roleId: 'dev', lifecycleState: 'open', sort: 'priority' }, { project });
  assert.equal(listed.items.length, 10);
  assert.equal(listed.items[0].id, 'wi-1');
  assert.equal(listed.items[0].lifecycle.blockedBy[0].title, 'Item 2');
  assert.equal(listed.items[0].lifecycle.needsAttention, true);
  rmSync(join(project, '.agent_workspace', '.work-items', 'wi-2'), { recursive: true });
  const changed = await workItemOperation('show', { id: 'wi-1' }, { project: alias });
  assert.equal(changed.item.lifecycle.blockedBy[0].state, 'unavailable');
  assert.equal(changed.item.lifecycle.needsAttention, true);
});

test('journal gaps, wrong digests and invalid events preserve the healthy prefix without dispatch', async t => {
  for (const kind of ['gap', 'digest', 'schema', 'utf8']) {
    const { project, store } = await setup(t);
    const saved = await workItemOperation('triage', { id: definition.id, ifRevision: 1, requestId: 'saved', actor: 'Lead', patch: { priority: 'high' } }, { project });
    assert.equal(saved.success, true);
    const journal = new LifecycleStore(store, definition.id);
    const suffix = join(journal.directory(), kind === 'gap' ? '00000004.json' : '00000003.json');
    const event = { $schema: kind === 'schema' ? 'wrong' : 'council.work-item-event/v2', id: definition.id,
      revision: 3, expectedRevision: 2, previousSha256: '0'.repeat(64), requestId: 'bad', requestSha256: '0'.repeat(64),
      at: new Date().toISOString(), actor: 'Lead', type: 'triaged', data: { request: {} } };
    writeFileSync(suffix, kind === 'utf8' ? Buffer.from([0xff]) : JSON.stringify(event));
    writeFileSync(join(journal.directory(), '.unfinished.tmp'), '{');
    const shown = await workItemOperation('show', { id: definition.id }, { project });
    assert.equal(shown.item.lifecycle.revision, 2, kind);
    assert.equal(shown.item.lifecycle.priority, 'high', kind);
    assert.equal(shown.item.lifecycle.integrity.code, 'integrity_error', kind);
    let sends = 0;
    const result = await workItemOperation('delegate', { id: definition.id, ifRevision: 2, requestId: 'new', actor: 'Lead' },
      { project, callTeamMember: async () => { sends++; } });
    assert.equal(result.error.code, 'integrity_error', kind);
    assert.equal(sends, 0, kind);
  }
});

test('unsupported event publication preserves the marker and does not start a job', async t => {
  const { project } = await setup(t);
  const original = LifecycleStore.prototype.append;
  t.after(() => { LifecycleStore.prototype.append = original; });
  LifecycleStore.prototype.append = () => { const error = new Error('hard links unsupported'); error.code = 'ENOTSUP'; throw error; };
  let sends = 0;
  const result = await workItemOperation('delegate', { id: definition.id, ifRevision: 1, requestId: 'fail', actor: 'Lead' },
    { project, callTeamMember: async () => { sends++; } });
  assert.equal(result.error.code, 'storage_error');
  assert.equal(sends, 0);
  const shown = await workItemOperation('show', { id: definition.id }, { project });
  assert.equal(shown.item.lifecycle.revision, 1);
  assert.equal(shown.item.lifecycle.managed, true);
  assert.equal((await workItemOperation('delegate', { id: definition.id }, { project })).error.code, 'revision_required');
});

test('adjacent Git worktrees keep the same item ID and lifecycle revisions isolated', async t => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'council-git-worktrees-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, 'first'); const second = join(root, 'second');
  mkdirSync(first);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: first, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  git('worktree', 'add', '--detach', second);
  for (const project of [first, second]) {
    new TeamStore(project).set({ id: 'dev', agent: 'codex', role: 'Developer' });
    assert.equal((await workItemOperation('create', definition, { project })).success, true);
  }
  const changed = await workItemOperation('triage', { id: definition.id, ifRevision: 1, requestId: 'first-only', actor: 'Lead',
    patch: { priority: 'urgent' } }, { project: first });
  assert.equal(changed.item.lifecycle.revision, 2);
  const other = await workItemOperation('show', { id: definition.id }, { project: second });
  assert.equal(other.item.lifecycle.revision, 1);
  assert.equal(other.item.lifecycle.priority, 'none');
});

test('a journal without its baseline slot blocks the unversioned delegate path', async t => {
  const { project, store } = await setup(t);
  const { mkdirSync } = await import('node:fs');
  const dir = join(store.directory(definition.id), 'lifecycle');
  mkdirSync(dir);
  writeFileSync(join(dir, '00000002.json'), '{}');
  let starts = 0;
  const result = await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async () => { starts++; } });
  assert.equal(result.success, true);
  assert.equal(result.item.state, 'needs_attention');
  assert.equal(result.item.canDelegate, false);
  assert.equal(result.item.lifecycle.integrity.code, 'integrity_error');
  assert.equal(starts, 0);
  assert.equal(store.read(definition.id, 2), null);
});

test('v2 interruption windows preserve the same reservation, deadline and zero replay sends', async t => {
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const cli = join(process.cwd(), 'bin', 'council.js');
  for (const phase of ['before-job', 'during-reservation', 'after-send']) {
    const { project, store } = await setup(t);
    let calls = 0;
    const deadline = new Date(Date.now() + 60000).toISOString();
    const input = { id: definition.id, ifRevision: 1, requestId: 'attempt', actor: 'Lead', timeoutSec: 60 };
    const first = await workItemOperation('delegate', input, { project, callTeamMember: async (_manager, call) => {
      calls++;
      if (phase !== 'before-job') mkdirSync(join(store.base, call.sessionId));
      if (phase === 'after-send') writeFileSync(join(store.base, call.sessionId, 'job.json'), JSON.stringify({
        $schema: 'council.job/v1', sessionId: call.sessionId, mode: 'delegate', workItemId: definition.id,
        workItemBinding: call.workItemBinding, participant: { team: { id: 'dev' }, address: 't1' },
        state: 'uncertain', deliveryState: 'uncertain', deadlineAt: deadline
      }));
      throw new Error('Lost client response');
    } });
    assert.equal(first.success, true, phase);
    const sessionId = first.item.job.sessionId;
    const child = spawnSync(process.execPath, [cli, 'work-item', 'show', '--id', definition.id, '--project', project], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(child.stdout).item;
    assert.equal(observed.job.sessionId, sessionId, phase);
    assert.equal(observed.state, 'needs_attention', phase);
    if (phase === 'after-send') {
      assert.equal(observed.job.deadlineAt, deadline);
      assert.equal(observed.job.deliveryState, 'uncertain');
      assert.equal(JSON.parse(readFileSync(join(store.base, sessionId, 'job.json'), 'utf8')).deadlineAt, deadline);
    }
    const repeat = await workItemOperation('delegate', input, { project, callTeamMember: async () => { calls++; } });
    assert.equal(repeat.receipt.replay, true, phase);
    assert.equal(repeat.item.job.sessionId, sessionId, phase);
    assert.equal(calls, 1, phase);
  }
});

test('competing close and reopen processes keep one decision and replay its receipt', async t => {
  const { project, store } = await setup(t);
  const { mkdirSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  await workItemOperation('delegate', { id: definition.id }, { project, callTeamMember: async (_manager, call) => {
    const dir = join(store.base, call.sessionId); mkdirSync(dir);
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId, mode: 'delegate',
      workItemId: definition.id, participant: { team: { id: 'dev' } }, state: 'completed', deliveryState: 'acknowledged',
      deadlineAt: new Date(Date.now() + 60000).toISOString(), result: { output: 'Evidence' } }));
  } });
  const started = await workItemOperation('review', { action: 'start', id: definition.id, ifRevision: 2, requestId: 'review', actor: 'Lead',
    reviewOwnerRoleId: 'dev', policy: 'operator' }, { project });
  const review = started.item.lifecycle.review;
  const module = pathToFileURL(join(process.cwd(), 'lib/work-items.js')).href;
  const script = `import { workItemOperation } from ${JSON.stringify(module)}; const body=JSON.parse(process.argv[2]); console.log(JSON.stringify(await workItemOperation(body.operation,body.input,{project:process.argv[1]})));`;
  const run = (operation, input) => new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, project, JSON.stringify({ operation, input })]);
    let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject); child.on('close', code => code ? reject(new Error(err)) : done(JSON.parse(out)));
  });
  const close = requestId => ({ id: definition.id, ifRevision: 3, requestId, actor: 'Lead', reviewId: review.id,
    evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Reviewed.', nextAction: 'Ship.' });
  const closes = await Promise.all([run('close', close('close-a')), run('close', close('close-b'))]);
  assert.equal(closes.filter(result => result.success).length, 1);
  assert.equal(closes.find(result => !result.success).error.code, 'conflict');
  const winner = closes.find(result => result.success);
  const decision = winner.item.lifecycle.decision;
  const reopen = requestId => ({ id: definition.id, ifRevision: 4, requestId, actor: 'Lead', decisionId: decision.id,
    snapshotSha256: review.snapshotSha256, reason: 'New work.', roleId: 'dev', nextAction: 'Recheck.' });
  const reopens = await Promise.all([run('reopen', reopen('open-a')), run('reopen', reopen('open-b'))]);
  assert.equal(reopens.filter(result => result.success).length, 1);
  assert.equal(reopens.find(result => !result.success).error.code, 'conflict');
  const recovered = await run('close', close(winner.receipt.requestId));
  assert.equal(recovered.receipt.replay, true);
  assert.equal(recovered.item.lifecycle.state, 'open');
  assert.equal(recovered.item.lifecycle.cycle, 2);
});

async function completedLegacy(t, output = 'Saved handoff') {
  const context = await setup(t);
  const { mkdirSync } = await import('node:fs');
  const delegated = await workItemOperation('delegate', { id: definition.id }, { project: context.project, callTeamMember: async (_manager, call) => {
    const dir = join(context.store.base, call.sessionId);
    mkdirSync(dir);
    writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
      mode: 'delegate', workItemId: definition.id, participant: { team: { id: 'dev' } }, state: 'completed',
      deliveryState: 'acknowledged', deadlineAt: new Date(Date.now() + 60000).toISOString(),
      result: { output, captureScope: 'history', turn: 2, completedAt: new Date().toISOString() } }));
  } });
  assert.equal(delegated.item.state, 'result_ready');
  return { ...context, sessionId: delegated.item.job.sessionId };
}

test('a leading UTF-8 BOM remains part of active and archived frozen capture bytes', async t => {
  const { createHash } = await import('node:crypto');
  const output = '\ufeffFirst line\nNext line';
  const { project } = await completedLegacy(t, output);
  const started = await workItemOperation('review', { action: 'start', id: definition.id, ifRevision: 2,
    requestId: 'bom-review', actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'operator' }, { project });
  assert.equal(started.success, true, JSON.stringify(started));
  const review = started.item.lifecycle.review;
  const expected = Buffer.from(output, 'utf8');
  assert.equal(review.capture.verified, true);
  assert.deepEqual(Buffer.from(review.capture.output, 'utf8'), expected);
  assert.equal(createHash('sha256').update(review.capture.output, 'utf8').digest('hex'), review.capture.sha256);
  const closed = await workItemOperation('close', { id: definition.id, ifRevision: 3, requestId: 'bom-close', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Reviewed.', nextAction: 'Share.' }, { project });
  assert.equal(closed.success, true, JSON.stringify(closed));
  const reopened = await workItemOperation('reopen', { id: definition.id, ifRevision: 4, requestId: 'bom-reopen', actor: 'Lead',
    decisionId: closed.item.lifecycle.decision.id, snapshotSha256: review.snapshotSha256, reason: 'Follow up.', roleId: 'dev', nextAction: 'Check again.' }, { project });
  assert.equal(reopened.success, true, JSON.stringify(reopened));
  const archived = await workItemOperation('show', { id: definition.id, reviewId: review.id }, { project });
  assert.deepEqual(Buffer.from(archived.archivedReview.capture.output, 'utf8'), expected);
  assert.equal(createHash('sha256').update(archived.archivedReview.capture.output, 'utf8').digest('hex'), review.capture.sha256);
});

test('formal review returned before attachment requires formal policy in the next cycle', async t => {
  const { mkdirSync } = await import('node:fs');
  const { project, store } = await completedLegacy(t);
  const started = await workItemOperation('review', { action: 'start', id: definition.id, ifRevision: 2,
    requestId: 'formal-review', actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'formal' }, { project });
  const review = started.item.lifecycle.review;
  assert.equal(review.formal, null);
  assert.equal(started.item.lifecycle.formalRequired, true);
  const returned = await workItemOperation('review', { action: 'return', id: definition.id, ifRevision: 3,
    requestId: 'return-before-attach', actor: 'Lead', reviewId: review.id, evidenceToken: review.evidenceToken,
    reason: 'More work.', roleId: 'dev', nextAction: 'Revise.' }, { project });
  assert.equal(returned.success, true, JSON.stringify(returned));
  assert.equal(returned.item.lifecycle.formalRequired, true);
  assert.equal(returned.item.lifecycle.decision.formal, null);
  const second = await workItemOperation('delegate', { id: definition.id, ifRevision: 4, requestId: 'second', actor: 'Lead' }, {
    project, callTeamMember: async (_manager, call) => {
      const dir = join(store.base, call.sessionId); mkdirSync(dir);
      writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
        mode: 'delegate', workItemId: definition.id, workItemBinding: call.workItemBinding, participant: { team: { id: 'dev' } },
        state: 'completed', deliveryState: 'acknowledged', deadlineAt: new Date(Date.now() + 60000).toISOString(), result: { output: 'Second handoff' } }));
    }
  });
  assert.equal(second.item.lifecycle.formalRequired, true);
  const downgraded = await workItemOperation('review', { action: 'start', id: definition.id, ifRevision: 5,
    requestId: 'operator', actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'operator' }, { project });
  assert.equal(downgraded.error.code, 'review_not_authorized');
  const formal = await workItemOperation('review', { action: 'start', id: definition.id, ifRevision: 5,
    requestId: 'formal-second', actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'formal' }, { project });
  assert.equal(formal.success, true, JSON.stringify(formal));
  assert.equal(formal.item.lifecycle.formalRequired, true);
});

test('a damaged journal suffix preserves a COU-2-compatible completed result and the validated history', async t => {
  const { mkdirSync } = await import('node:fs');
  const { WorkItems } = await import('../herdr/mods/council/work-item-actions.js');
  const { project, store } = await setup(t);
  const started = await workItemOperation('delegate', { id: definition.id, ifRevision: 1, requestId: 'attempt', actor: 'Lead' }, {
    project, callTeamMember: async (_manager, call) => {
      const dir = join(store.base, call.sessionId); mkdirSync(dir);
      writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
        mode: 'delegate', workItemId: definition.id, workItemBinding: call.workItemBinding, participant: { team: { id: 'dev' } },
        state: 'completed', deliveryState: 'acknowledged', deadlineAt: new Date(Date.now() + 60000).toISOString(), result: { output: 'Saved result' } }));
    }
  });
  assert.equal(started.item.state, 'result_ready');
  writeFileSync(join(store.directory(definition.id), 'lifecycle', '00000003.json'), Buffer.from([0xff]));
  const shown = await workItemOperation('show', { id: definition.id }, { project });
  assert.equal(shown.item.state, 'result_ready');
  assert.equal(shown.item.result.output, 'Saved result');
  assert.equal(shown.item.lifecycle.integrity.code, 'integrity_error');
  assert.equal(shown.item.lifecycle.needsAttention, true);
  assert.match(shown.item.lifecycle.guidance, /journal/i);
  assert.ok(Object.values(shown.item.lifecycle.actions).every(value => value === false));
  const history = await workItemOperation('history', { id: definition.id }, { project });
  assert.equal(history.events[0].type, 'attempt_reserved');
  assert.equal(history.integrity.code, 'integrity_error');
  const blocked = await workItemOperation('triage', { id: definition.id, ifRevision: 2, requestId: 'blocked', actor: 'Lead', patch: { priority: 'high' } }, { project });
  assert.equal(blocked.error.code, 'integrity_error');
  const scope = { project: store.root, space: 'fixture', anchor: store.root, engine: { machine: null } };
  const controller = new WorkItems({ runCli: async (_cwd, args) => {
    const result = args[1] === 'list' ? await workItemOperation('list', {}, { project }) : shown;
    return { code: 0, stdout: JSON.stringify(result), stderr: '' };
  }, readTeam: async () => ({ members: [] }) });
  await controller.showList(scope);
  await controller.open(controller.current, definition.id);
  assert.equal(controller.current.error, '');
  assert.equal(controller.current.item.result.output, 'Saved result');
});

test('a delayed observation from the first attempt cannot time out a second cycle', async t => {
  const { mkdirSync } = await import('node:fs');
  const { project, store, sessionId: firstSession } = await completedLegacy(t);
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const pendingShow = workItemOperation('show', { id: definition.id }, { project, manager: {
    async getStatus(sessionId) { assert.equal(sessionId, firstSession); entered(); await gate; return { sessionId, outcome: 'timed_out' }; }
  } });
  await waiting;
  const started = await workItemOperation('review', { action: 'start', id: definition.id, ifRevision: 2,
    requestId: 'review-race', actor: 'Lead', reviewOwnerRoleId: 'dev', policy: 'operator' }, { project });
  const review = started.item.lifecycle.review;
  const closed = await workItemOperation('close', { id: definition.id, ifRevision: 3, requestId: 'close-race', actor: 'Lead',
    reviewId: review.id, evidenceToken: review.evidenceToken, decision: 'accept', reason: 'Reviewed.', nextAction: 'Ship.' }, { project });
  const reopened = await workItemOperation('reopen', { id: definition.id, ifRevision: 4, requestId: 'reopen-race', actor: 'Lead',
    decisionId: closed.item.lifecycle.decision.id, snapshotSha256: review.snapshotSha256, reason: 'New work.', roleId: 'dev', nextAction: 'Recheck.' }, { project });
  assert.equal(reopened.success, true, JSON.stringify(reopened));
  const second = await workItemOperation('delegate', { id: definition.id, ifRevision: 5, requestId: 'second-race', actor: 'Lead' }, {
    project, callTeamMember: async (_manager, call) => {
      const dir = join(store.base, call.sessionId); mkdirSync(dir);
      writeFileSync(join(dir, 'job.json'), JSON.stringify({ $schema: 'council.job/v1', sessionId: call.sessionId,
        mode: 'delegate', workItemId: definition.id, workItemBinding: call.workItemBinding, participant: { team: { id: 'dev' } },
        state: 'starting', deliveryState: 'planned', deadlineAt: new Date(Date.now() + 60000).toISOString() }));
    }
  });
  assert.notEqual(second.item.job.sessionId, firstSession);
  release();
  const delayed = await pendingShow;
  assert.equal(delayed.item.job.sessionId, second.item.job.sessionId);
  assert.equal(delayed.item.lifecycle.cycle, 2);
  assert.equal(delayed.item.state, 'in_progress');
  assert.equal(delayed.item.job.outcome, 'starting');
  const fresh = await workItemOperation('show', { id: definition.id }, { project, manager: {
    async getStatus(sessionId) { return { sessionId, outcome: 'starting' }; }
  } });
  assert.equal(fresh.item.state, delayed.item.state);
  assert.equal(fresh.item.job.sessionId, delayed.item.job.sessionId);
  assert.equal(fresh.item.job.outcome, delayed.item.job.outcome);
});
