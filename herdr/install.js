import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isDirectory } from './mods/council/runtime/store-files.mjs';
import { prepareMenu } from './install-menu.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = join(repo, 'herdr', 'mods', 'council');
const receiptName = '.council-install.json';
const owner = 'council-herdr/desktop/v1';
const generated = new Set(['gpui-kit.d.ts', 'herdr.d.ts', 'jsconfig.json']);
const legacy = {
  'components.js': 'fdd07e3cd27e80113998ec92a9c10afa7e3a5fedbf25c2751c8941ff44173ceb',
  'main.js': '1d0dcbaf81783621a3bc3f189bc7c593dfccaedee7efc8c53ab1ba4d97251022',
  'mod.json': '384774d70297c6c8cec7e07653bb11867707b910233cd6bc7192bd86e3f82b5d',
  'poll-text.js': '82ca74c2d6ff4dc80cee8613f6c508c167b7a15f436f0ac9051100ad9a4a2ca0',
  'poll-view.js': 'd43e5ceb1269ced3636102c710eacced220b7c2f1d45aa83287ad8ab1c5925bd'
};
const files = [
  'mod.json', 'components.js', 'delegation-view.js', 'discussion-view.js', 'navigation.js', 'poll-text.js', 'poll-view.js', 'team-view.js', 'main.js',
  'runtime/alignment.mjs', 'runtime/council.mjs', 'runtime/debate-command.mjs', 'runtime/debate-room.mjs', 'runtime/delegations.mjs', 'runtime/desktop.mjs',
  'runtime/discussion.mjs', 'runtime/invitations.mjs', 'runtime/job-record.mjs', 'runtime/poll-command.mjs', 'runtime/wait-alignment.mjs',
  'runtime/polls.mjs', 'runtime/store-files.mjs', 'runtime/team.mjs',
  ...readdirSync(join(source, 'icons')).filter(name => name.endsWith('.svg')).map(name => `icons/${name}`)
];

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesInMod(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (['runtime', 'icons'].includes(entry.name) && entry.isDirectory()) {
      return readdirSync(join(folder, entry.name)).map(name => `${entry.name}/${name}`);
    }
    return generated.has(entry.name) || entry.name === receiptName ? [] : [entry.name];
  });
}

function sameFiles(folder, expected) {
  const present = filesInMod(folder);
  return present.length === Object.keys(expected).length && present.every(file => {
    const path = join(folder, file);
    return Object.hasOwn(expected, file) && lstatSync(path).isFile() && hash(path) === expected[file];
  });
}

function verifyOwnership(folder) {
  const receiptPath = join(folder, receiptName);
  if (readdirSync(folder).includes(receiptName)) {
    const receipt = lstatSync(receiptPath).isFile() ? json(receiptPath) : {};
    if (receipt.owner === owner && receipt.files && sameFiles(folder, receipt.files)) return;
  } else {
    // The previous local installer wrote checkout paths and shipped these exact files.
    const configPath = join(folder, 'config.json');
    if (readdirSync(folder).includes('config.json') && lstatSync(configPath).isFile()) {
      const config = json(configPath);
      if (config.bridge === join(repo, 'herdr', 'bridge.js') && config.cli === join(repo, 'bin', 'council.js') &&
          sameFiles(folder, { ...legacy, 'config.json': hash(configPath) })) return;
    }
  }
  throw new Error(`Council at ${folder} has local changes or was installed manually. Archive it before installing this build.`);
}

function install(appHome, upgrade) {
  mkdirSync(appHome, { recursive: true });
  const mods = join(appHome, 'mods');
  isDirectory(mods, { create: true });
  const destination = join(mods, 'council');
  const existing = isDirectory(destination);
  if (existing && !upgrade) throw new Error(`A mod already exists at ${destination}. Use --upgrade for a managed installation.`);

  const staging = mkdtempSync(join(appHome, '.council-stage-'));
  try {
    const prepared = join(staging, 'council');
    mkdirSync(join(prepared, 'runtime'), { recursive: true });
    mkdirSync(join(prepared, 'icons'));
    for (const file of files) copyFileSync(join(source, file), join(prepared, file));
    writeFileSync(join(prepared, 'config.json'), JSON.stringify({ node: process.execPath }, null, 2));
    const checksums = Object.fromEntries([...files, 'config.json'].map(file => [file, hash(join(prepared, file))]));
    writeFileSync(join(prepared, receiptName), JSON.stringify({ owner, files: checksums }, null, 2));

    let backup;
    if (existing) {
      verifyOwnership(destination);
      const backups = join(appHome, 'council-backups');
      isDirectory(backups, { create: true });
      backup = join(mkdtempSync(join(backups, 'council-')), 'council');
      renameSync(destination, backup);
    } else if (isDirectory(destination)) {
      throw new Error(`A mod appeared at ${destination} during install.`);
    }

    try {
      renameSync(prepared, destination);
    } catch (error) {
      if (backup) {
        if (isDirectory(destination)) throw new Error(`Install interrupted. Previous Council was saved at ${backup}.`, { cause: error });
        renameSync(backup, destination);
        rmdirSync(resolve(backup, '..'));
      }
      throw error;
    }
    return { destination, backup };
  } finally {
    // mkdtemp creates this private, absolute directory under the selected app home.
    rmSync(staging, { recursive: true, force: true });
  }
}

function addShortcut(appHome) {
  const path = join(appHome, 'keys.json');
  const original = readFileSync(path, 'utf8');
  const keys = JSON.parse(original);
  const shortcut = 'shift-f8';
  if (Object.values(keys).some(section => section && Object.keys(section).some(key => key.toLowerCase() === shortcut))) {
    if (keys.global?.[shortcut] === 'mod.open:council') return;
    throw new Error('Shift+F8 already has a binding.');
  }
  keys.global ??= {};
  keys.global[shortcut] = 'mod.open:council';
  const temporary = join(appHome, `.council-keys-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(keys, null, 2) + '\n', { flag: 'wx' });
  try {
    if (readFileSync(path, 'utf8') !== original) throw new Error('Herdr shortcuts changed during installation.');
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

try {
  const { values } = parseArgs({
    options: {
      'app-home': { type: 'string' }, shortcut: { type: 'boolean' }, menu: { type: 'boolean' }, layout: { type: 'string' },
      upgrade: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help) {
    console.log('Usage: node herdr/install.js [--menu [--layout <name>]] [--shortcut] [--upgrade] [--app-home <directory>]');
    process.exit(0);
  }
  if (values.layout !== undefined && !values.menu) throw new Error('--layout requires --menu.');
  const appHome = resolve(values['app-home'] || process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app'));
  const addMenu = values.menu ? prepareMenu(appHome, values.layout) : null;
  const { destination, backup } = install(appHome, values.upgrade);
  console.log(`Installed Council at ${destination}`);
  if (backup) console.log(`Previous installation archived at ${backup}`);
  if (addMenu) {
    const menu = addMenu();
    console.log(`Council menu added to layout "${menu.name}".`);
    if (menu.backup) console.log(`Previous layout archived at ${menu.backup}`);
    if (menu.clone) console.log(`Select "${menu.name}" in Herdr's layout picker or run: herdr-app do layout.switch --name ${menu.name}`);
  }
  if (values.shortcut) {
    try {
      addShortcut(appHome);
      console.log('Open Council in Herdr with Shift+F8.');
    } catch (error) {
      console.warn(`Shortcut skipped: ${error.message}`);
    }
  }
  console.log('Open from the command line: herdr-app do mod.open --name council');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
