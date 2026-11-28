import { realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, isDirectory, readBytes } from './store-files.mjs';

export const itemIdPattern = /^wi-[a-z0-9][a-z0-9-]{0,59}$/;
export class WorkItemStore {
  constructor(project) {
    this.root = realpathSync.native(project);
    if (!isDirectory(this.root)) throw new Error('Project must be an existing directory.');
    this.base = join(this.root, '.agent_workspace');
    this.dir = join(this.base, '.work-items');
  }
  directory(id, create = false) {
    if (!itemIdPattern.test(id)) throw new Error('Invalid work item ID.');
    if (!isDirectory(this.base, { create })) return null;
    if (!isDirectory(this.dir, { create })) return null;
    const dir = join(this.dir, id);
    return isDirectory(dir, { create }) ? dir : null;
  }
  read(id, revision) {
    const dir = this.directory(id);
    if (!dir) return null;
    const raw = readBytes(join(dir, `${String(revision).padStart(8, '0')}.json`), 65536);
    if (raw === null) return null;
    const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid work item event.');
    return event;
  }
  publish(id, revision, event) { return appendEvent(this.directory(id, true), revision, event); }
  hasPublishedEvents(id) {
    const dir = this.directory(id);
    return dir ? readdirSync(dir).some(name => /^\d{8}\.json$/.test(name)) : false;
  }
  ids() {
    if (!isDirectory(this.base) || !isDirectory(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true }).filter(e => itemIdPattern.test(e.name)).map(e => e.name);
  }
}
