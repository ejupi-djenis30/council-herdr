// G2 protocol fixture. There is no network implementation or installed
// authority: identity, consent, provider and directory acknowledgement are
// injected test doubles. T006's verified preview is supplied by the fixture.
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fixtureJournal, digest, tupleDigest, problem } from './plane-journal-fixture.mjs';
import { isFixturePlane } from './plane-transport-fixture.mjs';
import { parseEvidenceUrl } from './plane-fixture.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const opId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const timestamp = n => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
const statuses = ['open','in_review','closed'];
const targetKeys = ['instanceId','origin','workspaceSlug','workspaceId','projectKey','projectId','itemId','sequence','authorId'];

function validTarget(t) {
  if (!exact(t, targetKeys) || !uuid(t.instanceId) || !uuid(t.workspaceId) || !uuid(t.projectId) || !uuid(t.itemId) || !uuid(t.authorId) ||
      typeof t.workspaceSlug !== 'string' || t.workspaceSlug.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.workspaceSlug) ||
      typeof t.projectKey !== 'string' || !/^[A-Z][A-Z0-9]{0,19}$/.test(t.projectKey) || !Number.isSafeInteger(t.sequence) || t.sequence < 1) return false;
  try {
    const url = new URL(t.origin);
    return url.origin === t.origin && !url.username && !url.password && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname) && !!url.port));
  } catch { return false; }
}

function payload(snapshot) {
  return JSON.stringify({ access:'INTERNAL', comment_html:`<p>Council status: ${snapshot.status}</p><p>Evidence: ${snapshot.evidenceUrl}</p><p>Council publication: ${snapshot.operationId}</p>` });
}
function validSnapshot(s, registry) {
  if (!exact(s, ['operationId','itemRevision','linkRevision','status','evidenceUrl','createdAt','expiresAt']) || !opId(s.operationId) ||
      !Number.isSafeInteger(s.itemRevision) || s.itemRevision < 1 || !Number.isSafeInteger(s.linkRevision) || s.linkRevision < 1 ||
      !statuses.includes(s.status) || !timestamp(s.createdAt) || !timestamp(s.expiresAt) || s.expiresAt <= s.createdAt || s.expiresAt - s.createdAt > 300000) return false;
  try { parseEvidenceUrl(s.evidenceUrl, registry); return true; } catch { return false; }
}
function projection(record) {
  return { operationId:record.snapshot.operationId, itemRevision:record.snapshot.itemRevision, linkRevision:record.snapshot.linkRevision,
    status:record.snapshot.status, evidenceUrl:record.snapshot.evidenceUrl, visibility:'INTERNAL', state:record.state,
    reason:record.state === 'delivery_uncertain' ? 'receipt_not_proven' : record.reason ?? null, receipt:record.receipt ?? null };
}

export function createFixturePublisher({ privateRoot, project, installationId, itemId, target, registry, plane,
  operatorId, readCurrent, acknowledgeDirectory, now = Date.now, hook = () => {} }) {
  if (!uuid(installationId) || typeof itemId !== 'string' || !/^wi-[a-z0-9][a-z0-9-]{0,59}$/.test(itemId) ||
      !validTarget(target) || !uuid(operatorId) || !isFixturePlane(plane) || typeof readCurrent !== 'function' ||
      typeof acknowledgeDirectory !== 'function' || typeof now !== 'function' || typeof hook !== 'function') throw problem('invalid_input');
  // Validate the registry before any journal mutation without contacting GitHub.
  parseEvidenceUrl(`https://github.com/${registry?.fullName}/pull/1`, registry);
  let root, privateDir, info;
  try { root = realpathSync.native(project); privateDir = realpathSync.native(privateRoot); info = statSync(root, { bigint:true }); }
  catch { throw problem('storage_error'); }
  const relativePrivate = relative(root,privateDir);
  if (!relativePrivate || (relativePrivate !== '..' && !relativePrivate.startsWith(`..${sep}`) && !isAbsolute(relativePrivate))) throw problem('scope_conflict');
  if (!info.isDirectory() || !info.ino) throw problem('scope_conflict');
  const identity = [info.dev.toString(), info.ino.toString()];
  const targetPin = structuredClone(target), repoPin = structuredClone(registry);
  const scope = tupleDigest(['council.plane-publish-fixture/v1',installationId,root,...identity,itemId,targetPin,repoPin]);
  const idScope = tupleDigest(['council.plane-barrier-fixture/v1',installationId,root,...identity,itemId]);
  const ownScope = () => {
    try { const s = statSync(root, { bigint:true }); return realpathSync.native(project) === root && s.isDirectory() && s.dev.toString() === identity[0] && s.ino.toString() === identity[1]; }
    catch { return false; }
  };
  function fresh(s, at) {
    if (timestamp(at) && at >= s.expiresAt) throw Object.assign(problem('stale_preview'), { expiredAt:at });
    if (!ownScope() || !timestamp(at) || at < s.createdAt) throw problem('stale_preview');
    let current;
    try { current = readCurrent(); } catch { throw problem('scope_conflict'); }
    if (!current || current.installationId !== installationId || current.itemId !== itemId || current.itemRevision !== s.itemRevision ||
        current.linkRevision !== s.linkRevision || current.status !== s.status || !same(current.target, targetPin)) throw problem('scope_conflict');
  }
  // Replay validates hashes and transitions; malformed tails never grant a send.
  function fold(state, event) {
    if (!event) return { operations:{}, active:null, lastAt:0 };
    const d = event.data;
    if (!d || !timestamp(d.at) || d.at < state.lastAt) throw problem('integrity_error');
    const existing = state.operations[d.operationId];
    if (event.type === 'intent') {
      if (!exact(d,['at','operationId','snapshot','scope','target','payloadDigest','snapshotKey']) || existing || state.active ||
          Object.values(state.operations).some(r => r.state !== 'published' && !r.superseded) ||
          !validSnapshot(d.snapshot,repoPin) || d.operationId !== d.snapshot.operationId || d.scope !== scope || !same(d.target,targetPin) ||
          d.at < d.snapshot.createdAt || d.at >= d.snapshot.expiresAt ||
          Object.values(state.operations).some(r => r.snapshotKey === d.snapshotKey && !r.superseded) ||
          d.payloadDigest !== digest(payload(d.snapshot)) || d.snapshotKey !== tupleDigest([scope,itemId,d.snapshot.linkRevision,d.snapshot.itemRevision,d.snapshot.status,d.snapshot.evidenceUrl])) throw problem('integrity_error');
      state.operations[d.operationId] = { snapshot:d.snapshot, payloadDigest:d.payloadDigest, snapshotKey:d.snapshotKey, state:'prepared', receipt:null, approval:null, superseded:false, conflicts:[] };
    } else if (event.type === 'approval') {
      if (!exact(d,['at','operationId','approvalId','operatorId','payloadDigest']) || !existing || !['prepared','approved_unsent','offline'].includes(existing.state) ||
          !uuid(d.approvalId) || d.operatorId !== operatorId || d.payloadDigest !== existing.payloadDigest || d.at < existing.snapshot.createdAt || d.at >= existing.snapshot.expiresAt) throw problem('integrity_error');
      existing.approval = d.approvalId; existing.state = 'approved_unsent'; existing.reason = null;
    } else if (event.type === 'start') {
      if (!exact(d,['at','operationId','approvalId','payloadDigest']) || !existing || existing.state !== 'approved_unsent' || state.active ||
          d.approvalId !== existing.approval || d.payloadDigest !== existing.payloadDigest || d.at >= existing.snapshot.expiresAt) throw problem('integrity_error');
      existing.state = 'delivery_uncertain'; state.active = d.operationId;
    } else if (event.type === 'receipt') {
      if (!exact(d,['at','operationId','commentId','source','payloadDigest']) || !existing || existing.state !== 'delivery_uncertain' || state.active !== d.operationId ||
          !uuid(d.commentId) || !['response','reconciliation'].includes(d.source) || d.payloadDigest !== existing.payloadDigest) throw problem('integrity_error');
      existing.state = 'published'; existing.receipt = { commentId:d.commentId, operationId:d.operationId, verifiedAt:new Date(d.at).toISOString(), source:d.source }; state.active = null;
    } else if (event.type === 'receipt_conflict') {
      if (!exact(d,['at','operationId','commentId','source','payloadDigest']) || !existing || existing.state !== 'published' ||
          !uuid(d.commentId) || d.commentId === existing.receipt.commentId || !['response','reconciliation'].includes(d.source) ||
          d.payloadDigest !== existing.payloadDigest || existing.conflicts.includes(d.commentId)) throw problem('integrity_error');
      existing.conflicts.push(d.commentId);
    } else if (event.type === 'offline' || event.type === 'conflict' || event.type === 'expired') {
      if (!exact(d,['at','operationId','reason']) || !existing || !['prepared','approved_unsent','offline'].includes(existing.state) ||
          (event.type === 'offline' ? d.reason !== 'offline' : event.type === 'conflict' ? !['scope_conflict','authorization_denied','stale_preview'].includes(d.reason) :
            d.reason !== 'stale_preview' || d.at < existing.snapshot.expiresAt)) throw problem('integrity_error');
      existing.state = event.type; existing.reason = d.reason;
    } else if (event.type === 'cancel') {
      if (!exact(d,['at','operationId']) || !existing || !['prepared','approved_unsent','offline'].includes(existing.state)) throw problem('integrity_error');
      existing.state = 'cancelled';
    } else if (event.type === 'supersede') {
      if (!exact(d,['at','operationId']) || !existing || !['cancelled','conflict','expired'].includes(existing.state) || existing.superseded) throw problem('integrity_error');
      existing.superseded = true;
    } else throw problem('integrity_error');
    state.lastAt = d.at;
    return state;
  }
  // All target variants of a local item share the same barrier journal.
  const journal = fixtureJournal({ privateRoot:privateDir, scope:idScope, fold, acknowledgeDirectory, hook });
  function current() { if (!ownScope()) throw problem('scope_conflict'); return journal.read().state; }
  function at(state) { const n = now(); if (!timestamp(n) || n < state.lastAt) throw Object.assign(problem('stale_preview'), { rollbackAt:state.lastAt }); return n; }
  function saved(id) { const state = current(); const result = state.operations[id]; if (!result) throw problem('not_found'); return result; }
  function inspection(id) {
    if (!ownScope()) throw problem('scope_conflict');
    const head = journal.readPrefix();
    const record = id === undefined ? (head.state.active ? head.state.operations[head.state.active] : Object.values(head.state.operations).at(-1)) : head.state.operations[id];
    if (!record) {
      if (head.integrity) throw problem('integrity_error');
      if (id !== undefined) throw problem('not_found');
      return null;
    }
    const view = projection(record);
    if (!head.integrity) return view;
    // A damaged suffix may contain a Start even when the prefix does not.
    return { ...view, state:['prepared','approved_unsent','offline'].includes(view.state) ? 'delivery_uncertain' : view.state, reason:'integrity_error' };
  }
  function mark(id, type, observedAt, reason) {
    journal.append(type, state => {
      const r = state.operations[id];
      if (!r) throw problem('not_found');
      if (!['prepared','approved_unsent','offline'].includes(r.state) || state.active) return { result:projection(r) };
      const when = observedAt ?? at(state);
      if (!timestamp(when) || when < state.lastAt) throw problem('stale_preview');
      return { data:{at:when,operationId:id,reason:reason ?? (type === 'offline' ? 'offline' : type === 'expired' ? 'stale_preview' : 'scope_conflict')} };
    });
    return projection(saved(id));
  }
  function failedPrestart(id, e) {
    if (timestamp(e?.expiredAt)) return mark(id,'expired',e.expiredAt);
    if (timestamp(e?.rollbackAt)) return mark(id,'conflict',e.rollbackAt,'stale_preview');
    if (e?.code === 'offline') return mark(id,'offline');
    if (['scope_conflict','authorization_denied'].includes(e?.code)) return mark(id,'conflict',undefined,e.code);
    throw e;
  }
  function validComment(comment, snapshot) {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return false;
    return uuid(comment.id) && comment.workspace === targetPin.workspaceId && comment.project === targetPin.projectId && comment.issue === targetPin.itemId &&
      comment.actor === targetPin.authorId && comment.created_by === targetPin.authorId && comment.access === 'INTERNAL' && comment.parent === null &&
      comment.deleted_at === null && comment.edited_at === null && Array.isArray(comment.attachments) && comment.attachments.length === 0 &&
      comment.comment_html === JSON.parse(payload(snapshot)).comment_html;
  }
  function validPageRow(row) {
    return row && typeof row === 'object' && !Array.isArray(row) && uuid(row.id) &&
      row.workspace === targetPin.workspaceId && row.project === targetPin.projectId && row.issue === targetPin.itemId &&
      uuid(row.actor) && uuid(row.created_by) && ['INTERNAL','EXTERNAL'].includes(row.access) &&
      (row.parent === null || uuid(row.parent)) && (row.deleted_at === null || typeof row.deleted_at === 'string') &&
      (row.edited_at === null || typeof row.edited_at === 'string') && Array.isArray(row.attachments) &&
      typeof row.comment_html === 'string';
  }
  async function recordReceipt(id, commentId, source) {
    const record = saved(id);
    if (record.state === 'published' && record.receipt.commentId === commentId) return projection(record);
    const detail = await plane.detail(targetPin, commentId);
    if (!validComment(detail, record.snapshot) || detail.id !== commentId) return projection(saved(id));
    try {
      const result = journal.append('receipt', state => {
        const r = state.operations[id];
        if (r?.state === 'published') return { result:r.receipt.commentId === commentId ? 'same' : 'conflict' };
        if (r?.state !== 'delivery_uncertain' || state.active !== id) throw problem('scope_conflict');
        return { data:{ at:at(state), operationId:id, commentId, source, payloadDigest:r.payloadDigest } };
      });
      if (!result.written && result.result === 'conflict') {
        journal.append('receipt_conflict', state => {
          const r = state.operations[id];
          if (r?.state !== 'published' || r.receipt.commentId === commentId || r.conflicts.includes(commentId)) return {};
          return { data:{ at:at(state), operationId:id, commentId, source, payloadDigest:r.payloadDigest } };
        });
      }
    } catch { /* A failed write never invents a receipt. */ }
    return projection(saved(id));
  }
  return {
    matches(projectPath, selectedId, selectedInstallation, link) {
      if (!ownScope() || realpathSync.native(projectPath) !== root || selectedId !== itemId || selectedInstallation !== installationId || !link) return false;
      return link.instanceId === targetPin.instanceId && link.workspaceSlug === targetPin.workspaceSlug && link.workspaceId === targetPin.workspaceId &&
        link.projectKey === targetPin.projectKey && link.projectId === targetPin.projectId && link.itemId === targetPin.itemId &&
        link.itemIdentifier === `${targetPin.projectKey}-${targetPin.sequence}`;
    },
    owns(projectPath) { try { return ownScope() && realpathSync.native(projectPath) === root; } catch { return false; } },
    prepare(snapshot) {
      if (!validSnapshot(snapshot,repoPin)) throw problem('invalid_input');
      const proposed = structuredClone(snapshot);
      let output;
      const key = tupleDigest([scope,itemId,proposed.linkRevision,proposed.itemRevision,proposed.status,proposed.evidenceUrl]);
      journal.append('intent', state => {
        if (state.active) { output = projection(state.operations[state.active]); return {}; }
        const repeated = Object.values(state.operations).find(r => r.snapshotKey === key && !r.superseded);
        if (repeated) { output = projection(repeated); return {}; }
        if (Object.values(state.operations).some(r => r.state !== 'published' && !r.superseded) || state.operations[proposed.operationId]) throw problem('scope_conflict');
        const when = at(state); fresh(proposed, when);
        return { data:{ at:when, operationId:proposed.operationId, snapshot:proposed, scope, target:targetPin,
          payloadDigest:digest(payload(proposed)), snapshotKey:key } };
      });
      return output ?? projection(saved(proposed.operationId));
    },
    inspect(id) { return inspection(id); },
    latest() { return inspection(); },
    cancel(id) {
      journal.append('cancel', state => {
        const r = state.operations[id];
        if (!r) throw problem('not_found');
        if (!['prepared','approved_unsent','offline'].includes(r.state)) throw problem('scope_conflict');
        return { data:{at:at(state),operationId:id} };
      });
      return projection(saved(id));
    },
    supersede(id) {
      journal.append('supersede', state => {
        const r = state.operations[id];
        if (!r) throw problem('not_found');
        if (!['cancelled','conflict','expired'].includes(r.state) || r.superseded || state.active) throw problem('scope_conflict');
        return { data:{at:at(state),operationId:id} };
      });
      return projection(saved(id));
    },
    async confirm(id, approval) {
      if (!exact(approval,['operatorId','approved','payloadDigest']) || approval.approved !== true || approval.operatorId !== operatorId) throw problem('operator_required');
      let record = saved(id);
      if (['delivery_uncertain','published'].includes(record.state)) return projection(record);
      if (!['prepared','approved_unsent','offline'].includes(record.state) || approval.payloadDigest !== record.payloadDigest) throw problem('scope_conflict');
      let state = current(); let startTime = at(state);
      try { fresh(record.snapshot, startTime); } catch (e) { return failedPrestart(id,e); }
      try { await plane.verify(targetPin); } catch (e) { if (e.code === 'offline') return mark(id,'offline'); if (['authorization_denied','scope_conflict'].includes(e.code)) return mark(id,'conflict',undefined,e.code); throw e; }
      state = current(); const checked = at(state); if (checked < startTime) throw Object.assign(problem('stale_preview'), { rollbackAt:startTime });
      try { fresh(record.snapshot, checked); } catch (e) { return failedPrestart(id,e); }
      const approvalId = randomUUID();
      try {
        const result = journal.append('approval', s => {
          const r = s.operations[id];
          if (r?.state === 'delivery_uncertain' || r?.state === 'published') return { result:projection(r) };
          if (!r || !['prepared','approved_unsent','offline'].includes(r.state) || s.active || r.payloadDigest !== approval.payloadDigest) throw problem('scope_conflict');
          const when = at(s); fresh(r.snapshot, when);
          return { data:{at:when,operationId:id,approvalId,operatorId,payloadDigest:r.payloadDigest} };
        });
        if (!result.written) return result.result;
        hook('after_approval', 'approval');
        await plane.verify(targetPin);
        const resultStart = journal.append('start', s => {
          const r = s.operations[id];
          if (r?.state === 'delivery_uncertain' || r?.state === 'published') return { result:projection(r) };
          if (!r || r.state !== 'approved_unsent' || s.active) throw problem('scope_conflict');
          if (r.approval !== approvalId) return { result:projection(r) };
          const when = at(s); fresh(r.snapshot, when);
          return { data:{at:when,operationId:id,approvalId,payloadDigest:r.payloadDigest} };
        }, event => {
          const before = now();
          if (!timestamp(before) || before < event.data.at) throw Object.assign(problem('stale_preview'), { rollbackAt:event.data.at });
          fresh(record.snapshot, before);
          const after = now();
          if (!timestamp(after) || after < before) throw Object.assign(problem('stale_preview'), { rollbackAt:before });
          if (after >= record.snapshot.expiresAt) throw Object.assign(problem('stale_preview'), { expiredAt:after });
        });
        if (!resultStart.written) return resultStart.result;
        // Only this live call has a positive acknowledgement for its own Start.
        hook('after_start', 'start');
        record = saved(id);
        const reply = await plane.post(targetPin, payload(record.snapshot));
        hook('after_post', 'start');
        if (!reply || reply.status !== 201 || !uuid(reply.body?.id)) return projection(saved(id));
        return await recordReceipt(id, reply.body.id, 'response');
      } catch (e) {
        const r = saved(id);
        if (['prepared','approved_unsent','offline'].includes(r.state) && (timestamp(e?.expiredAt) || timestamp(e?.rollbackAt) || ['offline','scope_conflict','authorization_denied'].includes(e?.code))) return failedPrestart(id,e);
        return projection(r);
      }
    },
    async reconcile(id) {
      let record = saved(id);
      if (!['delivery_uncertain','published'].includes(record.state)) return projection(record);
      try {
        await plane.verify(targetPin);
        let cursor = null, found = null;
        const cursors = new Set(), ids = new Set();
        for (let i = 0; i < 10; i++) {
          const page = await plane.page(targetPin, cursor);
          if (!page || typeof page !== 'object' || Array.isArray(page) || !Object.hasOwn(page,'results') ||
              !Object.hasOwn(page,'next_page_results') || !Object.hasOwn(page,'next_cursor') || !Array.isArray(page.results) || page.results.length > 50 ||
              Buffer.byteLength(JSON.stringify(page)) > 1024 * 1024 || typeof page.next_page_results !== 'boolean' ||
              (page.next_page_results ? !page.results.length || typeof page.next_cursor !== 'string' || !page.next_cursor || Buffer.byteLength(page.next_cursor) > 1024 :
                page.next_cursor !== null && (typeof page.next_cursor !== 'string' || Buffer.byteLength(page.next_cursor) > 1024))) return projection(saved(id));
          for (const row of page.results) {
            if (!validPageRow(row) || ids.has(row.id)) return projection(saved(id));
            ids.add(row.id);
            if (row.comment_html.includes(record.snapshot.operationId)) {
              if (!validComment(row, record.snapshot) || found) return projection(saved(id));
              found = row.id;
            }
          }
          if (!page.next_page_results) return found ? await recordReceipt(id, found, 'reconciliation') : projection(saved(id));
          if (cursors.has(page.next_cursor)) return projection(saved(id));
          cursors.add(page.next_cursor); cursor = page.next_cursor;
        }
      } catch { /* Reconciliation is read-only and incomplete evidence stays uncertain. */ }
      record = saved(id); return projection(record);
    },
    payloadDigest(snapshot) { if (!validSnapshot(snapshot,repoPin)) throw problem('invalid_input'); return digest(payload(snapshot)); }
  };
}

// Optional in-process test reader; no installed entry point constructs one.
export function createFixturePublicationReader({ links, publisher }) {
  if (!links || !publisher || typeof links.owns !== 'function' || typeof links.readerIdentity !== 'function' ||
      typeof links.inspect !== 'function' || typeof publisher.matches !== 'function' || typeof publisher.owns !== 'function') throw problem('invalid_input');
  let selectedProject;
  function bound(id) {
    const installationId = links.readerIdentity(id);
    const plane = links.inspect(id);
    if (!publisher.matches(selectedProject,id,installationId,plane.link)) throw problem('scope_conflict');
    return plane;
  }
  function projected(plane, operation) {
    if (operation && operation.linkRevision !== plane.link.linkRevision) throw problem('scope_conflict');
    return { ...plane, operation };
  }
  return {
    owns(project) { selectedProject = project; return links.owns(project) && publisher.owns(project); },
    readerIdentity(id) { return links.readerIdentity(id); },
    inspect(id) { const plane = bound(id); return projected(plane,publisher.latest()); },
    inspectOperation(id, operationId) { const plane = bound(id); return projected(plane,publisher.inspect(operationId)); }
  };
}
