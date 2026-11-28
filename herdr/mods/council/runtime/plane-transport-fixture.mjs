// In-memory Plane double: no sockets, credentials, fetch, or arbitrary routes.
import { randomUUID } from 'node:crypto';
import { problem } from './plane-journal-fixture.mjs';

const fixtures = new WeakSet();
export const isFixturePlane = value => fixtures.has(value);
export function createFixturePlane(target, initial = {}) {
  const pinned = structuredClone(target);
  let mode = initial.mode ?? 'normal';
  let pageSize = initial.pageSize ?? 50;
  let pages = null;
  const comments = [];
  const calls = [];
  const planningFields = structuredClone(initial.planningFields ?? { title:'Fixture item', state:'planned', priority:'normal', assignees:[] });
  let posts = 0;
  let planningWrites = 0;
  const sameTarget = value => JSON.stringify(value) === JSON.stringify(pinned);
  const route = `/api/v1/workspaces/${pinned.workspaceSlug}/projects/${pinned.projectId}/work-items/${pinned.itemId}/comments/`;
  const api = {
    setMode(value) { mode = value; },
    setPages(value) { pages = value === null ? null : structuredClone(value); },
    setPageSize(value) { pageSize = value; },
    replaceComments(value) { comments.splice(0, comments.length, ...structuredClone(value)); },
    snapshot() { return structuredClone({ comments, calls, posts, planningWrites, planningFields }); },
    async verify(value) {
      calls.push({ method:'GET', kind:'scope' });
      if (!sameTarget(value) || mode === 'wrong_scope') throw problem('scope_conflict');
      if (mode === 'offline') throw problem('offline');
      if (mode === 'unauthorized') throw problem('authorization_denied');
      return true;
    },
    async post(value, bytes) {
      if (!sameTarget(value)) throw problem('scope_conflict');
      calls.push({ method:'POST', route, bytes }); posts++;
      if (mode === 'throw_before_commit') throw problem('offline');
      const body = JSON.parse(bytes);
      const comment = { id:randomUUID(), workspace:pinned.workspaceId, project:pinned.projectId, issue:pinned.itemId,
        actor:pinned.authorId, created_by:pinned.authorId, access:body.access, parent:null, deleted_at:null, edited_at:null,
        attachments:[], comment_html:body.comment_html };
      if (mode !== 'drop_without_commit') comments.push(comment);
      if (['drop_without_commit','commit_drop'].includes(mode)) throw problem('offline');
      if (mode === 'malformed_response') return { status:201, body:{} };
      return { status:201, body:{ id:comment.id } };
    },
    async detail(value, id) {
      calls.push({ method:'GET', kind:'detail', route:`${route}${id}/` });
      if (!sameTarget(value) || mode === 'offline' || mode === 'detail_error') throw problem('offline');
      const comment = comments.find(entry => entry.id === id);
      return comment ? structuredClone(comment) : null;
    },
    async page(value, cursor) {
      calls.push({ method:'GET', kind:'page', route, cursor });
      if (!sameTarget(value) || mode === 'offline' || mode === 'page_error') throw problem('offline');
      const index = cursor === null ? 0 : Number(cursor);
      if (pages) return structuredClone(pages[index] ?? null);
      if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1) throw problem('integrity_error');
      const start = index * pageSize;
      return { results:structuredClone(comments.slice(start, start + pageSize)), next_page_results:start + pageSize < comments.length,
        next_cursor:start + pageSize < comments.length ? String(index + 1) : null };
    },
  };
  fixtures.add(api);
  return Object.freeze(api);
}
