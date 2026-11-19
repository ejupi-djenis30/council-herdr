import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

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

export function readText(path, limit) {
  const info = stat(path);
  if (!info) return null;
  if (!info.isFile() || info.size > limit) throw new Error(`Invalid or oversized file: ${basename(path)}.`);
  const content = readFileSync(path);
  if (content.length > limit) throw new Error(`Invalid or oversized file: ${basename(path)}.`);
  return content.toString('utf8');
}
