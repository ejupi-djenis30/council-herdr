import { Buffer } from 'buffer';
import { createHash } from 'crypto';

const states = new Set(['draft', 'in_progress', 'needs_attention', 'result_ready']);
const typedErrors = new Set(['invalid_input', 'not_found', 'role_unavailable', 'conflict', 'integrity_error', 'storage_error']);
const definiteRejections = new Set(['invalid_input', 'not_found', 'role_unavailable', 'conflict']);
const lifecycleErrors = new Set(['revision_required', 'stale_evidence', 'invalid_transition', 'review_not_authorized']);
export const lifecycleStates = ['open', 'in_review', 'closed'];
export const workItemPriorities = ['none', 'low', 'medium', 'high', 'urgent'];
export const workItemMutations = {
  triage: { action: 'triage', command: ['triage'] },
  delegate: { action: 'delegate', command: ['delegate'] },
  start: { action: 'startReview', command: ['review', 'start'] },
  note: { action: 'addNote', command: ['review', 'note'] },
  attach: { action: 'attachFormal', command: ['review', 'attach'] },
  return: { action: 'returnForChanges', command: ['review', 'return'] },
  close: { action: 'close', command: ['close'] },
  reopen: { action: 'reopen', command: ['reopen'] }
};
const itemId = /^wi-[a-z0-9][a-z0-9-]{0,59}$/;
const roleId = /^[a-z][a-z0-9-]{0,31}$/;
const reviewId = /^review-[1-9][0-9]*$/;
const decisionId = /^decision-[1-9][0-9]*$/;
const requestId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const digest = /^[a-f0-9]{64}$/;
// A link is a bounded session identifier within the selected project.
const safeSession = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id);
const formalSession = id => typeof id === 'string' && id.length <= 80 &&
  /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:-|$))[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
const lineBreak = /[\r\n\u2028\u2029]/u;
const control = /[\u0000-\u001f\u007f-\u009f]/u;

export function folderKey(folder) {
  const path = folder?.replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '').replace(/\/+$/, '') ?? '';
  return /^(?:[a-z]:|\/\/)/i.test(path) ? path.toLowerCase() : path;
}

function problem(code, message) {
  return Object.assign(new Error(message), { code });
}

export function workItemInput(id, { title, criteria, roleId: role }) {
  const name = title.trim();
  const lines = criteria.split(/\r\n|[\r\n\u2028\u2029]/u);
  // Ignore blank lines at the edges of a paste while retaining interior blanks.
  const first = lines.findIndex(line => line.trim() || control.test(line));
  const last = lines.findLastIndex(line => line.trim() || control.test(line));
  const ordered = first < 0 ? [] : lines.slice(first, last + 1).map(line => line.trim());
  if (!itemId.test(id)) throw problem('invalid_input', 'The work item ID is invalid.');
  if (!name || name.length > 160 || lineBreak.test(title) || control.test(title)) {
    throw problem('invalid_input', 'Enter a title of up to 160 characters on one line.');
  }
  if (!text(role) || !roleId.test(role)) throw problem('invalid_input', 'Choose a responsible role.');
  if (!ordered.length || ordered.length > 12 ||
      lines.some(line => control.test(line)) || ordered.some(line => !line || line.length > 500)) {
    throw problem('invalid_input', 'Enter 1–12 criteria on separate lines. Each line needs 1–500 characters.');
  }
  return Object.freeze({ id, title: name, roleId: role, criteria: Object.freeze(ordered) });
}

const text = value => typeof value === 'string' && Boolean(value.trim());
const nullableText = value => value === null || typeof value === 'string';
const message = value => text(value?.code) && text(value?.message);
const positive = value => Number.isSafeInteger(value) && value > 0;
const listOf = (value, validate) => Array.isArray(value) && value.every(validate);
const formalStates = ['pending', 'provisional', 'rejected', 'approved', 'unverified'];

function validFormal(formal, withDissent = true) {
  return formal === null || (formal && (formal.sessionId === null || safeSession(formal.sessionId)) &&
    (formal.round === null || positive(formal.round)) && formalStates.includes(formal.state) &&
    [formal.verdict, formal.proposalSha256, formal.manifestSha256].every(nullableText) &&
    ((!withDissent && formal.dissent === undefined) ||
      listOf(formal.dissent, vote => text(vote?.voter) && ['reject', 'amend'].includes(vote.vote) && nullableText(vote.rationale))));
}

function validReview(review) {
  const capture = review?.capture;
  const definition = review?.definition;
  return review && reviewId.test(review.id) && positive(review.cycle) && positive(review.workRevision) &&
    text(review.reviewOwnerRoleId) && roleId.test(review.reviewOwnerRoleId) && ['operator', 'formal'].includes(review.policy) &&
    text(definition?.title) && text(definition.roleId) && roleId.test(definition.roleId) && listOf(definition.criteria, text) &&
    digest.test(review.snapshotSha256) && (review.evidenceToken === null || digest.test(review.evidenceToken)) &&
    capture && safeSession(capture.sessionId) && digest.test(capture.sha256) && positive(capture.byteCount) &&
    nullableText(capture.output) && ['direct_artifact', 'terminal_screen'].includes(capture.source) &&
    [capture.captureScope, capture.completedAt].every(nullableText) && (capture.turn === null || Number.isSafeInteger(capture.turn)) &&
    typeof capture.verified === 'boolean' && validFormal(review.formal) &&
    listOf(review.notes, note => ['finding', 'dissent'].includes(note?.kind) && text(note.text) &&
      text(note.actor) && text(note.at) && positive(note.revision));
}

function validLifecycle(value, detail) {
  if (!value || ![value.revision, value.workRevision, value.cycle].every(positive) ||
      (value.formalRequired !== undefined && typeof value.formalRequired !== 'boolean') ||
      typeof value.managed !== 'boolean' || !lifecycleStates.includes(value.state) ||
      !workItemPriorities.includes(value.priority) || !nullableText(value.nextAction) || !text(value.guidance) ||
      typeof value.needsAttention !== 'boolean' || ![null, 'operator', ...formalStates].includes(value.reviewState) ||
      !listOf(value.blockedBy, link => itemId.test(link?.id) && nullableText(link.title) &&
        [...lifecycleStates, 'unavailable'].includes(link.state))) return false;
  const validActions = value.actions && Object.values(workItemMutations).every(({ action }) =>
    typeof value.actions[action] === 'boolean') && typeof value.actions.editDefinition === 'boolean';
  if (!detail) return value.actions === undefined || Boolean(validActions);
  const decision = value.decision;
  return validActions && (value.integrity === null || message(value.integrity)) &&
    (value.review === null || validReview(value.review)) &&
    (decision === null || (decision && decisionId.test(decision.id) && reviewId.test(decision.reviewId) &&
      positive(decision.cycle) && positive(decision.workRevision) && ['accepted', 'changes_requested'].includes(decision.disposition) &&
      [decision.actor, decision.reason, decision.nextAction, decision.at].every(text) &&
      digest.test(decision.snapshotSha256) && digest.test(decision.evidenceToken) && validFormal(decision.formal, false)));
}

function validItem(item, detail) {
  if (!item || !itemId.test(item.id) || !text(item.title) || !text(item.roleId) || !roleId.test(item.roleId) || !text(item.createdAt) ||
      !states.has(item.state) || !text(item.nextAction) || typeof item.canDelegate !== 'boolean' ||
      (item.canDelegate && item.state !== 'draft') || (item.attention !== null && !message(item.attention))) return false;
  const job = item.job;
  if (job !== null && (!job || !text(job.sessionId) || typeof job.linked !== 'boolean' || !text(job.outcome) ||
      ![job.deliveryState, job.deadlineAt, job.address].every(nullableText))) return false;
  if (item.lifecycle !== undefined && !validLifecycle(item.lifecycle, detail)) return false;
  if (!detail) return true;
  if (!Array.isArray(item.criteria) || !item.criteria.length || !item.criteria.every(text)) return false;
  const result = item.result;
  return item.state === 'result_ready' ? job?.linked === true && result && text(result.output) &&
    ['direct_artifact', 'terminal_screen'].includes(result.source) &&
    [result.captureScope, result.artifactPath, result.completedAt].every(nullableText) &&
    (result.turn === null || Number.isSafeInteger(result.turn)) : result === null;
}

function unavailable(scope, response) {
  const host = scope.engine.machine ? ` on ${scope.engine.machine}` : ' on the project machine';
  const detail = typeof response?.stderr === 'string' ? response.stderr.trim().slice(0, 300) : '';
  return problem('invalid_response',
    `Council returned an unreadable work item response. Check the connection or update Council${host}, then refresh.${detail ? ' ' + detail : ''}`);
}

async function wire(runCli, scope, args) {
  let response;
  try {
    response = await runCli(scope.project, ['work-item', ...args], scope.engine);
  } catch (error) {
    throw problem('transport', `Could not reach Council on the project machine. Check the connection or installation, then refresh. ${error.message}`);
  }
  let record;
  try { record = JSON.parse(response.stdout); } catch { throw unavailable(scope, response); }
  const sameProject = typeof record?.project === 'string' && folderKey(record.project) === folderKey(scope.project);
  if (response.code !== 0 && record?.success === false && message(record.error) &&
      (typedErrors.has(record.error.code) || lifecycleErrors.has(record.error.code)) &&
      (sameProject || (record.project === null && ['invalid_input', 'storage_error'].includes(record.error.code)))) {
    throw problem(record.error.code, record.error.message);
  }
  if (response.code !== 0 || record?.success !== true || !sameProject) throw unavailable(scope, response);
  return record;
}

async function invoke(runCli, scope, operation, payload) {
  const flags = operation === 'create' ? ['--input-json', JSON.stringify(payload)]
    : payload === undefined ? [] : ['--id', payload];
  const record = await wire(runCli, scope, [operation, ...flags]);
  if (operation === 'list') {
    if (validQueue(record)) return record;
  } else if (validItem(record.item, true) && record.item.id === (operation === 'create' ? payload.id : payload)) {
    return record.item;
  }
  throw unavailable(scope);
}

function validQueue(record) {
  return listOf(record.items, item => validItem(item, false)) &&
    listOf(record.errors, error => text(error?.id) && message(error));
}

function validReceipt(receipt, input) {
  return receipt && receipt.requestId === input.requestId && text(receipt.event) && positive(receipt.revision) &&
    receipt.revision > input.ifRevision && typeof receipt.replay === 'boolean';
}

function validHistoryEvent(event) {
  return event && [event.revision, event.cycle, event.workRevision].every(positive) && text(event.type) && text(event.at) &&
    nullableText(event.actor) && nullableText(event.requestId) && event.references && typeof event.references === 'object' &&
    !Array.isArray(event.references);
}

function rosterRoles(roster) {
  if (!listOf(roster?.members, member => text(member?.id) && roleId.test(member.id) && text(member.role))) {
    throw new Error('Council returned an unreadable Team roster. Refresh the roles or update Council on the project machine.');
  }
  return roster.members.map(({ id, role }) => ({ id, role }));
}

function queueFlags(filters) {
  return ['--sort', 'priority', ...(filters.roleId ? ['--role', filters.roleId] : []),
    ...(filters.state ? ['--state', filters.state] : []), ...(filters.attention ? ['--needs-attention'] : [])];
}

const requiresFormal = lifecycle => lifecycle.formalRequired === true ||
  lifecycle.review?.policy === 'formal' || Boolean(lifecycle.decision?.formal);
const allowsOperatorStart = lifecycle => lifecycle.formalRequired === false && !requiresFormal(lifecycle);
const hashTuple = tuple => createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
const captureChecks = new WeakMap();

export function frozenCaptureMatches(capture) {
  if (capture?.verified !== true || typeof capture.output !== 'string') return false;
  const { output, sha256, byteCount } = capture;
  const previous = captureChecks.get(capture);
  if (previous?.output === output && previous.sha256 === sha256 && previous.byteCount === byteCount) return previous.matches;
  // GPUI's hash bridge accepts the original UTF-8 string. Passing a Buffer
  // to update crashes Herdr Desktop 0.1.16 on Windows ARM64.
  const matches = Buffer.from(output, 'utf8').length === byteCount &&
    createHash('sha256').update(output).digest('hex') === sha256;
  captureChecks.set(capture, { output, sha256, byteCount, matches });
  return matches;
}

function canClose(item) {
  const { lifecycle, job } = item;
  const { review } = lifecycle;
  if (lifecycle.state !== 'in_review' || !frozenCaptureMatches(review?.capture) ||
      !digest.test(review.evidenceToken) || review.cycle !== lifecycle.cycle || review.workRevision !== lifecycle.workRevision ||
      (job && job.sessionId !== review.capture.sessionId)) return false;
  if (review.policy === 'operator') return lifecycle.reviewState === 'operator' && !requiresFormal(lifecycle) && review.formal === null;

  const { formal, definition, capture } = review;
  if (review.policy !== 'formal' || lifecycle.reviewState !== 'approved' || formal?.state !== 'approved' ||
      !['validated', 'conditional'].includes(formal.verdict) ||
      !formalSession(formal.sessionId) || !positive(formal.round) ||
      !digest.test(formal.proposalSha256) || !digest.test(formal.manifestSha256) || !matches(item, definition)) return false;

  // Workspace receives the verified digests. Only the backend has the proposal and manifest bytes.
  const definitionSha256 = hashTuple([definition.title, definition.roleId, definition.criteria]);
  const snapshot = ['council.work-item-review-snapshot/v2', item.id, lifecycle.cycle, lifecycle.workRevision,
    review.id, review.reviewOwnerRoleId, review.policy, definitionSha256, capture.sessionId, capture.sha256,
    capture.byteCount, capture.source, capture.captureScope, capture.turn, capture.completedAt];
  return review.snapshotSha256 === hashTuple(snapshot) &&
    review.evidenceToken === hashTuple([review.snapshotSha256, 'approved', formal.manifestSha256]);
}

export function workItemActionEnabled(item, operation) {
  const lifecycle = item?.lifecycle;
  if (!lifecycle?.actions?.[workItemMutations[operation]?.action] || lifecycle.integrity) return false;
  const review = lifecycle.review;
  if (operation === 'delegate') return lifecycle.state === 'open' && item.state === 'draft';
  if (operation === 'start') return item.state === 'result_ready' && Boolean(item.result) && item.job?.linked === true;
  if (operation === 'return') return Boolean(review?.evidenceToken);
  if (operation === 'note' || operation === 'attach') return Boolean(review);
  if (operation === 'reopen') return lifecycle.state === 'closed' && lifecycle.decision?.disposition === 'accepted';
  return operation !== 'close' || canClose(item);
}
const needsRoles = operation => ['triage', 'start', 'return', 'reopen'].includes(operation);
const trimmed = (value, title, max = 500) => {
  if (!text(value) || value.trim().length > max || lineBreak.test(value) || control.test(value)) {
    throw problem('invalid_input', `Enter ${title} using 1–${max} characters on one line.`);
  }
  return value.trim();
};

function matchingRole(form, id) {
  if (!form.roles?.some(role => role.id === id)) throw problem('invalid_input', 'Choose a role from this project’s Team.');
  return id;
}

function triagePatch(form, fields) {
  const { item, blockedBy, priority, roleId: role } = form;
  const patch = {};
  if (item.lifecycle.actions.editDefinition) {
    const definition = workItemInput(item.id, { title: fields.title, criteria: fields.criteria, roleId: role });
    if (definition.title !== item.title) patch.title = definition.title;
    if (JSON.stringify(definition.criteria) !== JSON.stringify(item.criteria)) patch.criteria = definition.criteria;
    if (role !== item.roleId) patch.roleId = matchingRole(form, role);
  }
  if (priority !== item.lifecycle.priority) patch.priority = priority;
  if (JSON.stringify(blockedBy) !== JSON.stringify(item.lifecycle.blockedBy.map(link => link.id).sort())) patch.blockedBy = [...blockedBy];
  if (fields.nextAction.trim() !== (item.lifecycle.nextAction ?? '')) patch.nextAction = trimmed(fields.nextAction, 'a next action');
  if (!Object.keys(patch).length) throw problem('invalid_input', 'Change at least one triage field before saving.');
  return patch;
}

function evidenceReferences(operation, item) {
  const { review, decision } = item.lifecycle;
  if (operation === 'reopen') return { decisionId: decision?.id, snapshotSha256: decision?.snapshotSha256 };
  if (operation === 'close' || operation === 'return') return { reviewId: review?.id, evidenceToken: review?.evidenceToken };
  if (operation === 'note' || operation === 'attach') return { reviewId: review?.id };
  return {};
}

function closeEvidenceKey(scope, item) {
  const { revision, review } = item.lifecycle;
  return JSON.stringify([recoveryScope(scope), item.id, revision, review.id, review.snapshotSha256, review.evidenceToken]);
}

function matchingEvidence(screen, operation, input, closeEvidence, item = screen.item) {
  return workItemActionEnabled(item, operation) && item.lifecycle.revision === input.ifRevision &&
    !(operation === 'start' && input.policy === 'operator' && !allowsOperatorStart(item.lifecycle)) &&
    (operation !== 'close' || (closeEvidence?.key === closeEvidenceKey(screen.scope, item) &&
      closeEvidence.output === item.lifecycle.review.capture.output)) &&
    Object.entries(evidenceReferences(operation, item)).every(([key, current]) => Boolean(current) && current === input[key]);
}

function formEvidence(form) {
  return { ifRevision: form.item.lifecycle.revision, policy: form.policy, ...evidenceReferences(form.operation, form.item) };
}

function invalidateConfirmation(screen) {
  screen.form.stale = true;
  screen.error = 'The item or its evidence changed. Review the latest detail before making a new confirmation.';
}

function mutationInput(form, fields, key) {
  const { operation, item } = form;
  const refs = evidenceReferences(operation, item);
  if (Object.values(refs).some(value => !value)) throw problem('stale_evidence', 'Refresh the review to verify its evidence before confirming.');
  const input = { id: item.id, ifRevision: item.lifecycle.revision, requestId: key,
    actor: trimmed(fields.actor, 'an actor name', 120), ...refs };
  if (operation === 'triage') input.patch = triagePatch(form, fields);
  if (operation === 'start') {
    if (form.formalRequired && form.policy !== 'formal') throw problem('review_not_authorized', 'This item requires formal review.');
    Object.assign(input, { reviewOwnerRoleId: matchingRole(form, form.roleId), policy: form.policy });
  }
  if (operation === 'note') Object.assign(input, { kind: form.noteKind, text: trimmed(fields.text, 'a review note') });
  if (operation === 'attach') {
    const formalSessionId = fields.formalSessionId.trim();
    const round = Number(fields.round.trim());
    if (!formalSession(formalSessionId) || !/^\d+$/.test(fields.round.trim()) || !positive(round)) {
      throw problem('invalid_input', 'Enter a Council review session ID and its positive round number.');
    }
    Object.assign(input, { formalSessionId, round });
  }
  if (['close', 'return', 'reopen'].includes(operation)) {
    input.reason = trimmed(fields.reason, 'a decision reason');
    input.nextAction = trimmed(fields.nextAction, 'a next action');
    if (operation === 'close') input.decision = 'accept';
    else input.roleId = matchingRole(form, form.roleId);
  }
  return Object.freeze(input);
}

function mutationFlags(operation, input) {
  if (operation === 'delegate') return ['--id', input.id, '--if-revision', String(input.ifRevision), '--request-id',
    input.requestId, '--actor', input.actor];
  return ['--input-json', JSON.stringify(input)];
}

function matches(item, input) {
  return item.title === input.title && item.roleId === input.roleId &&
    item.criteria.length === input.criteria.length && item.criteria.every((line, index) => line === input.criteria[index]);
}

export function newWorkItemId() {
  const unique = () => Math.random().toString(36).slice(2, 12);
  return `wi-${Date.now().toString(36)}-${unique()}${unique()}`;
}

export function workItemScopeKey(scope) {
  return JSON.stringify([scope.space, ...planeReaderScope(scope)]);
}

export function workItemScreenVisible(screen, { space, workspaceActive, target }) {
  const { scope } = screen;
  return Boolean(workspaceActive && space?.id === scope.space && (space.machine ?? null) === scope.engine.machine &&
    (screen.kind !== 'list' || folderKey(target) === folderKey(scope.anchor)));
}

function recoveryScope(scope) {
  return JSON.stringify([scope.engine.machine ?? null, folderKey(scope.project)]);
}

function planeReaderScope({ engine, project }) {
  return [engine.machine ?? null, folderKey(project), folderKey(engine.node), folderKey(engine.entry), folderKey(engine.cli)];
}

const planeAvailability = ['disabled', 'read_only', 'operator_available'];
const planeFreshness = ['current', 'cached', 'unavailable'];
const planeStates = ['prepared', 'approved_unsent', 'expired', 'cancelled', 'conflict', 'offline', 'delivery_uncertain', 'published'];
const planeErrors = ['plane_disabled', 'operator_required', 'offline', 'authorization_denied', 'stale_preview',
  'scope_conflict', 'evidence_unverified', 'storage_error', 'integrity_error', 'invalid_input', 'not_found'];
const uuid = value => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const operationRef = value => typeof value === 'string' && value.length === 32 && /^[0-9a-f]{32}$/.test(value);
const plainLabel = value => text(value) && value.length <= 160 && !control.test(value) && !lineBreak.test(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const linkPins = ['linkRevision', 'instanceId', 'workspaceId', 'workspaceSlug', 'projectKey', 'projectId', 'itemIdentifier', 'itemId'];
const operationPins = ['operationId', 'itemRevision', 'linkRevision', 'status', 'evidenceUrl', 'visibility'];

function validPlaneLink(link) {
  if (!exactKeys(link, [...linkPins, 'instanceLabel']) || !positive(link.linkRevision) || !plainLabel(link.instanceLabel) ||
      ![link.instanceId, link.workspaceId, link.projectId, link.itemId].every(uuid) ||
      !plainLabel(link.workspaceSlug) || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(link.workspaceSlug) ||
      !plainLabel(link.projectKey) || !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(link.projectKey) ||
      !plainLabel(link.itemIdentifier) || !link.itemIdentifier.startsWith(link.projectKey + '-')) return false;
  const sequence = link.itemIdentifier.slice(link.projectKey.length + 1);
  return /^[1-9][0-9]*$/.test(sequence) && positive(Number(sequence));
}

function samePlaneLink(first, second) {
  return linkPins.every(key => first[key] === second[key]);
}

function validPlaneEvidence(url) {
  if (typeof url !== 'string' || url.length > 300 || control.test(url) || lineBreak.test(url)) return false;
  const match = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/(?:pull\/([1-9][0-9]*)|commit\/[a-f0-9]{40})$/.exec(url);
  return Boolean(match && (!match[1] || positive(Number(match[1]))));
}

function validPlaneOperation(operation, link, expected) {
  if (!exactKeys(operation, [...operationPins, 'state', 'reason', 'receipt']) ||
      !operationRef(operation.operationId) || (expected && expected !== operation.operationId) ||
      !positive(operation.itemRevision) || operation.linkRevision !== link?.linkRevision ||
      !lifecycleStates.includes(operation.status) || !validPlaneEvidence(operation.evidenceUrl) ||
      operation.visibility !== 'INTERNAL' || !planeStates.includes(operation.state) ||
      ![null, 'receipt_not_proven', ...planeErrors].includes(operation.reason)) return false;
  const { receipt } = operation;
  if (operation.state !== 'published') return receipt === null;
  return exactKeys(receipt, ['commentId', 'operationId', 'verifiedAt', 'source']) && uuid(receipt.commentId) &&
    receipt.operationId === operation.operationId && plainLabel(receipt.verifiedAt) &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(receipt.verifiedAt) &&
    Number.isFinite(Date.parse(receipt.verifiedAt)) && ['response', 'reconciliation'].includes(receipt.source);
}

async function planeCommand(runCli, scope, id, verb, operationId) {
  let response;
  try {
    response = await runCli(scope.project, ['work-item', 'plane', verb, '--id', id, '--project', scope.project,
      ...(operationId ? ['--operation-id', operationId] : [])], scope.engine);
  } catch {
    throw problem('offline');
  }
  let record;
  try { record = JSON.parse(response.stdout); } catch { throw problem('unavailable'); }
  const bound = typeof record?.project === 'string' && folderKey(record.project) === folderKey(scope.project);
  if (response.code !== 0 || record?.success !== true || !bound) {
    const code = record?.error?.code;
    throw problem(bound && planeErrors.includes(code) ? code : 'unavailable');
  }
  return record;
}

class WorkItemPlane {
  constructor(screen, viewId, options) {
    this.screen = screen;
    this.viewId = viewId;
    this.options = options;
    this.checked = false;
    this.pending = false;
    this.forgetInstallation();
  }

  forgetInstallation(availability) {
    this.installationId = null;
    this.cache = null;
    this.currentLink = null;
    this.availability = availability;
    this.freshness = 'unavailable';
    this.handoffRequest = null;
  }

  get link() {
    return this.cache?.link ?? null;
  }

  get receipts() {
    return this.cache ? [...this.cache.receipts.values()] : [];
  }

  get operation() {
    const operation = this.cache?.operation;
    return operation ? this.cache.receipts.get(operation.operationId) ?? operation : null;
  }

  get action() {
    if (!this.options.active() || !this.installationId || !this.screen.item?.lifecycle || this.screen.staleRead || this.pending ||
        this.freshness !== 'current' || this.availability !== 'operator_available') return null;
    if (!this.link) return 'link';
    if (!this.currentLink) return null;
    const operation = this.operation;
    if (operation?.state === 'delivery_uncertain') return 'check';
    if (operation?.state === 'published' && operation.itemRevision >= this.screen.item.lifecycle.revision) return null;
    return 'prepare';
  }

  async read(operationId, replacement = null) {
    const { options, screen } = this;
    const expectedInstallation = this.installationId;
    const sequence = options.nextRequest();
    const { installationId, plane } = await planeCommand(options.runCli, screen.scope, screen.id, 'show', operationId);
    if (!options.active() && expectedInstallation !== installationId) return;
    if (replacement && replacement !== installationId) throw problem('scope_conflict');
    if (expectedInstallation && expectedInstallation !== installationId) {
      this.forgetInstallation();
      if (uuid(installationId)) return this.read(null, installationId);
    }
    if (!isObject(plane) || !planeAvailability.includes(plane.availability) || !planeFreshness.includes(plane.freshness)) {
      throw problem('unavailable');
    }
    if (!uuid(installationId)) {
      if (options.active()) {
        this.forgetInstallation(plane.availability);
        if (plane.availability !== 'disabled') this.issue = 'installation_unverified';
      }
      return;
    }
    if ((plane.link !== null && !validPlaneLink(plane.link)) ||
        (plane.operation === null ? Boolean(operationId) : !validPlaneOperation(plane.operation, plane.link, operationId))) {
      throw problem('unavailable');
    }
    const cache = options.cacheFor(installationId);
    if (options.active()) {
      this.installationId = installationId;
      this.cache = cache;
    }
    if (plane.link && cache.link && !samePlaneLink(cache.link, plane.link)) throw problem('scope_conflict');
    // Positive scoped evidence survives selection changes and out-of-order reads.
    const operation = plane.operation;
    const verified = operation && cache.receipts.get(operation.operationId);
    const pinned = verified ?? (operation?.operationId === cache.operation?.operationId ? cache.operation : null);
    if (pinned && (operationPins.some(key => pinned[key] !== operation[key]) ||
        verified && operation.receipt && verified.receipt.commentId !== operation.receipt.commentId)) {
      throw problem('integrity_error');
    }
    cache.link ??= plane.link;
    if (operation?.state === 'published' && !cache.receipts.has(operation.operationId)) {
      cache.receipts.set(operation.operationId, operation);
    }
    if (sequence >= cache.applied) {
      cache.applied = sequence;
      const previous = cache.operation && (cache.receipts.get(cache.operation.operationId) ?? cache.operation);
      if (previous?.state !== 'delivery_uncertain' || operation?.operationId === previous.operationId &&
          ['delivery_uncertain', 'published'].includes(operation.state)) cache.operation = operation;
    }
    if (options.active()) {
      this.availability = plane.availability;
      this.currentLink = plane.link;
      this.freshness = cache.link && (plane.freshness === 'unavailable' || !plane.link) ? 'cached' : plane.freshness;
    }
    return operation;
  }

  async check(task) {
    if (!this.options.active() || this.pending) return;
    this.checked = true;
    this.pending = true;
    this.issue = null;
    this.handoff = null;
    try { await task(); }
    catch (error) {
      if (this.options.active()) {
        this.issue = planeErrors.includes(error.code) ? error.code : 'unavailable';
        this.freshness = this.link ? 'cached' : 'unavailable';
      }
    } finally {
      this.pending = false;
    }
  }

  refresh() {
    const operation = this.operation;
    return this.check(() => this.read(operation?.state === 'delivery_uncertain' ? operation.operationId : null));
  }

  open(intent) {
    if (this.action !== intent) return;
    const operation = this.operation;
    const operationId = intent === 'check' || intent === 'prepare' && ['prepared', 'approved_unsent'].includes(operation?.state)
      ? operation.operationId : null;
    const expectedInstallation = this.installationId;
    return this.check(async () => {
      if (intent === 'check') {
        await this.read(operationId);
        if (!this.options.active() || expectedInstallation !== this.installationId || this.operation?.state !== 'delivery_uncertain' ||
            this.availability !== 'operator_available' || this.freshness !== 'current') return;
      }
      const { screen, options } = this;
      const generation = options.nextRequest();
      this.handoffRequest = generation;
      const { installationId, planeHandoff } = await planeCommand(options.runCli, screen.scope, screen.id, 'open', operationId);
      if (!options.active() || this.handoffRequest !== generation) return;
      if (installationId !== expectedInstallation) {
        this.forgetInstallation();
        if (uuid(installationId)) await this.read(null, installationId);
        else this.issue = 'installation_unverified';
        return;
      }
      const { disposition, localRef, operationId: echoed } = planeHandoff ?? {};
      if (echoed !== operationId || !exactKeys(planeHandoff, ['disposition', 'localRef', 'operationId']) ||
          !['operator_console', 'manual_operator_session', 'unavailable'].includes(disposition) ||
          (disposition === 'unavailable' ? localRef !== null :
            !plainLabel(localRef) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(localRef))) throw problem('unavailable');
      if (disposition === 'unavailable') throw problem('operator_required');
      this.handoff = { disposition, localRef, intent };
    });
  }
}

export class WorkItems {
  constructor({ runCli, readTeam, visible = () => true, createId = newWorkItemId, lifecycle = false }) {
    this.runCli = runCli;
    this.readTeam = readTeam;
    this.visible = visible;
    this.createId = createId;
    this.lifecycle = lifecycle;
    this.current = null;
    this.creates = new Map();
    this.delegates = new Map();
    this.mutations = new Map();
    this.queues = new Map();
    this.planeCache = new Map();
    this.planeViews = 0;
    this.planeRequests = 0;
  }

  leave() {
    this.current = null;
  }

  isCurrent(screen) {
    return this.current === screen && this.visible(screen);
  }

  async read(screen, load, apply, onFailure) {
    if (!this.isCurrent(screen) || screen.pending) return;
    screen.pending = true;
    screen.error = '';
    try {
      const data = await load();
      if (this.isCurrent(screen)) apply(data);
    } catch (error) {
      if (this.isCurrent(screen)) {
        screen.error = error.message;
        onFailure?.();
      }
    } finally {
      screen.pending = false;
    }
  }

  request(scope, operation, payload) {
    return invoke(this.runCli, scope, operation, payload);
  }

  command(scope, args) {
    return wire(this.runCli, scope, args);
  }

  async showList(scope = this.current?.scope) {
    if (!scope) return;
    const screen = { kind: 'list', scope, filters: this.queues.get(workItemScopeKey(scope)) ?? {} };
    this.current = screen;
    await this.refresh(screen);
  }

  async open(screen, id) {
    if (!this.isCurrent(screen)) return;
    const visibleItems = screen.kind === 'list' ? screen.items : screen.item?.lifecycle?.blockedBy;
    if (!visibleItems?.some(item => item.id === id && item.state !== 'unavailable')) return;
    await this.restore(screen.scope, id);
  }

  async restore(scope, id, archive) {
    if (!itemId.test(id)) return;
    const screen = this.selectDetail(scope, id);
    await this.refresh(screen);
    if (archive) await this.openArchived(screen, archive);
  }

  selectDetail(scope, id, item) {
    const screen = { kind: 'detail', scope, id, item };
    if (this.lifecycle) {
      screen.plane = new WorkItemPlane(screen, ++this.planeViews, {
        runCli: this.runCli, active: () => this.isCurrent(screen) && !screen.archived,
        nextRequest: () => ++this.planeRequests,
        cacheFor: installationId => {
          const key = JSON.stringify([...planeReaderScope(scope), id, installationId]);
          if (!this.planeCache.has(key)) {
            this.planeCache.set(key, { link: null, operation: null, receipts: new Map(), applied: 0 });
          }
          return this.planeCache.get(key);
        }
      });
    }
    this.current = screen;
    return screen;
  }

  async filter(screen, filters) {
    if (!this.isCurrent(screen) || screen.kind !== 'list' || screen.legacy) return;
    if ((filters.roleId && !roleId.test(filters.roleId)) || (filters.state && !lifecycleStates.includes(filters.state))) return;
    this.queues.set(workItemScopeKey(screen.scope), { ...filters });
    // Replace the selection so an earlier query cannot land after this one.
    await this.showList(screen.scope);
  }

  async list(scope, filters = {}) {
    if (!this.lifecycle) return this.request(scope, 'list');
    try {
      const record = await this.command(scope, ['list', ...queueFlags(filters)]);
      if (!Array.isArray(record.items) || !listOf(record.errors, error => text(error?.id) && message(error))) throw unavailable(scope);
      const items = [];
      const errors = [...record.errors];
      for (const item of record.items) {
        if (validItem(item, false)) items.push(item);
        else errors.push({ id: itemId.test(item?.id) ? item.id : 'Unreadable entry', code: 'invalid_response',
          message: 'This queue entry could not be read. Refresh or update Council on the project machine.' });
      }
      return { items, errors, legacy: items.some(item => !item.lifecycle) };
    } catch (error) {
      // Compatible old engines can still expose their queue in read-only mode.
      if (error.code !== 'invalid_input' || Object.values(filters).some(Boolean)) throw error;
      const record = await this.request(scope, 'list');
      if (record.items.some(item => item.lifecycle)) throw error;
      return { ...record, legacy: true };
    }
  }

  async queue(screen) {
    const { scope, filters } = screen;
    if (!this.lifecycle) return this.list(scope, filters);
    const teamRead = async () => rosterRoles(await this.readTeam(scope.project, scope.engine));
    const [result, team] = await Promise.allSettled([this.list(scope, filters), teamRead()]);
    if (result.status === 'rejected') throw result.reason;
    return { ...result.value, roles: team.status === 'fulfilled' ? team.value : [],
      rosterError: team.status === 'rejected' ? 'Team roles could not be read. Refresh to reload project roles.' : '' };
  }

  async refresh(screen) {
    if (!this.isCurrent(screen)) return;
    if (screen.kind === 'list') {
      await this.read(screen, () => this.queue(screen), result => Object.assign(screen, result));
    } else if (screen.kind === 'detail') {
      const mutation = this.mutation(screen);
      if (mutation) {
        if (['unresolved', 'missing', 'settled'].includes(mutation.phase)) await this.reconcileMutation(screen, mutation);
        return;
      }
      await this.read(screen, () => this.request(screen.scope, 'show', screen.id), item => {
        screen.item = item;
        screen.staleRead = false;
        if (screen.form && !matchingEvidence(screen, screen.form.operation, formEvidence(screen.form), screen.form.closeEvidence)) {
          screen.form.stale = true;
        } else if (screen.form?.operation === 'start') {
          screen.form.formalRequired = !allowsOperatorStart(item.lifecycle);
          screen.form.policyUnknown = item.lifecycle.formalRequired === undefined;
        }
        const key = this.delegationKey(screen);
        if (this.delegates.get(key) !== 'writing') this.delegates.delete(key);
        const attempt = this.createAttempt(screen);
        if (attempt?.input.id === item.id && !['writing', 'checking'].includes(attempt.phase) && matches(item, attempt.input)) {
          this.creates.delete(recoveryScope(screen.scope));
        }
      }, () => {
        screen.staleRead = true;
        if (screen.form) screen.form.stale = true;
      });
    } else if (screen.kind === 'create') {
      const attempt = this.createAttempt(screen);
      if (!attempt) await this.loadRoles(screen);
      else if (!['writing', 'checking', 'conflict'].includes(attempt.phase)) await this.recoverCreate(screen, attempt);
    }
  }

  async startCreate(screen) {
    if (!this.isCurrent(screen) || screen.kind !== 'list') return;
    const attempt = this.creates.get(recoveryScope(screen.scope));
    this.current = { kind: 'create', scope: screen.scope, id: attempt?.input.id ?? this.createId(), roleId: '' };
    if (!attempt) await this.loadRoles(this.current);
  }

  async loadRoles(screen) {
    await this.read(screen, () => this.readTeam(screen.scope.project, screen.scope.engine), roster => {
      screen.roles = rosterRoles(roster);
      if (!screen.roles.some(role => role.id === screen.roleId)) screen.roleId = '';
    });
  }

  createAttempt(screen) {
    return this.creates.get(recoveryScope(screen.scope));
  }

  discardCreate(screen) {
    if (!this.isCurrent(screen) || this.createAttempt(screen)?.phase !== 'conflict') return;
    this.creates.delete(recoveryScope(screen.scope));
    return this.showList(screen.scope);
  }

  async save(screen, fields) {
    if (!this.isCurrent(screen) || screen.kind !== 'create' || screen.pending) return;
    let attempt = this.createAttempt(screen);
    if (attempt && attempt.phase !== 'missing') return;
    if (!attempt) {
      try {
        const input = workItemInput(screen.id, { ...fields, roleId: screen.roleId });
        if (!screen.roles?.some(role => role.id === input.roleId)) throw new Error('Choose a role from this project’s Team.');
        attempt = { input, scope: screen.scope };
      } catch (error) {
        screen.error = error.message;
        return;
      }
    }
    const key = recoveryScope(screen.scope);
    this.creates.set(key, attempt);
    attempt.phase = 'writing';
    screen.error = '';
    try {
      const item = await this.request(attempt.scope, 'create', attempt.input);
      if (!matches(item, attempt.input)) throw problem('invalid_response', 'The save returned different work item inputs.');
      this.acceptCreate(screen, attempt, item);
    } catch (error) {
      if (error.code === 'conflict') {
        attempt.phase = 'conflict';
        attempt.message = error.message;
      } else if (definiteRejections.has(error.code)) {
        this.creates.delete(key);
        if (this.isCurrent(screen)) screen.error = error.message;
      } else {
        attempt.phase = 'unresolved';
        await this.recoverCreate(screen, attempt);
      }
    }
  }

  acceptCreate(screen, attempt, item) {
    if (!matches(item, attempt.input)) {
      attempt.phase = 'conflict';
      attempt.message = 'This ID belongs to an item with different saved inputs. Discard this draft to start a new one.';
      return;
    }
    if (this.isCurrent(screen)) {
      this.creates.delete(recoveryScope(attempt.scope));
      this.selectDetail(screen.scope, item.id, item);
    } else {
      attempt.phase = 'saved';
      attempt.message = 'The original save finished. Refresh the saved item to reopen it.';
    }
  }

  async recoverCreate(screen, attempt) {
    attempt.phase = 'checking';
    screen.error = '';
    try {
      const item = await this.request(attempt.scope, 'show', attempt.input.id);
      this.acceptCreate(screen, attempt, item);
    } catch (error) {
      attempt.phase = error.code === 'not_found' ? 'missing' : 'unresolved';
      attempt.message = attempt.phase === 'missing' ? 'No saved item was found. Retry save to send this same draft and ID.'
        : `The save remains unconfirmed. Refresh the saved item before retrying. ${error.message}`;
    }
  }

  delegationKey(screen) {
    return JSON.stringify([recoveryScope(screen.scope), screen.id]);
  }

  delegationPending(screen) {
    return this.delegates.get(this.delegationKey(screen));
  }

  async delegate(screen) {
    if (this.lifecycle || !this.isCurrent(screen) || screen.kind !== 'detail' || screen.pending ||
        screen.item?.canDelegate !== true || this.delegationPending(screen)) return;
    const key = this.delegationKey(screen);
    this.delegates.set(key, 'writing');
    screen.error = '';
    try {
      const item = await this.request(screen.scope, 'delegate', screen.id);
      if (item.state === 'draft') throw problem('invalid_response', 'The delegate response still reports a draft.');
      if (this.isCurrent(screen)) {
        screen.item = item;
        this.delegates.delete(key);
      } else {
        this.delegates.set(key, 'unresolved');
      }
    } catch (error) {
      if (definiteRejections.has(error.code)) {
        this.delegates.delete(key);
        if (this.isCurrent(screen)) screen.error = error.message;
        return;
      }
      try {
        const item = await this.request(screen.scope, 'show', screen.id);
        if (this.isCurrent(screen)) {
          screen.item = item;
          if (item.state !== 'draft') this.delegates.delete(key);
        }
      } catch (readError) {
        if (this.isCurrent(screen)) screen.error = readError.message;
      }
      if (this.delegates.has(key)) this.delegates.set(key, 'unresolved');
    }
  }

  mutation(screen) {
    return this.mutations.get(this.delegationKey(screen));
  }

  async startMutation(screen, operation) {
    if (!this.isCurrent(screen) || screen.pending || screen.staleRead || this.mutation(screen) ||
        !workItemActionEnabled(screen.item, operation)) return;
    const item = screen.item;
    const lifecycle = item.lifecycle;
    const formalRequired = !allowsOperatorStart(lifecycle);
    const form = {
      operation, item, roleId: operation === 'triage' ? item.roleId : '', formalRequired,
      policyUnknown: lifecycle.formalRequired === undefined,
      policy: formalRequired ? 'formal' : 'operator', noteKind: 'finding', priority: item.lifecycle.priority,
      blockedBy: item.lifecycle.blockedBy.map(link => link.id).sort()
    };
    if (operation === 'close') form.closeEvidence = Object.freeze({
      key: closeEvidenceKey(screen.scope, item), output: lifecycle.review.capture.output
    });
    screen.error = '';
    screen.form = form;
    await this.loadMutationOptions(screen, form);
  }

  async loadMutationOptions(screen, form) {
    if (!this.isCurrent(screen) || screen.form !== form || form.pending || form.stale || this.mutation(screen)) return;
    const { operation, item } = form;
    if (!needsRoles(operation)) return;
    const { scope } = screen;
    const roles = async () => operation === 'triage' && !item.lifecycle.actions.editDefinition ? []
      : rosterRoles(await this.readTeam(scope.project, scope.engine));
    form.pending = true;
    const [team, queue] = await Promise.allSettled([roles(), operation === 'triage' ? this.list(scope) : null]);
    form.pending = false;
    if (!this.isCurrent(screen) || screen.form !== form) return;
    form.roles = team.status === 'fulfilled' ? team.value : [];
    form.optionsError = team.status === 'rejected' ? 'Team roles could not be read from this project.' : '';
    if (queue.status === 'rejected') {
      form.optionsError = [form.optionsError, 'Blocker choices could not be read from this project.'].filter(Boolean).join(' ');
    } else if (queue.value) {
      form.blockerItems = queue.value.items.filter(candidate => candidate.id !== item.id && candidate.lifecycle);
      form.blockerErrors = queue.value.errors;
    }
  }

  selectMutation(screen, key, value) {
    const form = screen.form;
    if (!this.isCurrent(screen) || !form || form.pending || form.stale || this.mutation(screen)) return;
    if (key === 'roleId' && form.roles?.some(role => role.id === value)) form.roleId = value;
    if (key === 'priority' && workItemPriorities.includes(value)) form.priority = value;
    if (key === 'policy' && (value === 'formal' || (value === 'operator' && !form.formalRequired))) form.policy = value;
    if (key === 'noteKind' && ['finding', 'dissent'].includes(value)) form.noteKind = value;
    if (key === 'blockedBy') {
      if (form.blockedBy.includes(value)) form.blockedBy = form.blockedBy.filter(id => id !== value);
      else if (form.blockedBy.length < 20 && form.blockerItems?.some(candidate => candidate.id === value)) {
        form.blockedBy = [...form.blockedBy, value].sort();
      }
    }
  }

  cancelMutation(screen) {
    if (!this.isCurrent(screen) || this.mutation(screen)) return;
    screen.form = null;
    screen.error = '';
  }

  async confirmMutation(screen, fields) {
    const form = screen.form;
    if (!this.isCurrent(screen) || screen.pending || screen.staleRead || !form || form.pending || form.stale ||
        this.mutation(screen)) return;
    if (form.operation === 'close' && !matchingEvidence(screen, 'close', formEvidence(form), form.closeEvidence)) {
      return invalidateConfirmation(screen);
    }
    let input;
    try {
      input = mutationInput(form, fields, newWorkItemId());
    } catch (error) {
      screen.error = error.message;
      return;
    }
    if (form.operation !== 'close' && !matchingEvidence(screen, form.operation, input)) return invalidateConfirmation(screen);
    await this.sendMutation(screen, { input, operation: form.operation, scope: screen.scope, closeEvidence: form.closeEvidence });
  }

  async sendMutation(screen, attempt) {
    const key = this.delegationKey(screen);
    this.mutations.set(key, attempt);
    attempt.phase = 'writing';
    attempt.message = '';
    screen.error = '';
    const { scope, operation, input } = attempt;
    if (screen.form) screen.form.submitted = input;
    try {
      const record = await this.command(scope, [...workItemMutations[operation].command, ...mutationFlags(operation, input)]);
      if (!validItem(record.item, true) || record.item.id !== input.id || !record.item.lifecycle ||
          !validReceipt(record.receipt, input) || record.item.lifecycle.revision < record.receipt.revision) {
        throw unavailable(scope);
      }
      this.acceptMutation(screen, attempt, record.item, record.receipt);
    } catch (error) {
      if (definiteRejections.has(error.code) || lifecycleErrors.has(error.code)) {
        const changed = ['conflict', 'stale_evidence', 'invalid_transition', 'review_not_authorized'].includes(error.code);
        if (changed && this.isCurrent(screen) && screen.form) screen.form.stale = true;
        attempt.rejected = true;
        if (changed) await this.reconcileMutation(screen, attempt);
        else this.mutations.delete(key);
        if (this.isCurrent(screen) && screen.receipt?.requestId !== input.requestId) screen.error = error.message;
        return;
      }
      await this.reconcileMutation(screen, attempt);
    }
  }

  acceptMutation(screen, attempt, item, receipt) {
    attempt.receipt = receipt;
    if (!this.isCurrent(screen)) {
      attempt.phase = 'settled';
      return;
    }
    this.mutations.delete(this.delegationKey(screen));
    Object.assign(screen, { item, receipt, form: null, error: '', history: null, archived: null, staleRead: false });
  }

  async reconcileMutation(screen, attempt) {
    const { scope, input, operation } = attempt;
    const key = this.delegationKey(screen);
    attempt.phase = 'checking';
    attempt.message = '';
    const [history, show] = await Promise.allSettled([
      attempt.receipt ? null : this.command(scope, ['history', '--id', input.id, '--request-id', input.requestId]),
      this.request(scope, 'show', input.id)
    ]);
    const lookup = history.status === 'fulfilled' ? history.value : null;
    const current = show.status === 'fulfilled' ? show.value : null;
    const receipt = attempt.receipt ?? (lookup?.id === input.id && validReceipt(lookup.receipt, input) ? lookup.receipt : null);
    if (this.isCurrent(screen) && current?.lifecycle) Object.assign(screen, { item: current, staleRead: false });
    if (receipt) {
      if (current?.lifecycle?.revision >= receipt.revision) this.acceptMutation(screen, attempt, current, receipt);
      else Object.assign(attempt, { receipt, phase: 'unresolved', message: 'Council saved this request. Refresh to load the current detail.' });
      return;
    }
    if (attempt.rejected || (lookup?.id === input.id && lookup.receipt === null && current?.lifecycle &&
        !matchingEvidence(screen, operation, input, attempt.closeEvidence, current))) {
      if (this.isCurrent(screen)) {
        if (screen.form) screen.form.stale = true;
        screen.staleRead = !current?.lifecycle;
        screen.error = 'The item or its evidence changed. Review the latest detail before making a new confirmation.';
      }
      this.mutations.delete(key);
      return;
    }
    const absent = lookup?.id === input.id && lookup.receipt === null &&
      matchingEvidence(screen, operation, input, attempt.closeEvidence, current);
    attempt.phase = absent ? 'missing' : 'unresolved';
    attempt.message = absent ? 'No receipt was found. Refresh again or explicitly resend the same request.'
      : 'Council could not verify the receipt and item. Refresh on the original project machine before resending.';
  }

  async replayMutation(screen) {
    const attempt = this.mutation(screen);
    if (!this.isCurrent(screen) || attempt?.phase !== 'missing' ||
        !matchingEvidence(screen, attempt.operation, attempt.input, attempt.closeEvidence)) return;
    await this.sendMutation(screen, attempt);
  }

  async loadHistory(screen, more = false) {
    if (!this.isCurrent(screen) || !screen.item?.lifecycle) return;
    const history = screen.history ??= { events: [] };
    if (history.pending || (more && !history.nextBeforeRevision)) return;
    history.pending = true;
    history.error = '';
    const before = more ? history.nextBeforeRevision : null;
    const args = ['history', '--id', screen.id, ...(before ? ['--before', String(before)] : [])];
    try {
      const record = await this.command(screen.scope, args);
      if (record.id !== screen.id || !listOf(record.events, validHistoryEvent) ||
          !(record.nextBeforeRevision === null || (positive(record.nextBeforeRevision) && (!before || record.nextBeforeRevision < before))) ||
          !(record.integrity === null || message(record.integrity))) throw unavailable(screen.scope);
      if (this.isCurrent(screen) && screen.history === history) Object.assign(history, {
        events: more ? [...history.events, ...record.events] : record.events,
        nextBeforeRevision: record.nextBeforeRevision, integrity: record.integrity
      });
    } catch (error) {
      if (this.isCurrent(screen) && screen.history === history) history.error = error.message;
    } finally {
      history.pending = false;
    }
  }

  async openArchived(screen, id) {
    if (!this.isCurrent(screen) || !reviewId.test(id)) return;
    const archived = screen.archived = { id, pending: true };
    try {
      const record = await this.command(screen.scope, ['show', '--id', screen.id, '--review-id', id]);
      if (record.item?.id !== screen.id || record.archivedReview?.id !== id || !validReview(record.archivedReview)) {
        throw unavailable(screen.scope);
      }
      if (this.isCurrent(screen) && screen.archived === archived) archived.review = record.archivedReview;
    } catch (error) {
      if (this.isCurrent(screen) && screen.archived === archived) archived.error = error.message;
    } finally {
      archived.pending = false;
    }
  }

  formalLink(screen) {
    const review = screen.archived ? screen.archived.review : screen.item?.lifecycle?.review;
    const formal = review?.formal;
    if (!formal || !['approved', 'rejected', 'provisional'].includes(formal.state) ||
        !formalSession(formal.sessionId) || !positive(formal.round) ||
        !digest.test(formal.proposalSha256) || !digest.test(formal.manifestSha256)) return null;
    return this.sessionLink(screen, 'reviews', formal.sessionId);
  }

  delegationLink(screen) {
    if (!this.isCurrent(screen) || screen.kind !== 'detail' || screen.item?.job?.linked !== true) return null;
    return this.sessionLink(screen, 'delegations', screen.item.job.sessionId);
  }

  sessionLink(screen, tab, id) {
    if (!this.isCurrent(screen) || !safeSession(id)) return null;
    return { tab, id, project: screen.scope.project, machine: screen.scope.engine.machine };
  }
}
