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

function validReceipt(receipt, key) {
  return receipt && receipt.requestId === key && text(receipt.event) && positive(receipt.revision) && typeof receipt.replay === 'boolean';
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

export function workItemActionEnabled(item, operation) {
  const lifecycle = item?.lifecycle;
  if (!lifecycle?.actions?.[workItemMutations[operation]?.action] || lifecycle.integrity) return false;
  const review = lifecycle.review;
  if (operation === 'delegate') return lifecycle.state === 'open' && item.state === 'draft';
  if (operation === 'start') return item.state === 'result_ready' && Boolean(item.result) && item.job?.linked === true;
  if (operation === 'return') return Boolean(review?.evidenceToken);
  if (operation === 'note' || operation === 'attach') return Boolean(review);
  if (operation === 'reopen') return lifecycle.state === 'closed' && lifecycle.decision?.disposition === 'accepted';
  return operation !== 'close' || Boolean(review?.capture.verified && review.evidenceToken &&
    (review.policy === 'operator' || review.formal?.state === 'approved'));
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

function matchingEvidence(operation, input, item) {
  return workItemActionEnabled(item, operation) && item.lifecycle.revision === input.ifRevision &&
    Object.entries(evidenceReferences(operation, item)).every(([key, current]) => Boolean(current) && current === input[key]);
}

function mutationInput(form, fields, key) {
  const { operation, item } = form;
  const refs = evidenceReferences(operation, item);
  if (Object.values(refs).some(value => !value)) throw problem('stale_evidence', 'Refresh the review to verify its evidence before confirming.');
  const input = { id: item.id, ifRevision: item.lifecycle.revision, requestId: key,
    actor: trimmed(fields.actor, 'an actor name', 120), ...refs };
  if (operation === 'triage') input.patch = triagePatch(form, fields);
  if (operation === 'start') Object.assign(input, { reviewOwnerRoleId: matchingRole(form, form.roleId), policy: form.policy });
  if (operation === 'note') Object.assign(input, { kind: form.noteKind, text: trimmed(fields.text, 'a review note') });
  if (operation === 'attach') {
    const formalSessionId = fields.formalSessionId.trim();
    const round = Number(fields.round.trim());
    if (!safeSession(formalSessionId) || !/^\d+$/.test(fields.round.trim()) || !positive(round)) {
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
  return JSON.stringify([scope.space, scope.engine.machine ?? null, folderKey(scope.project)]);
}

export function workItemScreenVisible(screen, { space, workspaceActive, target }) {
  const { scope } = screen;
  return Boolean(workspaceActive && space?.id === scope.space && (space.machine ?? null) === scope.engine.machine &&
    (screen.kind !== 'list' || folderKey(target) === folderKey(scope.anchor)));
}

function recoveryScope(scope) {
  return JSON.stringify([scope.engine.machine ?? null, folderKey(scope.project)]);
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
  }

  leave() {
    this.current = null;
  }

  isCurrent(screen) {
    return this.current === screen && this.visible(screen);
  }

  async read(screen, load, apply) {
    if (!this.isCurrent(screen) || screen.pending) return;
    screen.pending = true;
    screen.error = '';
    try {
      const data = await load();
      if (this.isCurrent(screen)) apply(data);
    } catch (error) {
      if (this.isCurrent(screen)) screen.error = error.message;
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
    this.current = { kind: 'detail', scope, id };
    const screen = this.current;
    await this.refresh(screen);
    if (archive) await this.openArchived(screen, archive);
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
        if (screen.form && !matchingEvidence(screen.form.operation, { ifRevision: screen.form.item.lifecycle.revision,
          ...evidenceReferences(screen.form.operation, screen.form.item) }, item)) {
          screen.form.stale = true;
        }
        const key = this.delegationKey(screen);
        if (this.delegates.get(key) !== 'writing') this.delegates.delete(key);
        const attempt = this.createAttempt(screen);
        if (attempt?.input.id === item.id && !['writing', 'checking'].includes(attempt.phase) && matches(item, attempt.input)) {
          this.creates.delete(recoveryScope(screen.scope));
        }
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
      this.current = { kind: 'detail', scope: screen.scope, id: item.id, item };
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
    const formalRequired = item.lifecycle.formalRequired === true || Boolean(item.lifecycle.decision?.formal);
    const form = {
      operation, item, roleId: operation === 'triage' ? item.roleId : '', formalRequired,
      policy: formalRequired ? 'formal' : 'operator', noteKind: 'finding', priority: item.lifecycle.priority,
      blockedBy: item.lifecycle.blockedBy.map(link => link.id).sort()
    };
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
    if (!this.isCurrent(screen) || screen.pending || !form || form.pending || form.stale ||
        this.mutation(screen) || !workItemActionEnabled(screen.item, form.operation)) return;
    let input;
    try {
      input = mutationInput(form, fields, newWorkItemId());
    } catch (error) {
      screen.error = error.message;
      return;
    }
    await this.sendMutation(screen, { input, operation: form.operation, scope: screen.scope });
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
          !validReceipt(record.receipt, input.requestId) || record.item.lifecycle.revision < record.receipt.revision) {
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
    const oldReceipt = attempt.receipt;
    attempt.phase = 'checking';
    attempt.message = '';
    const results = await Promise.allSettled([
      this.command(scope, ['history', '--id', input.id, '--request-id', input.requestId]),
      this.request(scope, 'show', input.id)
    ]);
    const lookup = results[0].status === 'fulfilled' ? results[0].value : null;
    const current = results[1].status === 'fulfilled' ? results[1].value : null;
    const receipt = lookup?.id === input.id && validReceipt(lookup.receipt, input.requestId) ? lookup.receipt : oldReceipt;
    if (receipt) attempt.receipt = receipt;
    if (this.isCurrent(screen) && current?.lifecycle) Object.assign(screen, { item: current, staleRead: false });
    if (receipt && current?.lifecycle?.revision >= receipt.revision) {
      this.acceptMutation(screen, attempt, current, receipt);
      return;
    }
    if (attempt.rejected || (lookup?.id === input.id && lookup.receipt === null && current?.lifecycle &&
        !matchingEvidence(operation, input, current))) {
      if (this.isCurrent(screen)) {
        if (screen.form) screen.form.stale = true;
        screen.staleRead = !current?.lifecycle;
        screen.error = 'The item or its evidence changed. Review the latest detail before making a new confirmation.';
      }
      this.mutations.delete(key);
      return;
    }
    const absent = lookup?.id === input.id && lookup.receipt === null && matchingEvidence(operation, input, current);
    attempt.phase = absent ? 'missing' : 'unresolved';
    attempt.message = receipt ? 'Council saved this request. Refresh to load the current detail.'
      : absent ? 'No receipt was found. Refresh again or explicitly resend the same request.'
        : 'Council could not verify the receipt and item. Refresh on the original project machine before resending.';
  }

  async replayMutation(screen) {
    const attempt = this.mutation(screen);
    if (!this.isCurrent(screen) || attempt?.phase !== 'missing' ||
        !matchingEvidence(attempt.operation, attempt.input, screen.item)) return;
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
