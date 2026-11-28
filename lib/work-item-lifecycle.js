import { randomUUID } from 'node:crypto';
import { LifecycleStore, hashTuple } from '../herdr/mods/council/runtime/work-item-lifecycle-store.mjs';
import { WorkItemStore, itemIdPattern } from '../herdr/mods/council/runtime/work-item-store.mjs';
import { JobManager } from './jobs.js';
import { sanitizeName } from './workspace.js';
import { callTeamMember } from './team.js';
import { archiveFormal, displayReview, freezeCapture, observeFormal, verifyCaptureSource } from './work-item-review.js';

const priorities = ['none', 'low', 'medium', 'high', 'urgent'];
const requestPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).every(key => keys.includes(key));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const definitionDigest = definition => hashTuple([definition.title, definition.roleId, definition.criteria]);
const workDefinition = item => ({ title: item.title, roleId: item.roleId, criteria: item.criteria });
const requestDigest = (type, request) => hashTuple([type, request]);

function validFormalRecord(formal) {
  if (!formal || !exact(formal, ['sessionId', 'round', 'state', 'verdict', 'proposalSha256', 'manifestSha256', 'dissent', 'manifest']) ||
      typeof formal.sessionId !== 'string' || (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(formal.sessionId) || sanitizeName(formal.sessionId) !== formal.sessionId) ||
      !Number.isSafeInteger(formal.round) || formal.round < 1 ||
      !['pending', 'provisional', 'rejected', 'approved', 'unverified'].includes(formal.state) ||
      (formal.verdict !== null && typeof formal.verdict !== 'string') ||
      (formal.proposalSha256 !== null && !/^[a-f0-9]{64}$/.test(formal.proposalSha256)) ||
      (formal.manifestSha256 !== null && !/^[a-f0-9]{64}$/.test(formal.manifestSha256)) ||
      !Array.isArray(formal.dissent) || formal.dissent.some(entry => !entry || typeof entry.voter !== 'string' ||
        !['reject', 'amend'].includes(entry.vote) || typeof entry.rationale !== 'string')) return false;
  if (formal.manifestSha256 !== null) {
    if (!Array.isArray(formal.manifest) || hashTuple(formal.manifest) !== formal.manifestSha256 || formal.manifest.some(entry =>
      !Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== 'string' ||
      entry[0].split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(entry[1]) ||
      !Number.isSafeInteger(entry[2]) || entry[2] < 0 || entry[2] > 16 * 1024 * 1024)) return false;
    const paths = formal.manifest.map(entry => entry[0]);
    if (new Set(paths).size !== paths.length || !same(paths, [...paths].sort())) return false;
  } else if (formal.manifest !== undefined) return false;
  if (formal.state === 'approved' && (!formal.manifestSha256 || !formal.proposalSha256 || !['validated', 'conditional'].includes(formal.verdict))) return false;
  return true;
}

function applyEvent(state, event, ctx) {
  const { data, type } = event;
  const baseFields = ['request', 'cycle', 'workRevision'];
  const extra = { triaged: [], attempt_reserved: ['definition', 'definitionSha256', 'sessionId', 'timeoutSec'],
    review_started: ['review'], review_note: [], formal_attached: ['formal'],
    review_returned: ['decision'], closed: ['decision'], reopened: [] };
  if (!Object.hasOwn(extra, type) || !exact(data, [...baseFields, ...extra[type]]) ||
      !data.request || requestDigest(type, data.request) !== event.requestSha256 ||
      data.request.id !== event.id || data.request.ifRevision !== event.expectedRevision || data.request.actor !== event.actor) {
    throw new Error('Event request binding is invalid.');
  }
  const normalized = normalizedMutation(type, { ...data.request, requestId: event.requestId }, ctx);
  if (!same(normalized.request, data.request) || normalized.requestSha256 !== event.requestSha256) throw new Error('Event request is not normalized.');
  if (type === 'triaged') {
    if (state.state !== 'open' || !exact(data.request, ['id', 'ifRevision', 'actor', 'patch']) ||
        !exact(data.request.patch, ['title', 'roleId', 'criteria', 'priority', 'blockedBy', 'nextAction'])) throw new Error('Invalid triage transition.');
    const patch = data.request.patch;
    if (!Object.keys(patch).length || (state.attempt && ['title', 'roleId', 'criteria'].some(key => Object.hasOwn(patch, key)))) throw new Error('Invalid triage patch.');
    const next = { ...state.definition };
    for (const field of ['title', 'roleId', 'criteria']) if (Object.hasOwn(patch, field)) next[field] = patch[field];
    if (!same(next, state.definition)) { state.workRevision++; state.definition = next; }
    for (const field of ['priority', 'blockedBy', 'nextAction']) if (Object.hasOwn(patch, field)) state[field] = patch[field];
  } else if (type === 'attempt_reserved') {
    if (state.state !== 'open' || state.attempt || !exact(data.request, ['id', 'ifRevision', 'actor', 'timeoutSec']) ||
        data.cycle !== state.cycle || data.workRevision !== state.workRevision || !same(data.definition, state.definition) ||
        data.definitionSha256 !== definitionDigest(state.definition) || data.timeoutSec !== data.request.timeoutSec ||
        !/^wi-job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.sessionId)) throw new Error('Invalid attempt reservation.');
    state.attempt = { sessionId: data.sessionId, roleId: state.definition.roleId, timeoutSec: data.timeoutSec,
      binding: { cycle: data.cycle, workRevision: data.workRevision, definitionSha256: data.definitionSha256 } };
  } else if (type === 'review_started') {
    const review = data.review;
    if (state.state !== 'open' || !state.attempt || !exact(review, ['id','cycle','workRevision','reviewOwnerRoleId','policy','definition','definitionSha256','snapshot','snapshotSha256','capture','notes','formal','startedAt']) ||
        !exact(review.capture, ['sessionId','sha256','byteCount','source','captureScope','turn','completedAt']) ||
        review.capture.sessionId !== state.attempt.sessionId || review.id !== `review-${event.revision}` ||
        review.cycle !== state.cycle || review.workRevision !== state.workRevision ||
        review.reviewOwnerRoleId !== data.request.reviewOwnerRoleId || review.policy !== data.request.policy || review.startedAt !== event.at ||
        (state.formalRequired && review.policy !== 'formal') || !same(review.definition, state.definition) ||
        review.definitionSha256 !== definitionDigest(state.definition) || !Array.isArray(review.snapshot) ||
        hashTuple(review.snapshot) !== review.snapshotSha256 || !same(review.snapshot,
          ['council.work-item-review-snapshot/v2', event.id, state.cycle, state.workRevision, review.id,
            review.reviewOwnerRoleId, review.policy, review.definitionSha256, state.attempt.sessionId,
            review.capture?.sha256, review.capture?.byteCount, review.capture?.source, review.capture?.captureScope,
            review.capture?.turn, review.capture?.completedAt]) ||
        !/^[a-f0-9]{64}$/.test(review.capture?.sha256 ?? '') || !Number.isSafeInteger(review.capture?.byteCount) ||
        review.capture.byteCount < 0 || review.capture.byteCount > 16 * 1024 * 1024 ||
        !['terminal_screen', 'direct_artifact'].includes(review.capture?.source) || !Array.isArray(review.notes) || review.notes.length || review.formal !== null) throw new Error('Invalid review freeze.');
    state.review = review;
    state.reviews.push(review);
    state.state = 'in_review';
    state.formalRequired ||= review.policy === 'formal';
  } else if (type === 'review_note') {
    if (state.state !== 'in_review' || state.review?.id !== data.request.reviewId || state.review.notes.length >= 50) throw new Error('Invalid review note.');
    state.review.notes.push({ kind: data.request.kind, actor: event.actor, text: data.request.text, at: event.at, revision: event.revision });
  } else if (type === 'formal_attached') {
    if (state.state !== 'in_review' || state.review?.id !== data.request.reviewId || state.review.policy !== 'formal' || state.review.formal ||
        !validFormalRecord(data.formal) || data.formal.sessionId !== data.request.formalSessionId || data.formal.round !== data.request.round) throw new Error('Invalid formal attachment.');
    state.review.formal = data.formal;
  } else if (type === 'closed' || type === 'review_returned') {
    const decision = data.decision;
    if (state.state !== 'in_review' || state.review?.id !== data.request.reviewId || !decision ||
        decision.id !== `decision-${event.revision}` || decision.reviewId !== state.review.id || decision.cycle !== state.cycle ||
        decision.workRevision !== state.workRevision || decision.snapshotSha256 !== state.review.snapshotSha256 ||
        decision.evidenceToken !== data.request.evidenceToken || decision.actor !== event.actor || decision.at !== event.at ||
        decision.disposition !== (type === 'closed' ? 'accepted' : 'changes_requested') ||
        decision.reason !== data.request.reason || decision.nextAction !== data.request.nextAction ||
        (state.review.policy === 'operator' && decision.formal !== null) ||
        (state.review.policy === 'formal' && !state.review.formal && decision.formal !== null) ||
        (decision.formal !== null && !validFormalRecord(decision.formal)) ||
        (state.review.formal && (decision.formal?.sessionId !== state.review.formal.sessionId || decision.formal?.round !== state.review.formal.round)) ||
        (type === 'closed' && state.review.policy === 'formal' && decision.formal?.state !== 'approved') ||
        decision.evidenceToken !== hashTuple([state.review.snapshotSha256,
          state.review.policy === 'operator' ? 'operator' : decision.formal?.state ?? 'pending',
          state.review.policy === 'operator' ? null : decision.formal?.manifestSha256 ?? null])) throw new Error('Invalid decision.');
    state.decision = decision;
    state.review.decision = decision;
    if (state.review.policy === 'formal') state.review.formal = decision.formal;
    state.nextAction = decision.nextAction;
    if (type === 'closed') state.state = 'closed';
    else {
      state.cycle++;
      state.workRevision++;
      state.definition = { ...state.definition, roleId: data.request.roleId };
      state.attempt = null;
      state.review = null;
      state.state = 'open';
    }
  } else if (type === 'reopened') {
    if (state.state !== 'closed' || state.decision?.id !== data.request.decisionId ||
        state.decision.snapshotSha256 !== data.request.snapshotSha256) throw new Error('Invalid reopen transition.');
    state.cycle++;
    state.workRevision++;
    state.definition = { ...state.definition, roleId: data.request.roleId };
    state.attempt = null;
    state.review = null;
    state.nextAction = data.request.nextAction;
    state.state = 'open';
  } else {
    throw new Error(`Unsupported lifecycle event: ${type}.`);
  }
}

export function loadLifecycle(store, item, ctx) {
  const definitionBytes = store.readRaw(item.id, 1);
  const journal = new LifecycleStore(store, item.id);
  let slotBytes;
  let unreadableSlot = false;
  try { slotBytes = store.readRaw(item.id, 2); }
  catch (error) {
    if (error.code) throw error;
    slotBytes = null;
    unreadableSlot = true;
  }
  let slot;
  try { slot = slotBytes ? store.read(item.id, 2) : null; } catch { slot = { invalid: true }; }
  const isMarker = slot && journal.validMarker(slot, definitionBytes);
  const legacy = !isMarker && slotBytes ? ctx.loadIntent(store, item) : null;
  const damaged = unreadableSlot || Boolean(slotBytes && !isMarker && (!legacy || legacy.invalid));
  const state = {
    revision: legacy && !legacy.invalid ? 2 : 1, workRevision: 1, cycle: 1,
    managed: Boolean(isMarker), state: 'open', definition: workDefinition(item), priority: 'none',
    blockedBy: [], nextAction: null, attempt: damaged ? { invalid: true } : legacy && !legacy.invalid ? legacy : null,
    review: null, reviews: [], decision: null, formalRequired: false, integrity: damaged
      ? { code: 'integrity_error', message: 'Inspect the damaged dispatch intent in this project.' } : null,
    events: [], journal, definitionBytes, slotBytes
  };
  if (slotBytes && !damaged) {
    let result;
    try { result = journal.read(state.revision, definitionBytes, slotBytes, event => {
      // Failed semantic validation must not mutate the validated prefix.
      const reviews = structuredClone(state.reviews);
      const draft = { ...state, definition: structuredClone(state.definition), blockedBy: [...state.blockedBy],
        reviews, review: state.review ? reviews.find(review => review.id === state.review.id) : null,
        decision: state.decision ? structuredClone(state.decision) : null,
        attempt: state.attempt ? structuredClone(state.attempt) : null };
      applyEvent(draft, event, ctx);
      if (event.data.cycle !== draft.cycle || event.data.workRevision !== draft.workRevision) throw new Error('Event cycle or work revision is invalid.');
      Object.assign(state, draft);
    }); } catch (error) {
      if (error.code) throw error;
      result = { revision: state.revision, events: [], integrity: { code: 'integrity_error', message: `Unreadable lifecycle journal: ${error.message}` } };
    }
    state.revision = result.revision;
    state.previousSha256 = result.previousSha256;
    state.events = result.events;
    state.integrity = result.integrity;
    state.managed ||= result.events.length > 0;
  } else if (!slotBytes && !damaged) {
    try {
      if (journal.directory()) state.integrity = { code: 'integrity_error', message: 'Lifecycle journal is missing its baseline slot.' };
    } catch (error) {
      if (error.code) throw error;
      state.integrity = { code: 'integrity_error', message: 'Lifecycle journal is unreadable.' };
    }
  }
  return state;
}

function normalizedMutation(type, input, ctx) {
  const common = ['id', 'ifRevision', 'requestId', 'actor'];
  const extraFields = {
    triaged: ['patch'], attempt_reserved: ['timeoutSec'], review_started: ['reviewOwnerRoleId', 'policy'],
    review_note: ['reviewId', 'kind', 'text'], formal_attached: ['reviewId', 'formalSessionId', 'round'],
    review_returned: ['reviewId', 'evidenceToken', 'reason', 'roleId', 'nextAction'],
    closed: ['reviewId', 'evidenceToken', 'decision', 'reason', 'nextAction'],
    reopened: ['decisionId', 'snapshotSha256', 'reason', 'roleId', 'nextAction']
  };
  if (!Object.hasOwn(extraFields, type)) ctx.fail('invalid_input', 'Unknown lifecycle operation.');
  const allowed = [...common, ...extraFields[type]];
  if (!exact(input, allowed) || !itemIdPattern.test(input.id ?? '') || !Number.isSafeInteger(input.ifRevision) || input.ifRevision < 1 ||
      typeof input.requestId !== 'string' || !requestPattern.test(input.requestId)) ctx.fail('invalid_input', 'Invalid lifecycle mutation fields.');
  const request = { id: input.id, ifRevision: input.ifRevision, actor: ctx.text(input.actor, 'actor', 120) };
  if (type === 'triaged') {
    if (!exact(input.patch, ['title', 'roleId', 'criteria', 'priority', 'blockedBy', 'nextAction']) || !Object.keys(input.patch).length) ctx.fail('invalid_input', 'Provide a valid triage patch.');
    const patch = {};
    if (Object.hasOwn(input.patch, 'title')) patch.title = ctx.text(input.patch.title, 'title', 160);
    if (Object.hasOwn(input.patch, 'roleId')) {
      if (typeof input.patch.roleId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(input.patch.roleId)) ctx.fail('invalid_input', 'Invalid role ID.');
      patch.roleId = input.patch.roleId;
    }
    if (Object.hasOwn(input.patch, 'criteria')) {
      if (!Array.isArray(input.patch.criteria) || input.patch.criteria.length < 1 || input.patch.criteria.length > 12) ctx.fail('invalid_input', 'Provide 1 to 12 criteria.');
      patch.criteria = input.patch.criteria.map(value => ctx.text(value, 'criterion', 500));
    }
    if (Object.hasOwn(input.patch, 'priority')) {
      if (!priorities.includes(input.patch.priority)) ctx.fail('invalid_input', 'Invalid priority.');
      patch.priority = input.patch.priority;
    }
    if (Object.hasOwn(input.patch, 'blockedBy')) {
      const ids = input.patch.blockedBy;
      if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !itemIdPattern.test(id) || id === input.id) || new Set(ids).size !== ids.length) ctx.fail('invalid_input', 'Invalid blocker links.');
      patch.blockedBy = [...ids].sort();
    }
    if (Object.hasOwn(input.patch, 'nextAction')) patch.nextAction = ctx.text(input.patch.nextAction, 'next action', 500);
    request.patch = patch;
  } else if (type === 'attempt_reserved') {
    const timeout = input.timeoutSec ?? 180;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) ctx.fail('invalid_input', 'Timeout must be an integer from 1 to 3600.');
    request.timeoutSec = timeout;
  } else {
    const checkRole = value => {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) ctx.fail('invalid_input', 'Invalid role ID.');
      return value;
    };
    const checkReview = value => {
      if (typeof value !== 'string' || !/^review-[1-9][0-9]*$/.test(value)) ctx.fail('invalid_input', 'Invalid review ID.');
      return value;
    };
    const checkDigest = value => {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) ctx.fail('invalid_input', 'Invalid evidence digest.');
      return value;
    };
    if (type === 'review_started') {
      request.reviewOwnerRoleId = checkRole(input.reviewOwnerRoleId);
      if (!['operator', 'formal'].includes(input.policy)) ctx.fail('invalid_input', 'Invalid review policy.');
      request.policy = input.policy;
    } else if (type === 'reopened') {
      if (typeof input.decisionId !== 'string' || !/^decision-[1-9][0-9]*$/.test(input.decisionId)) ctx.fail('invalid_input', 'Invalid decision ID.');
      request.decisionId = input.decisionId;
      request.snapshotSha256 = checkDigest(input.snapshotSha256);
      request.reason = ctx.text(input.reason, 'reason', 500);
      request.roleId = checkRole(input.roleId);
      request.nextAction = ctx.text(input.nextAction, 'next action', 500);
    } else {
      request.reviewId = checkReview(input.reviewId);
      if (type === 'review_note') {
        if (!['finding', 'dissent'].includes(input.kind)) ctx.fail('invalid_input', 'Invalid note kind.');
        request.kind = input.kind;
        request.text = ctx.text(input.text, 'note', 500);
      } else if (type === 'formal_attached') {
        if (typeof input.formalSessionId !== 'string' || (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.formalSessionId) || sanitizeName(input.formalSessionId) !== input.formalSessionId)) ctx.fail('invalid_input', 'Invalid formal session ID.');
        if (!Number.isSafeInteger(input.round) || input.round < 1) ctx.fail('invalid_input', 'Invalid formal round.');
        request.formalSessionId = input.formalSessionId;
        request.round = input.round;
      } else {
        request.evidenceToken = checkDigest(input.evidenceToken);
        if (type === 'closed') {
          if (input.decision !== 'accept') ctx.fail('invalid_input', 'An explicit acceptance is required.');
          request.decision = input.decision;
        }
        request.reason = ctx.text(input.reason, 'reason', 500);
        if (type === 'review_returned') request.roleId = checkRole(input.roleId);
        request.nextAction = ctx.text(input.nextAction, 'next action', 500);
      }
    }
  }
  return { request, requestId: input.requestId, requestSha256: requestDigest(type, request) };
}

function currentFormal(store, review) {
  const observed = observeFormal(store, review.formal.sessionId, review.formal.round, review.snapshotSha256);
  if (observed.state !== 'unverified') return observed;
  // Retain the last recorded verdict and dissent as historical information while
  // clearly marking the current observation unverified.
  return { ...observed, verdict: observed.verdict ?? review.formal.verdict ?? null,
    dissent: observed.dissent?.length ? observed.dissent : review.formal.dissent ?? [] };
}

export async function mutateLifecycle(type, input, options, ctx) {
  const normalized = normalizedMutation(type, input, ctx);
  const store = new WorkItemStore(options.project);
  const item = ctx.loadDefinition(store, input.id);
  let state = loadLifecycle(store, item, ctx);
  const replay = state.events.find(event => event.requestId === normalized.requestId);
  if (replay) {
    if (replay.requestSha256 !== normalized.requestSha256 || replay.type !== type) ctx.conflict(state.revision, 'Request ID was used for different input.');
    return { store, item, state, receipt: { requestId: replay.requestId, event: replay.type, revision: replay.revision, replay: true } };
  }
  if (state.integrity) ctx.fail('integrity_error', state.integrity.message);
  if (state.revision !== input.ifRevision) ctx.conflict(state.revision);
  const request = normalized.request;
  if (type === 'triaged' || type === 'attempt_reserved' || type === 'review_started') {
    if (state.state !== 'open') ctx.fail('invalid_transition', 'This item is not open.');
    if (type === 'triaged') {
      if (state.attempt && ['title', 'roleId', 'criteria'].some(key => Object.hasOwn(request.patch, key))) ctx.conflict(state.revision, 'The current attempt has an immutable definition.');
      if (request.patch.roleId) ctx.role(store, request.patch.roleId);
    } else if (type === 'attempt_reserved') {
      if (state.attempt) ctx.conflict(state.revision, 'This cycle already has an attempt.');
      ctx.role(store, state.definition.roleId);
    } else {
      if (!state.attempt) ctx.fail('invalid_transition', 'A completed attempt is required.');
      if (state.formalRequired && request.policy !== 'formal') ctx.fail('review_not_authorized', 'A formal review is required for this item.');
      ctx.role(store, request.reviewOwnerRoleId);
    }
  } else if (type === 'reopened') {
    if (state.state !== 'closed' || state.decision?.id !== request.decisionId || state.decision?.snapshotSha256 !== request.snapshotSha256) ctx.fail('invalid_transition', 'Confirm the current close decision and snapshot.');
    ctx.role(store, request.roleId);
  } else {
    if (state.state !== 'in_review' || state.review?.id !== request.reviewId) ctx.fail('invalid_transition', 'The specified review is not current.');
    if (type === 'review_note' && state.review.notes.length >= 50) ctx.fail('invalid_transition', 'The review already has 50 notes.');
    if (type === 'formal_attached' && (state.review.policy !== 'formal' || state.review.formal)) ctx.fail('invalid_transition', 'This review cannot attach another formal round.');
    if (type === 'formal_attached' && !displayReview(store, item.id, state.review).capture.verified) ctx.fail('stale_evidence', 'The frozen capture cannot be verified.');
    if ((type === 'closed' || type === 'review_returned') && state.review.policy === 'formal' && state.review.formal) {
      state.review.formal = currentFormal(store, state.review);
    }
    if (type === 'closed' || type === 'review_returned') {
      const view = displayReview(store, item.id, state.review);
      if (!view.evidenceToken || view.evidenceToken !== request.evidenceToken) ctx.fail('stale_evidence', 'Refresh and confirm the current review evidence.');
      if (type === 'closed' && state.review.policy === 'formal' && state.review.formal?.state !== 'approved') ctx.fail('review_not_authorized', 'The current formal review is not approved.');
      if (type === 'review_returned') ctx.role(store, request.roleId);
    }
  }
  if (!state.slotBytes) {
    try { state.journal.activate(state.definitionBytes); } catch { /* Re-read the common slot before reporting an error. */ }
    state = loadLifecycle(store, item, ctx);
    if (!state.slotBytes) ctx.fail('storage_error', 'Could not publish the lifecycle marker. Check filesystem hard-link support.');
    if (state.integrity) ctx.fail('integrity_error', state.integrity.message);
    if (state.revision !== input.ifRevision) ctx.conflict(state.revision);
  }
  const nextCycle = state.cycle + (['reopened', 'review_returned'].includes(type) ? 1 : 0);
  const changedDefinition = type === 'triaged' && ['title', 'roleId', 'criteria'].some(key =>
    Object.hasOwn(request.patch, key) && !same(request.patch[key], state.definition[key]));
  const nextWorkRevision = state.workRevision + (changedDefinition || ['reopened', 'review_returned'].includes(type) ? 1 : 0);
  if (state.revision >= 99999999) ctx.fail('storage_error', 'The lifecycle journal reached its revision limit.');
  const data = { request: normalized.request, cycle: nextCycle, workRevision: nextWorkRevision };
  const at = new Date().toISOString();
  if (type === 'attempt_reserved') {
    Object.assign(data, { cycle: state.cycle, workRevision: state.workRevision, definition: state.definition,
      definitionSha256: definitionDigest(state.definition), sessionId: `wi-job-${randomUUID()}`, timeoutSec: normalized.request.timeoutSec });
  }
  if (type === 'formal_attached') {
    const observed = observeFormal(store, request.formalSessionId, request.round, state.review.snapshotSha256);
    if (!observed.proposalSha256) ctx.fail('integrity_error', 'The formal round and bound proposal could not be verified.');
    data.formal = archiveFormal(store, item.id, observed);
  }
  if (type === 'review_started') {
    data.review = freezeCapture(store, item, state, `review-${state.revision + 1}`, request.reviewOwnerRoleId, request.policy, ctx);
    data.review.startedAt = at;
  }
  if (type === 'closed' || type === 'review_returned') {
    data.decision = { id: `decision-${state.revision + 1}`, reviewId: state.review.id, cycle: state.cycle,
      workRevision: state.workRevision, disposition: type === 'closed' ? 'accepted' : 'changes_requested',
      actor: request.actor, reason: request.reason, nextAction: request.nextAction, at,
      snapshotSha256: state.review.snapshotSha256, evidenceToken: request.evidenceToken,
      formal: state.review.formal ? archiveFormal(store, item.id, state.review.formal) : null };
  }
  const event = { $schema: 'council.work-item-event/v2', id: item.id, revision: state.revision + 1,
    expectedRevision: state.revision, previousSha256: state.previousSha256, requestId: normalized.requestId,
    requestSha256: normalized.requestSha256, at, actor: normalized.request.actor, type, data };
  if (type === 'review_started' && !verifyCaptureSource(store, item, state, data.review, ctx)) {
    ctx.fail('stale_evidence', 'The handoff changed while preparing the review. Refresh and retry.');
  }
  if (type === 'formal_attached') {
    const current = observeFormal(store, request.formalSessionId, request.round, state.review.snapshotSha256);
    if (current.state !== data.formal.state || current.manifestSha256 !== data.formal.manifestSha256 || current.proposalSha256 !== data.formal.proposalSha256) {
      ctx.fail('stale_evidence', 'Formal evidence changed while attaching it. Refresh and retry.');
    }
  }
  if (type === 'closed' || type === 'review_returned') {
    const currentReview = displayReview(store, item.id, state.review);
    if (!currentReview.evidenceToken || currentReview.evidenceToken !== request.evidenceToken) {
      ctx.fail('stale_evidence', 'Frozen evidence changed. Refresh and confirm it again.');
    }
  }
  if ((type === 'closed' || type === 'review_returned') && state.review?.formal) {
    const current = observeFormal(store, state.review.formal.sessionId, state.review.formal.round, state.review.snapshotSha256);
    if (current.state !== state.review.formal.state || current.manifestSha256 !== state.review.formal.manifestSha256) {
      ctx.fail('stale_evidence', 'Formal evidence changed. Refresh and confirm it again.');
    }
  }
  let won = false;
  try { won = state.journal.append(event); } catch { /* Reconcile the event before any dispatch. */ }
  const latest = loadLifecycle(store, item, ctx);
  const committed = latest.events.find(entry => entry.requestId === normalized.requestId);
  if (won && (!committed || committed.requestSha256 !== normalized.requestSha256 || latest.integrity)) {
    ctx.fail('integrity_error', 'The published event could not be verified. Inspect the item before any dispatch.');
  }
  if (!won) {
    if (committed && committed.requestSha256 === normalized.requestSha256 && committed.type === type) {
      return { store, item, state: latest, receipt: { requestId: committed.requestId, event: type, revision: committed.revision, replay: true } };
    }
    if (latest.revision !== state.revision) ctx.conflict(latest.revision);
    ctx.fail('storage_error', 'Could not publish the lifecycle event. Inspect the item and filesystem.');
  }
  if (type === 'attempt_reserved') {
    const brief = `Work item ${item.id}: ${state.definition.title}\n\nAcceptance criteria:\n${state.definition.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}\n\nProvide a handoff covering the criteria and any remaining steps.`;
    try {
      await (options.callTeamMember ?? callTeamMember)(options.manager ?? new JobManager({ cwd: store.root }), {
        member: state.definition.roleId, task: brief, sessionId: data.sessionId, timeoutSec: data.timeoutSec,
        workItemId: item.id, workItemBinding: { cycle: data.cycle, workRevision: data.workRevision, definitionSha256: data.definitionSha256 }
      });
    } catch { /* An acknowledged reservation never authorizes replay. */ }
  }
  return { store, item, state: loadLifecycle(store, item, ctx), receipt: { requestId: event.requestId, event: type, revision: event.revision, replay: false } };
}

export function lifecycleView(store, item, ctx, { summary = false, observation, state: loadedState } = {}) {
  const state = loadedState ?? loadLifecycle(store, item, ctx);
  const effective = { ...item, ...state.definition };
  const sameAttempt = observation && state.attempt && observation.sessionId === state.attempt.sessionId &&
    observation.cycle === state.cycle &&
    (observation.status?.sessionId === undefined || observation.status.sessionId === observation.sessionId);
  let execution = ctx.project(store, effective, state.attempt, sameAttempt ? observation.status : undefined, !summary);
  if (state.integrity && !['needs_attention', 'result_ready'].includes(execution.state)) {
    execution = { ...execution, state: 'needs_attention', nextAction: state.integrity.message,
      canDelegate: false, attention: state.integrity };
  }
  const blockers = state.blockedBy.map(id => {
    try {
      const target = ctx.loadDefinition(store, id);
      const targetState = loadLifecycle(store, target, ctx);
      if (targetState.integrity) throw new Error('Unreadable blocker');
      return { id, title: targetState.definition.title, state: targetState.state };
    } catch { return { id, title: null, state: 'unavailable' }; }
  });
  let activeReview = state.review;
  if (!summary && state.state === 'in_review' && activeReview?.formal) {
    const observed = currentFormal(store, activeReview);
    activeReview = { ...activeReview, formal: observed };
  }
  const review = activeReview ? (summary ? activeReview : displayReview(store, item.id, activeReview)) : null;
  const reviewState = review ? review.policy === 'operator' ? 'operator' : review.formal?.state ?? 'pending' : null;
  const broken = Boolean(state.integrity || execution.attention || blockers.some(blocker => blocker.state !== 'closed') ||
    (!summary && review && (!review.capture.verified || !review.evidenceToken)) || ['provisional', 'rejected', 'unverified'].includes(reviewState));
  const open = state.state === 'open' && !state.integrity;
  const inReview = state.state === 'in_review' && !state.integrity;
  const lifecycle = {
    revision: state.revision, workRevision: state.workRevision, cycle: state.cycle, managed: state.managed,
    state: state.state, priority: state.priority, blockedBy: blockers, nextAction: state.nextAction,
    guidance: state.integrity?.message ?? (state.state === 'closed' ? 'Reopen if more work is needed.' :
      inReview && ['provisional', 'rejected', 'unverified'].includes(reviewState) ? 'Inspect the formal verdict or return the review for changes.' :
      inReview ? 'Review the frozen capture and record a decision.' : execution.nextAction),
    needsAttention: broken, reviewState
  };
  if (!summary) {
    const verified = Boolean(review?.capture.verified && review?.evidenceToken);
    lifecycle.actions = { triage: open, editDefinition: open && !state.attempt, delegate: open && !state.attempt,
      startReview: open && execution.state === 'result_ready', addNote: inReview,
      attachFormal: inReview && verified && review?.policy === 'formal' && !review.formal,
      close: inReview && verified && (review?.policy === 'operator' || review?.formal?.state === 'approved'),
      returnForChanges: inReview && verified, reopen: state.state === 'closed' && !state.integrity };
    lifecycle.formalRequired = state.formalRequired;
    lifecycle.integrity = state.integrity ?? (review && (!review.capture.verified || !review.evidenceToken) ? { code: 'integrity_error', message: 'Frozen review evidence cannot be verified.' } : null);
    lifecycle.review = review;
    lifecycle.decision = state.decision;
  }
  return { ...effective, $schema: undefined, ...execution, canDelegate: state.managed || state.integrity ? false : execution.canDelegate, lifecycle };
}

export function lifecycleHistory(store, item, input, ctx) {
  if (!exact(input, ['id', 'beforeRevision', 'limit', 'requestId']) ||
      (input.beforeRevision !== undefined && (!Number.isSafeInteger(input.beforeRevision) || input.beforeRevision < 1)) ||
      (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) ||
      (input.requestId !== undefined && (typeof input.requestId !== 'string' || !requestPattern.test(input.requestId) || input.beforeRevision !== undefined || input.limit !== undefined))) {
    ctx.fail('invalid_input', 'Invalid history request.');
  }
  const state = loadLifecycle(store, item, ctx);
  if (input.requestId !== undefined) {
    const event = state.events.find(entry => entry.requestId === input.requestId);
    if (!event && state.integrity) ctx.fail('integrity_error', 'Cannot determine whether this request was committed because the journal is damaged.');
    return { success: true, project: store.root, id: item.id,
      receipt: event ? { requestId: event.requestId, event: event.type, revision: event.revision, replay: true } : null };
  }
  const events = [{ revision: 1, type: 'created', actor: null, at: item.createdAt, requestId: null,
    cycle: 1, workRevision: 1, references: {} }];
  let slot;
  try { slot = store.read(item.id, 2); } catch { slot = null; }
  if (slot?.$schema === 'council.work-item-dispatch/v1') events.push({
    revision: 2, type: 'attempt_reserved', actor: null, at: slot.createdAt, requestId: null,
    cycle: 1, workRevision: 1, references: { sessionId: slot.sessionId }
  });
  for (const event of state.events) {
    const references = {};
    for (const name of ['sessionId', 'reviewId', 'decisionId', 'definitionSha256', 'snapshotSha256', 'formal']) {
      if (event.data[name] !== undefined) references[name] = event.data[name];
    }
    if (event.data.request.reviewId) references.reviewId = event.data.request.reviewId;
    if (event.data.review) {
      references.reviewId = event.data.review.id;
      references.snapshotSha256 = event.data.review.snapshotSha256;
      references.sessionId = event.data.review.capture.sessionId;
    }
    if (event.data.decision) {
      references.decisionId = event.data.decision.id;
      references.reviewId = event.data.decision.reviewId;
      references.snapshotSha256 = event.data.decision.snapshotSha256;
      references.formal = event.data.decision.formal;
    }
    if (event.type === 'reopened') {
      references.decisionId = event.data.request.decisionId;
      references.snapshotSha256 = event.data.request.snapshotSha256;
      const prior = state.reviews.find(review => review.decision?.id === event.data.request.decisionId);
      if (prior) references.reviewId = prior.id;
    }
    events.push({ revision: event.revision, type: event.type, actor: event.actor, at: event.at,
      requestId: event.requestId, cycle: event.data.cycle ?? 1, workRevision: event.data.workRevision ?? 1, references });
  }
  const filtered = events.filter(event => input.beforeRevision === undefined || event.revision < input.beforeRevision).reverse();
  const limit = input.limit ?? 30;
  const page = filtered.slice(0, limit);
  return { success: true, project: store.root, id: item.id, events: page,
    nextBeforeRevision: filtered.length > limit ? page.at(-1).revision : null, integrity: state.integrity };
}
