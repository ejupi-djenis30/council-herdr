// Herdr qualifies addresses in Desktop. Council records use the IDs seen by the
// core running on the project machine.
export function hostId(id, machine) {
  if (!id) return null;
  if (!machine) return id.includes('/') ? null : id;
  const prefix = machine + '/';
  const bare = id.startsWith(prefix) ? id.slice(prefix.length) : null;
  return bare && !bare.includes('/') ? bare : null;
}

export function desktopId(id, machine) {
  return id && machine ? machine + '/' + id : id;
}

export function focusedProject(focus, space) {
  return space && focus?.space === space.id && hostId(focus.terminal, space.machine) ? focus.cwd : null;
}

export function participantTerminal(job, machine, terminals) {
  if (job.team?.power === 'off' || !job.address) return null;
  const terminal = terminals.find(item => item.address === desktopId(job.address, machine) && item.state === 'live');
  if (!terminal) return null;
  if (job.participantCreatedMs != null && terminal.created_ms !== job.participantCreatedMs) return null;
  if (job.participantPid != null && terminal.pid !== job.participantPid) return null;
  return job.participantCreatedMs != null || job.ownership !== 'owned' && terminal.reported ? terminal : null;
}

const locateInstallation = `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HERDR_APP_HOME || path.join(require('node:os').homedir(), '.config', 'herdr-app');
const root = path.join(home, 'mods', 'council');
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const entry = path.join(root, 'runtime', 'council.mjs');
fs.accessSync(entry);
console.log(JSON.stringify({node: config.node || process.execPath, entry, cli: config.cli || path.join(root, 'engine', 'bin', 'council.js')}));
`;

export async function peerEngine(machine, execute, readFile) {
  if (!machine) throw new Error('A paired machine is required.');
  try {
    const options = { on: machine, timeout: 10000 };
    const args = ['--input-type=commonjs', '-e', locateInstallation];
    let result;
    try { result = await execute('node', args, options); }
    catch (launchError) {
      const path = '.config/herdr-app/mods/council/config.json';
      const configured = readFile && JSON.parse(await readFile(path, { on: machine }) || '{}').node;
      if (typeof configured !== 'string' || !configured.trim() || configured === 'node') throw launchError;
      result = await execute(configured, args, options);
    }
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Installation lookup failed.');
    const { node, cli, entry } = JSON.parse(result.stdout);
    if (![node, cli, entry].every(value => typeof value === 'string' && value.trim())) throw new Error('Invalid engine paths.');
    return { node, cli, entry, machine };
  } catch (error) {
    throw new Error(`Could not open Council on ${machine}. Check the connection, Node.js on PATH and the Council Desktop installation on that machine. ${error.message}`);
  }
}

export function executeEngine(execute, engine, script, args, cwd, timeout) {
  return execute(engine.node, [engine[script], ...args], { on: engine.machine ?? null, cwd, timeout });
}

export function invitationWorkerArgs(engine, name, folder, id) {
  return ['run', ...(engine.machine ? ['--on', engine.machine] : []), '--bg', '--json', '--no-parent', '--no-notify',
    '--outlive-parent', '--rm', '--name', name, '--cwd', folder, '--', engine.node, engine.entry, 'invite', id];
}
