import { realpathSync } from 'node:fs';
import { readPublicationWorkItem } from './work-items.js';

// Internal fixture adapter. No public command accepts the binding or paths;
// installed operator enrollment remains a separate G3 gate.
export function createFixtureWorkItemReader({ project, itemId, links }) {
  let root;
  try { root=realpathSync.native(project); } catch { throw Object.assign(new Error('storage_error'),{code:'storage_error'}); }
  if (!links || typeof links.owns !== 'function' || typeof links.readerIdentity !== 'function' ||
      typeof links.inspect !== 'function' || typeof links.publicationTarget !== 'function' || !links.owns(root))
    throw Object.assign(new Error('scope_conflict'),{code:'scope_conflict'});
  return () => {
    if (!links.owns(root)) throw Object.assign(new Error('scope_conflict'),{code:'scope_conflict'});
    const item=readPublicationWorkItem(root,itemId);
    const installationId=links.readerIdentity(itemId);
    const plane=links.inspect(itemId);
    const target=links.publicationTarget(itemId);
    if (!plane.link) throw Object.assign(new Error('scope_conflict'),{code:'scope_conflict'});
    return { installationId,itemId,itemRevision:item.revision,linkRevision:plane.link.linkRevision,status:item.status,target,integrity:false };
  };
}
