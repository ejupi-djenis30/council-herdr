import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, watch, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const cli = join(root, 'desktop-home', 'mods', 'council', 'engine', 'bin', 'council.js');
const project = realpathSync.native(join(root, 'ui-project'));
const address = process.env.HC_TERMINAL_ID;
assert.ok(address && process.env.HC_SESSION?.startsWith('cou7-win-x64-'));
assert.equal(realpathSync.native(process.cwd()), project);
const log = (event, data = {}) => appendFileSync(join(root, 'fixture-events.jsonl'), JSON.stringify({ event, address, ...data }) + '\n');
const report = state => process.stdout.write(`\x1b]7501;state=${state}:app=junie\x1b\\`);
function mcp(id, method, params = {}) {
  const input = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cou7-fixture', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id, method, params }
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  const child = spawnSync(process.execPath, [cli, 'mcp'], { cwd: project, input, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 0);
  const result = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)).find(x => x.id === id)?.result;
  assert.ok(result && !result.isError);
  return result;
}
function release() {
  const path = join(root, 'fixture-release.txt');
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(root, (_event, name) => { if (name === 'fixture-release.txt' && existsSync(path)) finish(resolve); });
    const timer = setTimeout(() => finish(() => reject(new Error('fixture release deadline'))), 100000);
    function finish(next) { watcher.close(); clearTimeout(timer); next(); }
    if (existsSync(path)) finish(resolve);
  });
}
assert.ok(process.argv.some(a => a.startsWith('--prompt=Council alignment check.')));
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004h');
report('working');
const hostTools = mcp(1, 'tools/list').tools.map(tool => tool.name);
const aligned = mcp(2, 'tools/call', { name: 'council_alignment', arguments: {
  action: 'report', state: 'aligned', revision: 'council/herdr-alignment-v2', hostTools
} });
assert.equal(JSON.parse(aligned.content[0].text).state, 'aligned');
log('aligned');
report('done');
let input = '', count = 0, turns = Promise.resolve();
async function accept(line) {
  const path = /Read and execute instructions in (.*\.md)\. Report findings when done\./.exec(line)?.[1];
  if (!path) return;
  report('working');
  const rel = relative(join(project, '.agent_workspace'), realpathSync.native(path.trim()));
  assert.ok(rel && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  const brief = readFileSync(path.trim(), 'utf8');
  assert.ok(brief.includes('Name the first heading.') && brief.includes('Give a concrete next action.'));
  assert.equal(++count, 1);
  log('assignment', { count });
  const staged = join(root, 'fixture-ready.partial');
  writeFileSync(staged, JSON.stringify({ address, pid: process.pid }));
  renameSync(staged, join(root, 'fixture-ready.json'));
  await release();
  console.log('Heading: # Windows Native Checkpoint');
  console.log('Next action: compare the heading with the saved criteria.');
  log('result');
  report('done');
}
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.search(/[\r\n]/)) >= 0) {
    const line = input.slice(0, end).replace(/\x1b\[(?:200|201)~/g, '');
    input = input.slice(end + 1);
    turns = turns.then(() => accept(line)).catch(() => { log('error'); console.error('Fixture validation failed'); report('error'); });
  }
});
process.stdin.resume();
