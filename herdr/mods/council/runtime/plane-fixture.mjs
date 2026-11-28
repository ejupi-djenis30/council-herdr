// G1 is a fixture-only, read-only provider client. This module has no HTTP
// implementation, credential access, sender, installed enrollment or authority.
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync, statSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readBytes } from './store-files.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const itemId = value => typeof value === 'string' && /^wi-[a-z0-9][a-z0-9-]{0,59}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = code => Object.assign(new Error(code), { code });
const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

// A fixture result is never installed admission. G3 must establish the real
// principal, storage and provider boundary independently of these booleans.
export function assessFixtureAdmission(evidence) {
  const gates = ['operatorBoundary', 'principal', 'credentialBoundary', 'durableFence', 'providerRole'];
  if (!exactKeys(evidence, gates) || gates.some(key => typeof evidence[key] !== 'boolean')) throw error('invalid_input');
  return { fixtureEligible: gates.every(key => evidence[key]), missing: gates.filter(key => !evidence[key]), publisherAvailable: false };
}

export function parseEvidenceUrl(url, registry) {
  if (typeof url !== 'string' || !registry || typeof registry.fullName !== 'string' ||
      !Number.isSafeInteger(registry.id) || registry.id < 1 || registry.public !== true ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/.test(registry.fullName)) throw error('evidence_unverified');
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(pull\/([1-9][0-9]*)|commit\/([a-f0-9]{40}))$/.exec(url);
  if (!match || match[1] !== registry.fullName || (match[3] && !Number.isSafeInteger(Number(match[3])))) throw error('evidence_unverified');
  return { url, repository: match[1], kind: match[3] ? 'pull' : 'commit', reference: match[3] ?? match[4] };
}

function validateProfile(profile) {
  const fields = ['instanceId', 'instanceLabel', 'origin', 'workspaceSlug', 'workspaceId', 'projectKey', 'projectId', 'principalId', 'allowedRoles'];
  if (!exactKeys(profile, fields) || !uuid(profile.instanceId) || !uuid(profile.workspaceId) || !uuid(profile.projectId) || !uuid(profile.principalId) ||
      typeof profile.instanceLabel !== 'string' || profile.instanceLabel.length < 1 || profile.instanceLabel.length > 80 ||
      /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(profile.instanceLabel) || profile.instanceLabel.trim() !== profile.instanceLabel ||
      typeof profile.workspaceSlug !== 'string' || profile.workspaceSlug.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.workspaceSlug) ||
      typeof profile.projectKey !== 'string' || !/^[A-Z][A-Z0-9]{0,19}$/.test(profile.projectKey) ||
      !Array.isArray(profile.allowedRoles) || !profile.allowedRoles.length || !profile.allowedRoles.every(r => Number.isSafeInteger(r) && r >= 0)) throw error('invalid_input');
  let url;
  try { url = new URL(profile.origin); } catch { throw error('invalid_input'); }
  if (url.origin !== profile.origin || url.username || url.password || !((url.protocol === 'https:') ||
      (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.port))) throw error('invalid_input');
}

async function get(transport, route) {
  let response;
  try { response = await transport.get(route); } catch { throw error('offline'); }
  if (!response || response.redirected || response.status !== 200 || !response.body || typeof response.body !== 'object' || Array.isArray(response.body))
    throw error(response?.status === 401 || response?.status === 403 ? 'authorization_denied' : 'scope_conflict');
  try { if (Buffer.byteLength(JSON.stringify(response.body)) > 1024 * 1024) throw error('scope_conflict'); }
  catch { throw error('scope_conflict'); }
  return response.body;
}

async function verify(profile, ref, transport, guard = () => {}) {
  const guardedGet = async route => {
    guard();
    try { return await get(transport, route); }
    finally { guard(); }
  };
  const base = `/api/v1/workspaces/${profile.workspaceSlug}`;
  const user = await guardedGet('/api/v1/users/me/');
  if (user.id !== profile.principalId) throw error('authorization_denied');
  const project = await guardedGet(`${base}/projects/${profile.projectId}/`);
  if (project.id !== profile.projectId || project.workspace !== profile.workspaceId || project.identifier !== profile.projectKey ||
      project.archived_at !== null || project.deleted_at !== null || project.is_member !== true || !profile.allowedRoles.includes(project.member_role)) throw error('scope_conflict');
  let id = ref, sequence;
  if (!uuid(ref)) {
    const pattern = new RegExp(`^${profile.projectKey}-([1-9][0-9]*)$`);
    const match = typeof ref === 'string' && pattern.exec(ref);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw error('invalid_input');
    sequence = Number(match[1]);
    const human = await guardedGet(`${base}/work-items/${ref}/`);
    if (!uuid(human.id) || human.workspace !== profile.workspaceId || human.project !== profile.projectId || human.sequence_id !== sequence) throw error('scope_conflict');
    id = human.id;
  }
  const issue = await guardedGet(`${base}/projects/${profile.projectId}/work-items/${id}/`);
  if (issue.id !== id || issue.workspace !== profile.workspaceId || issue.project !== profile.projectId ||
      !Number.isSafeInteger(issue.sequence_id) || issue.sequence_id < 1 || (sequence !== undefined && issue.sequence_id !== sequence) ||
      issue.archived_at !== null || issue.deleted_at !== null || issue.is_draft !== false) throw error('scope_conflict');
  return { linkRevision: 1, instanceId: profile.instanceId, instanceLabel: profile.instanceLabel,
    workspaceSlug: profile.workspaceSlug, workspaceId: profile.workspaceId, projectKey: profile.projectKey,
    projectId: profile.projectId, itemIdentifier: `${profile.projectKey}-${issue.sequence_id}`, itemId: id };
}

// Only a caller-supplied fixture context can instantiate this object. No CLI,
// MCP or installed entry point constructs it or accepts its private paths.
export function createFixtureOperator({ privateRoot, project, installationId, profile, transport, itemExists, now = Date.now }) {
  validateProfile(profile);
  if (!uuid(installationId) || typeof itemExists !== 'function' || !transport || typeof transport.get !== 'function') throw error('invalid_input');
  const root = realpathSync.native(project);
  const privateDir = realpathSync.native(privateRoot);
  const projectStat = statSync(root, { bigint: true });
  if (!projectStat.isDirectory() || !projectStat.ino) throw error('scope_conflict');
  const identity = [projectStat.dev.toString(), projectStat.ino.toString()];
  const pins = structuredClone(profile);
  const scope = hash(['council.plane-scope/v1', installationId, root, ...identity]);
  const candidates = new Map();
  const pathFor = id => join(privateDir, hash(['council.plane-link/v1', scope, id]) + '.json');
  const refFor = id => `local-${hash([scope, id])}`;
  function owns(project) {
    try {
      const stat = statSync(root, { bigint: true });
      return realpathSync.native(project) === root && stat.isDirectory() && stat.dev.toString() === identity[0] && stat.ino.toString() === identity[1];
    } catch { return false; }
  }
  function requireItem(id) { if (!owns(root) || !itemId(id) || !itemExists(root, id)) throw error('scope_conflict'); }
  function read(id) {
    requireItem(id);
    let record;
    try {
      const bytes = readBytes(pathFor(id), 16384);
      if (bytes === null) return null;
      record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { throw error('integrity_error'); }
    const link = record?.link;
    if (!exactKeys(record, ['schema', 'scope', 'installationId', 'itemId', 'profile', 'link']) || record.schema !== 'council.plane-link/v1' ||
        record.scope !== scope || record.installationId !== installationId || record.itemId !== id || JSON.stringify(record.profile) !== JSON.stringify(pins) ||
        !exactKeys(link, ['linkRevision', 'instanceId', 'instanceLabel', 'workspaceSlug', 'workspaceId', 'projectKey', 'projectId', 'itemIdentifier', 'itemId']) ||
        link.linkRevision !== 1 || link.instanceId !== pins.instanceId || link.instanceLabel !== pins.instanceLabel ||
        link.workspaceSlug !== pins.workspaceSlug || link.workspaceId !== pins.workspaceId || link.projectKey !== pins.projectKey ||
        link.projectId !== pins.projectId || !uuid(link.itemId) || typeof link.itemIdentifier !== 'string' ||
        !new RegExp(`^${pins.projectKey}-[1-9][0-9]*$`).test(link.itemIdentifier) || !Number.isSafeInteger(Number(link.itemIdentifier.slice(pins.projectKey.length + 1)))) throw error('integrity_error');
    return link;
  }
  return {
    owns,
    readerIdentity(id) { requireItem(id); return installationId; },
    publicationTarget(id) {
      const link = read(id);
      if (!link) throw error('scope_conflict');
      return { instanceId:pins.instanceId, origin:pins.origin, workspaceSlug:pins.workspaceSlug, workspaceId:pins.workspaceId,
        projectKey:pins.projectKey, projectId:pins.projectId, itemId:link.itemId,
        sequence:Number(link.itemIdentifier.slice(pins.projectKey.length + 1)), authorId:pins.principalId };
    },
    localRef(id) { requireItem(id); return refFor(id); },
    inspect(id) { return { availability: 'read_only', freshness: 'cached', link: read(id), operation: null }; },
    async resolve(id, ref) {
      requireItem(id);
      const link = await verify(pins, ref, transport);
      requireItem(id);
      const createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw error('scope_conflict');
      const candidate = { id: randomUUID(), item: id, scope, link, ref, createdAt, retired: false };
      candidates.set(candidate.id, candidate);
      return { candidateId: candidate.id, localRef: refFor(id), link: structuredClone(link), baseLinkRevision: 0 };
    },
    async confirm(id, candidateId, localRef) {
      requireItem(id);
      const c = candidates.get(candidateId);
      if (!c || c.item !== id || c.scope !== scope || localRef !== refFor(id)) throw error('scope_conflict');
      const checkedTime = previous => {
        if (c.retired) throw error('scope_conflict');
        const value = now();
        if (Number.isSafeInteger(value) && value - c.createdAt >= 300000) c.retired = true;
        if (c.retired || !Number.isSafeInteger(value) || value < previous) throw error('scope_conflict');
        return value;
      };
      const confirmedAt = checkedTime(c.createdAt);
      let current;
      try { current = await verify(pins, c.ref, transport, () => { if (c.retired) throw error('scope_conflict'); }); }
      catch (error) { checkedTime(confirmedAt); throw error; }
      const verifiedAt = checkedTime(confirmedAt);
      requireItem(id);
      if (JSON.stringify(current) !== JSON.stringify(c.link)) throw error('scope_conflict');
      const prior = read(id);
      const readAt = checkedTime(verifiedAt);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(c.link)) throw error('scope_conflict');
        return prior;
      }
      const record = { schema: 'council.plane-link/v1', scope, installationId, itemId: id, profile: pins, link: c.link };
      const temporary = join(privateDir, `.${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      try {
        checkedTime(readAt);
        try { linkSync(temporary, pathFor(id)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      } finally { unlinkSync(temporary); }
      const existing = read(id);
      if (JSON.stringify(existing) !== JSON.stringify(c.link)) throw error('scope_conflict');
      return existing;
    }
  };
}
