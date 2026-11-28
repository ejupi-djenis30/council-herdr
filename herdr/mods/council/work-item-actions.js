const states = new Set(['draft', 'in_progress', 'needs_attention', 'result_ready']);
const typedErrors = new Set(['invalid_input', 'not_found', 'role_unavailable', 'conflict', 'integrity_error', 'storage_error']);
const definiteRejections = new Set(['invalid_input', 'not_found', 'role_unavailable', 'conflict']);
const itemId = /^wi-[a-z0-9][a-z0-9-]{0,59}$/;
const roleId = /^[a-z][a-z0-9-]{0,31}$/;
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

function validItem(item, detail) {
  if (!item || !itemId.test(item.id) || !text(item.title) || !text(item.roleId) || !roleId.test(item.roleId) || !text(item.createdAt) ||
      !states.has(item.state) || !text(item.nextAction) || typeof item.canDelegate !== 'boolean' ||
      (item.canDelegate && item.state !== 'draft') || (item.attention !== null && !message(item.attention))) return false;
  const job = item.job;
  if (job !== null && (!job || !text(job.sessionId) || typeof job.linked !== 'boolean' || !text(job.outcome) ||
      ![job.deliveryState, job.deadlineAt, job.address].every(nullableText))) return false;
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

async function invoke(runCli, scope, operation, payload) {
  const flags = operation === 'create' ? ['--input-json', JSON.stringify(payload)]
    : payload === undefined ? [] : ['--id', payload];
  let response;
  try {
    response = await runCli(scope.project, ['work-item', operation, ...flags], scope.engine);
  } catch (error) {
    throw problem('transport', `Could not reach Council on the project machine. Check the connection or installation, then refresh. ${error.message}`);
  }
  let record;
  try { record = JSON.parse(response.stdout); } catch { throw unavailable(scope, response); }
  const sameProject = typeof record?.project === 'string' && folderKey(record.project) === folderKey(scope.project);
  if (response.code !== 0 && record?.success === false && message(record.error) && typedErrors.has(record.error.code) &&
      (sameProject || (record.project === null && ['invalid_input', 'storage_error'].includes(record.error.code)))) {
    throw problem(record.error.code, record.error.message);
  }
  if (response.code !== 0 || record?.success !== true || !sameProject) throw unavailable(scope, response);
  if (operation === 'list') {
    if (Array.isArray(record.items) && record.items.every(item => validItem(item, false)) &&
        Array.isArray(record.errors) && record.errors.every(error => text(error?.id) && message(error))) return record;
  } else if (validItem(record.item, true) && record.item.id === (operation === 'create' ? payload.id : payload)) {
    return record.item;
  }
  throw unavailable(scope, response);
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
  constructor({ runCli, readTeam, visible = () => true, createId = newWorkItemId }) {
    this.runCli = runCli;
    this.readTeam = readTeam;
    this.visible = visible;
    this.createId = createId;
    this.current = null;
    this.creates = new Map();
    this.delegates = new Map();
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

  async showList(scope = this.current?.scope) {
    if (!scope) return;
    const screen = { kind: 'list', scope };
    this.current = screen;
    await this.refresh(screen);
  }

  async open(screen, id) {
    if (!this.isCurrent(screen) || screen.kind !== 'list' || !screen.items?.some(item => item.id === id)) return;
    this.current = { kind: 'detail', scope: screen.scope, id };
    await this.refresh(this.current);
  }

  async refresh(screen) {
    if (!this.isCurrent(screen)) return;
    if (screen.kind === 'list') {
      await this.read(screen, () => this.request(screen.scope, 'list'), ({ items, errors }) => Object.assign(screen, { items, errors }));
    } else if (screen.kind === 'detail') {
      await this.read(screen, () => this.request(screen.scope, 'show', screen.id), item => {
        screen.item = item;
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
      if (!Array.isArray(roster?.members) || !roster.members.every(member => text(member?.id) && roleId.test(member.id) && text(member.role))) {
        throw new Error('Council returned an unreadable Team roster. Refresh the roles or update Council on the project machine.');
      }
      screen.roles = roster.members.map(({ id, role }) => ({ id, role }));
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
    if (!this.isCurrent(screen) || screen.kind !== 'detail' || screen.pending ||
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

  delegationLink(screen) {
    if (!this.isCurrent(screen) || screen.kind !== 'detail' || screen.item?.job?.linked !== true) return null;
    return { tab: 'delegations', id: screen.item.job.sessionId, project: screen.scope.project, machine: screen.scope.engine.machine };
  }
}
