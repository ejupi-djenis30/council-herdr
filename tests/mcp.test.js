import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CouncilMcpServer } from '../lib/mcp-server.js';

test('CouncilMcpServer handles initialize request', async () => {
  const server = new CouncilMcpServer();
  let response = null;
  server.send = (msg) => { response = msg; };

  await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  });

  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.equal(response.result.serverInfo.name, 'council-herdr');
});

test('CouncilMcpServer lists all council tools', async () => {
  const server = new CouncilMcpServer();
  let response = null;
  server.send = (msg) => { response = msg; };

  await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });

  assert.equal(response.id, 2);
  const toolNames = response.result.tools.map(t => t.name);
  assert.ok(toolNames.includes('council_status'));
  assert.ok(toolNames.includes('council_cast_ballot'));
  assert.ok(toolNames.includes('council_convene'));
  assert.ok(toolNames.includes('council_delegate'));
  assert.ok(toolNames.includes('council_wait'));
  assert.ok(toolNames.includes('council_read'));
  assert.ok(toolNames.includes('council_send'));
  assert.ok(toolNames.includes('council_dismiss'));
});

test('CouncilMcpServer lists resources and prompts', async () => {
  const server = new CouncilMcpServer();
  let resList = null;
  server.send = (msg) => { resList = msg; };

  await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.equal(resList.result.resources.length, 3);

  let promptList = null;
  server.send = (msg) => { promptList = msg; };
  await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
  assert.equal(promptList.result.prompts.length, 2);
});

test('CouncilMcpServer executes tools via tools/call', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'council-mcp-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const server = new CouncilMcpServer({ cwd });
  let response = null;
  server.send = (msg) => { response = msg; };

  // Mock herdr methods
  server.herdr.doctor = () => ({ herdrInstalled: true, hcVersion: 'hc 0.1.21', agents: {} });
  server.herdr.list = () => ({ success: true, terminals: [] });
  server.herdr.read = (target) => ({ success: true, target, content: 'Terminal content' });
  server.herdr.send = (target, msg) => ({ success: true, target, output: 'sent' });
  server.herdr.wait = (target) => ({ success: true, target, output: 'finished' });
  server.herdr.dismiss = (target) => ({ success: true, target });

  // Test council_status
  await server.handleMessage({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'council_status', arguments: {} }
  });
  assert.equal(response.id, 10);
  const advertised = JSON.parse(response.result.content[0].text);
  assert.equal(advertised.status, 'unverified');
  assert.equal(advertised.integration.hostInventory.state, 'unverified');
  const names = advertised.integration.liveServer.tools;
  const hidden = ['council_schedule_create', 'council_schedules', 'council_round', 'council_retally',
    'council_report_progress', 'council_team_list', 'council_team_call'];
  const status = async hostTools => {
    await server.handleMessage({ id: 10, method: 'tools/call', params: { name: 'council_status', arguments: { hostTools } } });
    return JSON.parse(response.result.content[0].text);
  };
  const exposed = names.filter(name => !hidden.includes(name)).map(name => 'council_' + name);
  const partial = await status([...exposed, ...hidden.map(name => 'other_' + name), ...exposed]);
  assert.equal(partial.status, 'degraded');
  assert.deepEqual(partial.integration.hostInventory, { state: 'incomplete', expectedCount: names.length,
    availableCount: names.length - hidden.length, missingTools: hidden });
  assert.deepEqual(partial.integration.liveServer.tools, names);
  assert.deepEqual(partial.integration.issues[0].missingTools, hidden);
  assert.equal((await status(names.map(name => 'tools.council.' + name))).status, 'ok');

  // Test council_read
  await server.handleMessage({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'council_read', arguments: { target: 't1', lines: 50 } }
  });
  assert.equal(response.id, 11);
  assert.equal(response.result.content[0].text, 'Terminal content');

  // Test council_send
  await server.handleMessage({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'council_send', arguments: { target: 't1', message: 'hello' } }
  });
  assert.equal(response.id, 12);
  assert.match(response.result.content[0].text, /Message sent to t1/);

  // Test council_dismiss
  await server.handleMessage({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'council_dismiss', arguments: { target: 't1' } }
  });
  assert.equal(response.id, 13);
  assert.match(response.result.content[0].text, /Dismissed terminal t1/);

  // Test council_cast_ballot
  const testSid = `test-ballot-mcp-${Date.now().toString(36)}`;
  await server.handleMessage({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: {
      name: 'council_cast_ballot',
      arguments: {
        sessionId: testSid,
        voter: 'council-skeptic',
        role: 'skeptic',
        agent: 'codex',
        vote: 'amend',
        score: 7,
        rationale: 'Edge case in connection pooling needs explicit timeout',
        amendments: ['Add 5s connect timeout']
      }
    }
  });
  assert.equal(response.id, 14);
  const ballotResult = JSON.parse(response.result.content[0].text);
  assert.equal(ballotResult.status, 'ok');
  assert.equal(ballotResult.ballot.voter, 'council-skeptic');
  assert.equal(ballotResult.ballot.vote, 'amend');
  assert.equal(ballotResult.ballot.score, 7);
  assert.equal(ballotResult.ballot.$schema, 'council.ballot/v1');

});
