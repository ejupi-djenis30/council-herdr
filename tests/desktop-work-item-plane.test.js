import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
import { WorkItems, workItemActionEnabled, workItemScreenVisible } from '../herdr/mods/council/work-item-actions.js';

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const fixture = json('../specs/004-plane-evidence-publication/contracts/examples.json');
const { engineEnvelopes: replies, sameLocalSelection: selection, cases } = fixture.readerIdentityVectors;
const item = { ...json('../specs/002-work-item-review/contracts/examples.json').inReview.item, id: selection.itemId };
item.lifecycle.revision = 6;
const id = item.id;
const scope = Object.freeze({
  space: 'workspace', anchor: selection.project, project: selection.project,
  engine: Object.freeze({ machine: selection.machine, cli: 'installed/council.js', entry: 'installed/council.mjs', node: 'node' })
});
const wire = (response, project, code = 0) => ({ code, stdout: JSON.stringify({ ...response, project }), stderr: 'private-stderr' });
const unavailable = type => ({ success: false, error: { code: type, message: 'private-provider-header' } });
const delayed = () => {
  let resolve;
  const result = new Promise(done => { resolve = done; });
  return { result, resolve };
};

function harness(answer) {
  const calls = [];
  let active = scope;
  const work = new WorkItems({
    lifecycle: true,
    visible: screen => workItemScreenVisible(screen, {
      space: { id: active.space, machine: active.engine.machine }, target: active.anchor, workspaceActive: true
    }),
    runCli: async (project, args, engine) => {
      calls.push({ project, args, engine });
      if (args[1] === 'show') return wire({ success: true, item: structuredClone(item) }, project);
      assert.ok(args[0] === 'work-item' && args[1] === 'plane' && ['show', 'open'].includes(args[2]), JSON.stringify(args));
      assert.deepEqual(args.slice(3, 7), ['--id', id, '--project', project]);
      return answer({ project, verb: args[2], op: args[8], engine });
    }
  });
  return {
    calls,
    verbs: () => calls.filter(call => call.args[1] === 'plane').map(({ args }) => args.slice(2).filter((_, index) => index === 0 || index >= 5)),
    select: async (target = scope) => {
      active = target;
      await work.restore(target, id);
      return work.current.plane;
    },
    leave: () => work.leave()
  };
}

const projectAnswer = name => ({ project }) => wire(replies[name], project);
const scoped = fixture.source.operationId;
const uncertain = {
  ...replies.showA, plane: { ...replies.showA.plane,
    operation: { ...replies.showA.plane.operation, state: 'delivery_uncertain', reason: 'receipt_not_proven', receipt: null }
  }
};

test('a verified reader hands off only a local reference and preserves the published receipt', async () => {
  const h = harness(({ project, verb }) => wire(replies[verb === 'show' ? 'showA' : 'openA'], project));
  const current = await h.select();
  await current.refresh();
  assert.equal(current.action, 'prepare');
  assert.equal(current.link.itemId, fixture.source.link.itemId);
  assert.equal(current.operation.receipt.commentId, fixture.positiveComment.id);
  await current.open(current.handoffAction);
  assert.deepEqual(current.handoff, {
    intent: 'prepare', disposition: 'manual_operator_session', localRef: replies.openA.planeHandoff.localRef
  });
  assert.deepEqual(h.verbs(), [['show'], ['open']]);
  assert.equal(h.calls.at(-1).engine, scope.engine);
});

test('a missing, null or malformed installation leaves the ordinary work item usable', async t => {
  await Promise.all(cases.filter(example => example.interactiveInstallation === null).map(example => t.test(example.case, async () => {
    const read = example.replies[1];
    let next = 'showA';
    const h = harness(input => projectAnswer(next)(input));
    const current = await h.select();
    await current.refresh();
    assert.equal(current.receipts.length, 1);
    next = read;
    await current.refresh();
    assert.equal(current.installationId, null);
    assert.equal(current.action, null);
    assert.equal(current.link, null);
    assert.deepEqual(current.receipts, []);
    assert.equal(workItemActionEnabled(current.screen.item, 'return'), true);
    await current.open(current.handoffAction);
    assert.deepEqual(h.verbs(), [['show'], ['show']]);
  })));
});

test('replacement at the same path from show waits for a fresh show and does not reuse old context', async () => {
  let next = 'showA';
  const fresh = delayed();
  const secondRead = delayed();
  let sightings = 0;
  const h = harness(({ project, verb }) => {
    if (verb === 'open') return wire(replies.openB, project);
    if (next === 'showB' && ++sightings === 2) {
      secondRead.resolve();
      return fresh.result;
    }
    return wire(replies[next], project);
  });
  const current = await h.select();
  await current.refresh();
  assert.equal(current.receipts.length, 1);
  next = 'showB';
  const refresh = current.refresh();
  await secondRead.result;
  assert.equal(current.action, null);
  assert.equal(current.link, null);
  assert.deepEqual(current.receipts, []);
  fresh.resolve(wire(replies.showB, scope.project));
  await refresh;
  assert.equal(current.installationId, replies.showB.installationId);
  assert.equal(current.action, 'link');
  await current.open(current.handoffAction);
  assert.equal(current.handoff.localRef, replies.openB.planeHandoff.localRef);
  assert.deepEqual(h.verbs(), [['show'], ['show'], ['show'], ['open']]);
});

test('replacement revealed by open discards its reference and never auto-opens', async () => {
  let seen = false;
  const h = harness(({ project, verb }) => {
    if (verb === 'open') { seen = true; return wire(replies.openB, project); }
    return wire(replies[seen ? 'showB' : 'showA'], project);
  });
  const current = await h.select();
  await current.refresh();
  await current.open(current.handoffAction);
  assert.equal(current.handoff, null);
  assert.equal(current.installationId, replies.showB.installationId);
  assert.equal(current.action, 'link');
  assert.deepEqual(current.receipts, []);
  assert.deepEqual(h.verbs(), [['show'], ['open'], ['show']]);
  await current.open(current.handoffAction);
  assert.equal(current.handoff.localRef, replies.openB.planeHandoff.localRef);
});

test('uncertain delivery reads the original operation and opens only its reconciliation handoff', async () => {
  let positive = false;
  const h = harness(({ project, verb }) => wire(verb === 'show' ? (positive ? replies.showA : uncertain) : {
    ...replies.openA, planeHandoff: { ...replies.openA.planeHandoff, operationId: scoped }
  }, project));
  const current = await h.select();
  await current.refresh();
  await current.open({ ...current.handoffAction, intent: 'prepare' });
  assert.equal(current.action, 'check');
  await current.open(current.handoffAction);
  assert.equal(current.handoff.intent, 'check');
  assert.deepEqual(h.verbs(), [['show'], ['show', '--operation-id', scoped], ['open', '--operation-id', scoped]]);
  positive = true;
  await current.open(current.handoffAction);
  assert.equal(current.handoff, null);
  assert.equal(current.operation.receipt.commentId, fixture.positiveComment.id);
  assert.deepEqual(h.verbs().slice(3), [['show', '--operation-id', scoped]]);
});

test('a later negative result cannot clear unknown delivery or overwrite a positive receipt', async () => {
  let next = uncertain;
  const h = harness(({ project }) => wire(next, project));
  const current = await h.select();
  await current.refresh();
  next = { ...uncertain, plane: { ...uncertain.plane, operation: { ...uncertain.plane.operation, state: 'expired' } } };
  await current.refresh();
  assert.equal(current.action, 'check');
  next = replies.showA;
  await current.refresh();
  next = uncertain;
  await current.refresh();
  assert.equal(current.operation.state, 'published');
  assert.equal(current.receipts.length, 1);
});

test('a failed or denied read preserves scoped evidence without exposing provider diagnostics', async t => {
  await Promise.all(['offline', 'authorization_denied', 'scope_conflict'].map(code => t.test(code, async () => {
    let online = true;
    const h = harness(({ project }) => online ? wire(replies.showA, project) : wire(unavailable(code), project, 1));
    const current = await h.select();
    await current.refresh();
    online = false;
    await current.refresh();
    assert.equal(current.issue, code);
    assert.equal(current.freshness, 'cached');
    assert.equal(current.action, null);
    assert.equal(current.receipts[0].receipt.commentId, fixture.positiveComment.id);
    assert.doesNotMatch(JSON.stringify([current.issue, current.operation, current.link]), /private-/);
  })));
});

test('both same-path installation replacement and a different machine discard late handoff references', async t => {
  await Promise.all([scope, { ...scope, engine: { ...scope.engine, machine: 'other-fixture-host' } }]
    .map(target => t.test(target === scope ? 'same transport path and item' : 'other machine', async () => {
      let replacement = false;
      const old = delayed();
      const h = harness(({ project, verb }) => verb === 'open' ? old.result :
        wire(replies[replacement ? 'showB' : 'showA'], project));
      const first = await h.select();
      await first.refresh();
      const handoff = first.open(first.handoffAction);
      replacement = true;
      const second = await h.select(target);
      await second.refresh();
      old.resolve(wire(replies.openA, scope.project));
      await handoff;
      assert.equal(first.handoff, null);
      assert.equal(second.link, null);
      assert.equal(second.handoff, null);
      assert.deepEqual(second.receipts, []);
      assert.equal(second.installationId, replies.showB.installationId);
    })));
});

test('an unsuperseded off-view receipt is recoverable only after original-scope reattestation', async () => {
  const late = delayed();
  const neighbor = { ...scope, engine: { ...scope.engine, machine: 'neighbor' } };
  let inspect = false;
  let reconnect = false;
  let attested = false;
  const h = harness(({ project, engine }) => {
    if (engine === neighbor.engine) return wire(replies.showB, project);
    if (inspect) return late.result;
    if (reconnect) return wire(attested ? { ...replies.showA, plane: { ...replies.showA.plane, freshness: 'cached', operation: null } } :
      replies.showNull, project);
    return wire(uncertain, project);
  });
  const first = await h.select();
  await first.refresh();
  inspect = true;
  const read = first.refresh();
  const second = await h.select(neighbor);
  await second.refresh();
  late.resolve(wire(replies.showA, scope.project));
  await read;
  assert.deepEqual(second.receipts, []);
  assert.equal(second.action, 'link');
  inspect = false;
  reconnect = true;
  const original = await h.select();
  await original.refresh();
  assert.equal(original.installationId, null);
  assert.deepEqual(original.receipts, []);
  attested = true;
  await original.refresh();
  assert.equal(original.installationId, replies.showA.installationId);
  assert.equal(original.freshness, 'cached');
  assert.equal(original.action, null);
  assert.equal(original.receipts[0].receipt.commentId, fixture.positiveComment.id);
  assert.deepEqual(h.verbs(), [['show'], ['show', '--operation-id', scoped], ['show'], ['show'], ['show']]);
});

test('a receipt accepted before reselection stays recoverable for its original installation', async () => {
  let reply = replies.showA;
  const h = harness(({ project }) => wire(reply, project));
  const first = await h.select();
  await first.refresh();
  assert.equal(first.receipts[0].receipt.commentId, fixture.positiveComment.id);

  reply = replies.showB;
  const replacement = await h.select();
  await replacement.refresh();
  assert.equal(replacement.installationId, replies.showB.installationId);
  assert.deepEqual(replacement.receipts, []);

  reply = uncertain;
  const original = await h.select();
  assert.deepEqual(original.receipts, []);
  await original.refresh();
  assert.equal(original.installationId, replies.showA.installationId);
  assert.equal(original.operation.state, 'published');
  assert.equal(original.receipts[0].receipt.commentId, fixture.positiveComment.id);
  assert.deepEqual(h.verbs(), [['show'], ['show'], ['show']]);
});

test('review regression: a superseded Show cannot resolve the current selection’s uncertainty', async t => {
  for (const oldFirst of [true, false]) {
    await t.test(oldFirst ? 'old positive during new Show before attestation' : 'old positive after new uncertain', async () => {
      const older = { started: delayed(), reply: delayed() };
      const newer = { started: delayed(), reply: delayed() };
      let shows = 0;
      const h = harness(({ project }) => {
        const call = [null, older, newer][shows++];
        if (!call) return wire(uncertain, project);
        call.started.resolve();
        return call.reply.result;
      });
      const first = await h.select();
      await first.refresh();
      const old = first.refresh();
      await older.started.result;
      const current = await h.select();
      const fresh = current.refresh();
      await newer.started.result;
      assert.equal(current.installationId, null);
      assert.equal(current.action, null);
      assert.deepEqual(current.receipts, []);

      const sendOld = async () => {
        older.reply.resolve(wire(replies.showA, scope.project));
        await old;
      };
      if (oldFirst) await sendOld();
      newer.reply.resolve(wire(uncertain, scope.project));
      await fresh;
      if (!oldFirst) await sendOld();

      assert.equal(current.installationId, first.installationId);
      assert.deepEqual({
        state: current.operation.state, action: current.action, receipts: current.receipts.length
      }, { state: 'delivery_uncertain', action: 'check', receipts: 0 });
      assert.equal(first.receipts.length, 0);
      assert.equal(current.handoff, null);
      assert.deepEqual(h.verbs(), [['show'], ['show', '--operation-id', scoped], ['show']]);
    });
  }
});

test('the same UUID and item on another canonical project cannot see the original receipt', async () => {
  const project = 'C:/council-fixtures/another-project';
  const other = { ...scope, project, anchor: project };
  const h = harness(({ project }) => wire(project === scope.project ? replies.showA : {
    ...replies.showA, plane: { ...replies.showA.plane, link: fixture.homonym.link, operation: null }
  }, project));
  const source = await h.select();
  await source.refresh();
  const selected = await h.select(other);
  await selected.refresh();
  assert.equal(source.receipts.length, 1);
  assert.deepEqual(selected.receipts, []);
  assert.equal(selected.link.itemId, fixture.homonym.link.itemId);
  assert.equal(selected.action, 'prepare');
});

test('a reader path change requires a fresh attestation and uses only the verified UUID for receipt recovery', async () => {
  const moved = { ...scope, engine: { ...scope.engine, cli: 'other-launcher/council.js' } };
  let movedReaderAttests = false;
  const h = harness(({ project, engine }) => wire(engine === scope.engine ? replies.showA :
    movedReaderAttests ? { ...replies.showA, plane: { ...replies.showA.plane, freshness: 'cached', operation: null } } :
      replies.showNull, project));
  const first = await h.select();
  await first.refresh();
  assert.equal(first.receipts.length, 1);
  const second = await h.select(moved);
  await second.refresh();
  assert.deepEqual(second.receipts, []);
  movedReaderAttests = true;
  await second.refresh();
  assert.equal(second.installationId, replies.showA.installationId);
  assert.equal(second.receipts[0].receipt.commentId, fixture.positiveComment.id);
  assert.equal(second.action, null);
});

test('a wrong project envelope and a nonmatching operation echo cannot grant a handoff', async () => {
  let correct = false;
  const h = harness(({ project, verb }) => wire(verb === 'show' ? uncertain : replies.openA,
    correct ? project : 'C:/council-fixtures/wrong-project'));
  const current = await h.select();
  await current.refresh();
  assert.equal(current.installationId, null);
  assert.equal(current.action, null);
  correct = true;
  await current.refresh();
  await current.open(current.handoffAction);
  assert.equal(current.handoff, null);
  assert.equal(current.issue, 'unavailable');
  assert.equal(current.operation.state, 'delivery_uncertain');
  assert.deepEqual(h.verbs().slice(-2), [['show', '--operation-id', scoped], ['open', '--operation-id', scoped]]);
});

test('a read without local lifecycle detail retains verified metadata and disables handoff', async () => {
  const h = harness(projectAnswer('showA'));
  const current = await h.select();
  current.screen.item = null;
  current.screen.error = 'The local detail could not be loaded.';
  await current.refresh();
  assert.equal(current.action, null);
  assert.equal(current.operation.receipt.commentId, fixture.positiveComment.id);
  assert.deepEqual(h.verbs(), [['show']]);
});

test('reject unsafe returned commands, opaque references and evidence URLs', async t => {
  const invalidHandoffs = [
    { ...replies.openB.planeHandoff, command: 'unknown command' },
    { ...replies.openB.planeHandoff, localRef: 'https://invalid.example/test' },
    { ...replies.openB.planeHandoff, localRef: 'fixture-scope-item-b\n' }
  ];
  for (const handoff of invalidHandoffs) await t.test('invalid handoff', async () => {
    const h = harness(({ project, verb }) => wire(verb === 'show' ? replies.showB : { ...replies.openB, planeHandoff: handoff }, project));
    const current = await h.select();
    await current.refresh();
    await current.open(current.handoffAction);
    assert.equal(current.handoff, null);
    assert.equal(current.issue, 'unavailable');
    assert.deepEqual(h.verbs(), [['show'], ['open']]);
  });
  const operation = { ...replies.showA.plane.operation, evidenceUrl: fixture.source.evidenceUrl + '\n' };
  const h = harness(({ project }) => wire({ ...replies.showA, plane: { ...replies.showA.plane, operation } }, project));
  const current = await h.select();
  await current.refresh();
  assert.equal(current.operation, null);
  assert.equal(current.action, null);
});

function element(id) {
  const state = { elementId: id, nodes: [], props: {} };
  const builder = new Proxy(state, { get: (target, key) => {
    if (key in target) return target[key];
    if (key === 'when') return (condition, branch) => condition ? branch(builder) : builder;
    if (key === 'child') return child => { target.nodes.push(child); return builder; };
    if (key === 'children') return children => { target.nodes.push(...children); return builder; };
    return value => {
      if (['on_click', 'on_size_change', 'accessibility_label', 'track_focus'].includes(key)) target.props[key] = value;
      if (key === 'id') target.elementId = value;
      return builder;
    };
  } });
  return builder;
}

function find(node, id) {
  if (node?.elementId === id) return node;
  for (const child of node?.nodes ?? []) {
    const result = find(child, id);
    if (result) return result;
  }
  return null;
}

function visibleText(node) {
  return typeof node === 'string' ? [node] : (node?.nodes ?? []).flatMap(visibleText);
}

function renderer() {
  const exports = {
    'gpui-kit': ['div', 'svg'],
    'gpui-base': ['Button', 'Editor', 'Input', 'InputState', 'Textarea', 'TextareaState', 'v_flex', 'h_flex']
  };
  const modules = Object.fromEntries(Object.entries(exports).map(([specifier, names]) => [
    specifier, 'data:text/javascript,' + encodeURIComponent(`export const { ${names.join(', ')} } = globalThis.councilPlaneViewTest;`)
  ]));
  globalThis.councilPlaneViewTest = { div: element, svg: element, h_flex: element, v_flex: element, Button: { new: element } };
  register('data:text/javascript,' + encodeURIComponent(`
    const modules = ${JSON.stringify(modules)};
    export function resolve(specifier, context, next) {
      return modules[specifier] ? { url: modules[specifier], shortCircuit: true } : next(specifier, context);
    }
  `), import.meta.url);
  return import('../herdr/mods/council/work-item-view.js');
}

const planeRenderer = renderer();

async function viewHarness(plane) {
  const { workItemView } = await planeRenderer;
  const tasks = [];
  const clipboard = [];
  const focusChanges = [];
  let focus;
  const cx = {
    focus_handle: () => {
      const handle = { focus: () => { focus = handle; focusChanges.push(handle); }, is_focused: () => focus === handle };
      return handle;
    },
    spawn: action => tasks.push(action(cx)),
    notify() {},
    write_to_clipboard: value => clipboard.push(value)
  };
  const control = id => find(workItemView({}, plane.screen, { focus: {} }, {}), id);
  const settle = () => Promise.all(tasks.splice(0));
  control(`work-item-plane-${plane.viewId}`).props.on_size_change({}, cx);
  await settle();
  return { control, cx, settle, clipboard, focusChanges, focus: () => focus };
}

test('normal Plane controls preserve focus, expose fixed handoff instructions and copy only the opaquely scoped reference', async () => {
  const missing = delayed();
  const h = harness(({ project, verb }) => verb === 'show' ? wire(replies.showB, project) : missing.result);
  const plane = await h.select();
  const { control, cx, settle, clipboard, focus } = await viewHarness(plane);
  assert.equal(control('open-plane-console').props.accessibility_label, 'Link Plane item');
  control('open-plane-console').props.on_click(null, cx);
  assert.equal(focus(), plane.refreshFocus);
  missing.resolve(wire(replies.openB, scope.project));
  await settle();
  const copy = control('copy-plane-reference');
  assert.equal(focus(), plane.referenceFocus);
  assert.match(copy.props.accessibility_label, /fixture-scope-item-b.*authenticated operator session/);
  copy.props.on_click(null, cx);
  h.leave();
  copy.props.on_click(null, cx);
  assert.deepEqual(clipboard, [replies.openB.planeHandoff.localRef]);
  assert.equal(control('publish'), null);
  assert.deepEqual(h.verbs(), [['show'], ['open']]);
});

test('Plane explains a damaged history alongside the original receipt until a fresh healthy Show', async () => {
  const healthy = replies.showA;
  const damaged = { ...healthy, plane: { ...healthy.plane, availability: 'read_only', freshness: 'cached',
    operation: { ...healthy.plane.operation, reason: 'integrity_error' } } };
  const reason = 'Plane updates are read-only because part of the local Plane history could not be verified.';
  let reply = healthy;
  const h = harness(({ project }) => wire(reply, project));
  const plane = await h.select();
  const view = await viewHarness(plane);
  const initial = plane.receipts[0];
  const receiptId = `copy-plane-receipt-${initial.operationId}`;
  const retained = view.control('open-plane-console');
  assert.equal(retained.props.accessibility_label, 'Prepare Plane update');

  reply = damaged;
  await plane.refresh();
  const verifyDamaged = (current, rendered) => {
    assert.deepEqual(current.receipts, [initial]);
    assert.equal(current.receipts[0], initial);
    assert.equal(current.operation, initial);
    assert.equal(initial.reason, null);
    assert.equal(current.freshness, 'cached');
    assert.equal(rendered.control('open-plane-console'), null);
    assert.ok(visibleText(rendered.control(`work-item-plane-${current.viewId}`)).includes(reason));
    assert.equal(rendered.control('refresh-plane').props.accessibility_label, `Refresh Plane status. ${reason} Published`);
    assert.match(rendered.control(receiptId).props.accessibility_label,
      new RegExp(`Copy receipt ID ${initial.receipt.commentId}.*Source: Read-only reconciliation`));
  };
  verifyDamaged(plane, view);
  retained.props.on_click(null, view.cx);
  await view.settle();
  assert.deepEqual(view.focusChanges, []);

  const returned = await h.select();
  const returnedView = await viewHarness(returned);
  verifyDamaged(returned, returnedView);

  reply = healthy;
  await returned.refresh();
  assert.equal(returned.operation, initial);
  assert.equal(returnedView.control('open-plane-console').props.accessibility_label, 'Prepare Plane update');
  assert.ok(!visibleText(returnedView.control(`work-item-plane-${returned.viewId}`)).includes(reason));
  assert.deepEqual(h.verbs(), [['show'], ['show'], ['show'], ['show']]);
});

test('an offline Plane refresh keeps the integrity explanation scoped to the damaged selection', async () => {
  const healthy = replies.showA;
  const damaged = { ...healthy, plane: { ...healthy.plane, availability: 'read_only', freshness: 'cached',
    operation: { ...healthy.plane.operation, reason: 'integrity_error' } } };
  const explanation = 'Plane updates are read-only because part of the local Plane history could not be verified.';
  const offlineMessage = 'Council is offline for this Plane selection.';
  const neighbor = { ...scope, engine: { ...scope.engine, machine: 'neighbor' } };
  const offline = delayed();
  let reply = damaged;
  const h = harness(({ project, engine }) => engine === neighbor.engine ? wire(unavailable('offline'), project, 1) :
    reply ? wire(reply, project) : offline.result);
  const plane = await h.select();
  const view = await viewHarness(plane);
  const initial = plane.receipts[0];
  const receiptControl = `copy-plane-receipt-${initial.operationId}`;
  const panelText = (current, rendered) => visibleText(rendered.control(`work-item-plane-${current.viewId}`)).join(' ');
  const refreshName = rendered => rendered.control('refresh-plane').props.accessibility_label;

  reply = null;
  const refresh = plane.refresh();
  const pendingText = panelText(plane, view);
  const pendingName = refreshName(view);
  offline.resolve(wire(unavailable('offline'), scope.project, 1));
  await refresh;
  for (const text of [panelText(plane, view), refreshName(view)]) {
    assert.ok(text.includes(explanation), text);
    assert.ok(text.includes(offlineMessage), text);
  }
  for (const text of [pendingText, pendingName]) {
    assert.ok(text.includes(explanation), text);
    assert.ok(text.includes('Reading Plane status'), text);
  }
  assert.equal(plane.receipts[0], initial);
  assert.equal(view.control('open-plane-console'), null);
  assert.ok(view.control(receiptControl));

  reply = healthy;
  await plane.refresh();
  assert.equal(plane.receipts[0], initial);
  assert.equal(view.control('open-plane-console').props.accessibility_label, 'Prepare Plane update');
  for (const text of [panelText(plane, view), refreshName(view)]) {
    assert.ok(!text.includes(explanation), text);
    assert.ok(!text.includes(offlineMessage), text);
  }

  reply = damaged;
  await plane.refresh();
  assert.ok(refreshName(view).includes(explanation));
  const other = await h.select(neighbor);
  const otherView = await viewHarness(other);
  for (const text of [panelText(other, otherView), refreshName(otherView)]) {
    assert.ok(!text.includes(explanation), text);
    assert.ok(text.includes(offlineMessage), text);
  }
  assert.deepEqual(other.receipts, []);
  assert.equal(otherView.control('open-plane-console'), null);
  assert.deepEqual(h.verbs(), [['show'], ['show'], ['show'], ['show'], ['show']]);
});

test('review regression: A’s retained Prepare has no effect when B offers the same action', async () => {
  const linkedB = { ...replies.showB, plane: { ...replies.showB.plane, link: fixture.homonym.link } };
  let current = 'A';
  const h = harness(({ project, verb }) => wire(
    verb === 'open' ? replies[`open${current}`] : current === 'A' ? replies.showA : linkedB, project));
  const plane = await h.select();
  const { control, cx, settle, focusChanges } = await viewHarness(plane);
  const retained = control('open-plane-console');
  assert.equal(retained.props.accessibility_label, 'Prepare Plane update');
  current = 'B';
  await plane.refresh();
  assert.equal(plane.installationId, replies.showB.installationId);
  assert.equal(control('open-plane-console').props.accessibility_label, 'Prepare Plane update');

  retained.props.on_click(null, cx);
  await settle();
  assert.deepEqual({
    calls: h.verbs().filter(([verb]) => verb === 'open').length,
    focusChanges: focusChanges.length, ref: plane.handoff?.localRef ?? null
  }, { calls: 0, focusChanges: 0, ref: null });
  assert.equal(control('copy-plane-reference'), null);

  control('open-plane-console').props.on_click(null, cx);
  await settle();
  assert.deepEqual(h.verbs(), [['show'], ['show'], ['show'], ['open']]);
  assert.equal(plane.handoff.localRef, replies.openB.planeHandoff.localRef);
});

test('a refreshed projection invalidates the old Prepare callback with the same UUID and action', async () => {
  const h = harness(({ project, verb }) => wire(replies[verb === 'show' ? 'showA' : 'openA'], project));
  const plane = await h.select();
  const { control, cx, settle, focusChanges } = await viewHarness(plane);
  const retained = control('open-plane-console');
  await plane.refresh();
  retained.props.on_click(null, cx);
  await settle();
  assert.deepEqual(h.verbs(), [['show'], ['show']]);
  assert.deepEqual(focusChanges, []);
  assert.equal(plane.handoff, null);
  control('open-plane-console').props.on_click(null, cx);
  await settle();
  assert.equal(plane.handoff.localRef, replies.openA.planeHandoff.localRef);
});
