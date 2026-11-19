import { mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDirectory, readText } from './mods/council/runtime/store-files.mjs';

const bundled = new Set(['main', 'terminals', 'win98']);
const blockId = 'council-menu';
const maxLayoutSize = 1024 * 1024;

function layoutNodes(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(layoutNodes) : [])];
}

function hasLauncher(nodes) {
  const matches = nodes.filter(node => node.id === blockId);
  if (!matches.length) return false;
  if (matches.length === 1 && matches[0].type === 'block' && matches[0].content?.mod === 'council' &&
      matches[0].content.props?.role === 'launcher') return true;
  throw new Error(`The layout already uses the "${blockId}" block ID.`);
}

function insertLauncher(layout, nodes) {
  const columns = nodes.filter(node => node.type === 'column' && Array.isArray(node.children));
  const sidebar = columns.find(node => node.id === 'sidebar' && !node.hidden);
  const column = sidebar ?? columns.find(node => !node.hidden &&
    node.children.some(child => ['tabs', 'terminals-bar'].includes(child?.content?.mod))) ??
    columns.find(node => node === layout && !node.hidden);
  if (!column) throw new Error('No visible sidebar or toolbar column was found in this Herdr layout.');
  const anchor = column.children.findIndex(child => sidebar ? child?.id === 'brand'
    : ['tabs', 'terminals-bar'].includes(child?.content?.mod));
  column.children.splice(anchor + 1, 0, {
    id: blockId, type: 'block', size: { px: 44 }, content: { mod: 'council', props: { role: 'launcher' } }
  });
}

function savePersonalLayout(appHome, layouts, file, original, content) {
  const backups = join(appHome, 'council-backups');
  isDirectory(backups, { create: true });
  const archive = join(mkdtempSync(join(backups, 'layout-')), file);
  writeFileSync(archive, original, { flag: 'wx' });
  const path = join(layouts, file);
  const temporary = join(layouts, `.council-menu-${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { flag: 'wx' });
  try {
    if (!readFileSync(path).equals(original)) throw new Error('The Herdr layout changed during installation. Try again.');
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return archive;
}

export function prepareMenu(appHome, selectedLayout) {
  const layouts = join(appHome, 'layouts');
  if (!isDirectory(layouts)) throw new Error('Open Herdr Desktop once to initialize its layouts.');
  const shared = selectedLayout === undefined
    ? JSON.parse(readText(join(appHome, 'shared.json'), maxLayoutSize) ?? '{}') : {};
  const name = selectedLayout ?? shared?.layout ?? 'main';
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error('Invalid Herdr layout name.');
  }
  const installed = JSON.parse(readText(join(appHome, 'installed.json'), maxLayoutSize) ?? '{}');
  const clone = bundled.has(name) || Object.hasOwn(installed ?? {}, `layout:${name}`);
  const target = clone ? `council-${name}` : name;
  const targetPath = join(layouts, `${target}.json`);
  const targetText = readText(targetPath, maxLayoutSize);
  if (targetText !== null && hasLauncher(layoutNodes(JSON.parse(targetText)))) return () => ({ name: target, clone });
  if (clone && targetText !== null) {
    throw new Error(`Layout "${target}" already exists. Use --layout ${target} to add Council to it explicitly.`);
  }
  const file = `${name}.json`;
  const path = join(layouts, file);
  const source = clone ? readText(path, maxLayoutSize) : targetText;
  if (source === null) throw new Error(`Herdr layout "${name}" was not found.`);
  const layout = JSON.parse(source);
  insertLauncher(layout, layoutNodes(layout));
  const content = JSON.stringify(layout, null, 2) + '\n';
  return () => {
    if (clone) {
      writeFileSync(targetPath, content, { flag: 'wx' });
      return { name: target, clone };
    }
    const backup = savePersonalLayout(appHome, layouts, file, Buffer.from(source), content);
    return { name: target, clone, backup };
  };
}
