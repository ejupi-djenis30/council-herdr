import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, sep, join } from 'node:path';

const address = process.env.HC_TERMINAL_ID;
const root = process.env.COU7_PROJECT;
const cli = process.env.COU7_CLI;
const events = process.env.COU7_EVENTS;
assert.ok(address && process.env.HC_SESSION?.startsWith('cou7-linux-'));
assert.equal(process.cwd(), root);
const log = (event, data = {}) => appendFileSync(events, JSON.stringify({ event, address, ...data }) + '\n');
const report = state => process.stdout.write(`\x1b]7501;state=${state}:app=junie\x1b\\`);
function mcp(id, method, params = {}) {
  const input = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cou7-fixture', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id, method, params }
  ].map(v => JSON.stringify(v)).join('\n') + '\n';
  const child = spawnSync(process.execPath, [cli, 'mcp'], { cwd: root, input, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0);
  const result = child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)).find(x => x.id === id)?.result;
  assert.ok(result && !result.isError);
  return result;
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
let input = '';
let assignments = 0;
let turns = Promise.resolve();
async function accept(line) {
  const path = /Read and execute instructions in (.*\.md)\. Report findings when done\./.exec(line)?.[1];
  if (!path) return;
  report('working');
  const rel = relative(join(root, '.agent_workspace'), path);
  assert.ok(rel && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  const brief = readFileSync(path, 'utf8');
  assert.ok(brief.includes('Name the first heading.'));
  assert.ok(brief.includes('Give a concrete next action.'));
  assert.equal(++assignments, 1);
  log('assignment', { count: assignments });
  // Coordinate observation only; the actual delivery already arrived via Herdr.
  await writeFile(process.env.COU7_READY_FIFO, address + '\n');
  assert.equal((await readFile(process.env.COU7_RELEASE_FIFO, 'utf8')).trim(), 'release');
  console.log('Heading: # Linux Native Checkpoint');
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
    turns = turns.then(() => accept(line)).catch(() => {
      log('error');
      console.error('Fixture validation failed');
      report('error');
    });
  }
});
process.stdin.resume();
