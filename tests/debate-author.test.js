import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';

const cli = fileURLToPath(new URL('../bin/council.js', import.meta.url));

test('CLI and MCP debate authors persist across terminal reuse and offline reads', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'council-author-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stub = join(cwd, 'herdr.mjs');
  writeFileSync(stub, `
    import child from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    child.execFile = (bin, args, options, callback) => {
      if (bin !== 'hc' || args.join(' ') !== 'get --json t17') throw new Error('Unexpected Herdr lookup');
      appendFileSync('lookups.txt', args.join(' ') + '\\n');
      const details = JSON.parse(process.env.DEBATE_TEST_TERMINAL);
      callback(details ? null : new Error('hc unavailable'), JSON.stringify(details), '');
    };
    syncBuiltinESMExports();`);
  const submit = (args, terminal, address = 't17', input) => {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, cli, ...args], { cwd, input,
      encoding: 'utf8', timeout: 10000, env: { ...process.env, HC_TERMINAL_ID: address, DEBATE_TEST_TERMINAL: JSON.stringify(terminal) } });
    assert.equal(child.status, 0, child.stderr);
    const data = JSON.parse(child.stdout);
    if (!input) return data;
    assert.notEqual(data.result.isError, true, data.result.content[0].text);
    return JSON.parse(data.result.content[0].text);
  };
  const live = (app, pid, created_ms) => ({ address: 't17', state: 'live', reported: true, status: { app }, pid, created_ms });
  const { sessionId } = submit(['debate', 'create', '--question', 'Ship?', '--context', 'Start review.'], live('junie', 10, 100));
  const mcpReply = (text, terminal) => submit(['mcp'], terminal, 't17', JSON.stringify({
    id: 1, jsonrpc: '2.0', method: 'tools/call', params: { name: 'council_debate_reply', arguments: { project: cwd, debateId: sessionId, text } }
  }) + '\n');
  mcpReply('Checked changes.', live('codex', 20, 200));
  mcpReply('Current process predates the terminal.', live('other', 30, Date.now() + 60000));
  submit(['debate', 'reply', sessionId, '--text', 'Offline post.'], null);
  submit(['debate', 'reply', sessionId, '--author', 'outside-agent', '--text', 'External post.'], null, '');
  const outcome = { decision: 'Ship', owner: 'QA', nextStep: 'Publish' };
  const decision = submit(['mcp'], live('junie', 10, 100), 't17', JSON.stringify({
    id: 1, method: 'tools/call', params: { name: 'council_debate_close', arguments: { project: cwd, debateId: sessionId, ...outcome } }
  }) + '\n');
  const closeArgs = ['debate', 'close', sessionId, '--decision', 'Ship', '--owner', 'QA', '--next-step', 'Publish'];
  assert.deepEqual(submit(closeArgs, live('replacement', 40, 400)), decision);
  const view = desktopRequest(cwd, 'debates', { id: sessionId }).debate;
  assert.deepEqual(view.creatorIdentity, { address: 't17', agent: 'junie', pid: 10, createdMs: 100 });
  assert.deepEqual(view.messages.map(m => [m.author, m.agent, m.authorIdentity?.pid]), [
    ['t17', 'junie', 10], ['t17', 'codex', 20], ['t17', undefined, undefined],
    ['t17', undefined, undefined], ['outside-agent', undefined, undefined]
  ]);
  assert.deepEqual(desktopRequest(cwd, 'debates', {}).debates[0].creatorIdentity, view.creatorIdentity);
  assert.deepEqual(view.decision.closedByIdentity, view.creatorIdentity);
  const saved = submit(['debate', 'show', sessionId], live('replacement', 40, 400));
  assert.deepEqual(saved.decision, decision);
  assert.deepEqual(saved.messages.map(m => m.authorIdentity), view.messages.map(m => m.authorIdentity));
  const other = submit(['debate', 'create', '--question', 'Record this?'], null, '');
  const cliClose = submit(closeArgs.map(value => value === sessionId ? other.sessionId : value), live('codex', 20, 200));
  assert.deepEqual(cliClose.closedByIdentity, { address: 't17', agent: 'codex', pid: 20, createdMs: 200 });
  assert.equal(readFileSync(join(cwd, 'lookups.txt'), 'utf8').trimEnd().split('\n').length, 7);
});
