import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function stat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function isDirectory(path, { create = false } = {}) {
  let info = stat(path);
  if (!info && create) {
    try {
      mkdirSync(path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    info = stat(path);
  }
  if (!info && !create) return false;
  if (!info?.isDirectory()) throw new Error(`Expected a regular directory for ${basename(path)}.`);
  return true;
}

export function isFile(path) {
  return stat(path)?.isFile() === true;
}

export function readBytes(path, limit) {
  const info = stat(path);
  if (!info) return null;
  if (!info.isFile() || info.size > limit) throw new Error(`Invalid or oversized file: ${basename(path)}.`);
  const content = readFileSync(path);
  if (content.length > limit) throw new Error(`Invalid or oversized file: ${basename(path)}.`);
  return content;
}

export function readText(path, limit) {
  return readBytes(path, limit)?.toString('utf8') ?? null;
}

export function eventFiles(dir) {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{8}\.json$/.test(entry.name)).map(entry => entry.name).sort();
}

export function appendEvent(dir, revision, event) {
  const target = join(dir, `${String(revision).padStart(8, '0')}.json`);
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(event), { flag: 'wx', mode: 0o600 });
  try {
    // Publish complete bytes only if another writer has not taken this revision.
    linkSync(temporary, target);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    unlinkSync(temporary);
  }
}
