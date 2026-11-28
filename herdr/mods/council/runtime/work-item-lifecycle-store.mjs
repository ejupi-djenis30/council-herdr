import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, isDirectory, readBytes } from './store-files.mjs';

export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const hashTuple = tuple => hashBytes(Buffer.from(JSON.stringify(tuple), 'utf8'));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const actor = value => typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 120 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
const types = new Set(['triaged', 'attempt_reserved', 'review_started', 'review_note', 'formal_attached', 'review_returned', 'closed', 'reopened']);

// The baseline slot is the shared arbitration point with older Council clients.
export class LifecycleStore {
  constructor(store, id) {
    this.store = store;
    this.id = id;
  }

  marker(definitionBytes) {
    return { $schema: 'council.work-item-lifecycle/v2', id: this.id,
      definitionSha256: hashBytes(definitionBytes), activatedAt: new Date().toISOString() };
  }

  validMarker(marker, definitionBytes) {
    return Boolean(marker && Object.keys(marker).sort().join(',') === ['$schema', 'id', 'definitionSha256', 'activatedAt'].sort().join(',') &&
      marker.$schema === 'council.work-item-lifecycle/v2' && marker.id === this.id &&
      marker.definitionSha256 === hashBytes(definitionBytes) && time(marker.activatedAt));
  }

  activate(definitionBytes) {
    return this.store.publish(this.id, 2, this.marker(definitionBytes));
  }

  directory(create = false) {
    const item = this.store.directory(this.id, create);
    if (!item) return null;
    const dir = join(item, 'lifecycle');
    return isDirectory(dir, { create }) ? dir : null;
  }

  read(baseRevision, definitionBytes, slotBytes, apply) {
    const events = [];
    let revision = baseRevision;
    let previousSha256 = hashTuple([hashBytes(definitionBytes), hashBytes(slotBytes)]);
    const dir = this.directory();
    if (!dir) return { revision, previousSha256, events, integrity: null };
    const names = readdirSync(dir).filter(name => /^\d{8}\.json$/.test(name)).sort();
    const requests = new Set();
    for (const name of names) {
      try {
        if (name !== `${String(revision + 1).padStart(8, '0')}.json`) throw new Error('Journal revision gap.');
        const bytes = readBytes(join(dir, name), 65536);
        const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const valid = event && typeof event === 'object' && !Array.isArray(event) &&
          Object.keys(event).sort().join(',') === ['$schema','id','revision','expectedRevision','previousSha256','requestId','requestSha256','at','actor','type','data'].sort().join(',') &&
          event.$schema === 'council.work-item-event/v2' && event.id === this.id &&
          event.revision === revision + 1 && event.expectedRevision === revision && event.previousSha256 === previousSha256 &&
          requestId(event.requestId) && !requests.has(event.requestId) && digest(event.requestSha256) &&
          time(event.at) && actor(event.actor) && types.has(event.type) && event.data && typeof event.data === 'object' && !Array.isArray(event.data);
        if (!valid) throw new Error('Invalid journal event.');
        apply?.(event);
        requests.add(event.requestId);
        events.push(event);
        revision = event.revision;
        previousSha256 = hashBytes(bytes);
      } catch (error) {
        return { revision, previousSha256, events, integrity: { code: 'integrity_error', message: `Invalid lifecycle journal: ${error.message}` } };
      }
    }
    return { revision, previousSha256, events, integrity: null };
  }

  append(event) {
    const bytes = Buffer.from(JSON.stringify(event), 'utf8');
    if (bytes.length > 65536) throw new Error('Lifecycle event exceeds 64 KiB.');
    return appendEvent(this.directory(true), event.revision, event);
  }
}
