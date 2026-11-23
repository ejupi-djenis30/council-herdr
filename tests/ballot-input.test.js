import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentWorkspace } from '../lib/workspace.js';

const entry = fileURLToPath(new URL('../bin/council.js', import.meta.url));

test('CLI and MCP require an explicit vote and preserve a prior formal rejection', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'council-explicit-ballot-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const workspace = new AgentWorkspace(cwd);
  const voter = 'reviewer';
  const proposal = 'Proposal under review';
  const { sessionId, sessionDir } = workspace.initSession({ sessionId: 'ballot-input', mode: 'review', task: proposal });
  const assignment = { voter, role: 'reviewer', agent: 'codex', rationale: 'Original reasoning', targetArtifactSha256: workspace.sha256(proposal) };
  const { ballotPath } = workspace.castBallot(sessionDir, { ...assignment, vote: 'reject' });
  const existing = readFileSync(ballotPath, 'utf8');
  const run = (args, input) => spawnSync(process.execPath, [entry, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });

  const cli = run(['cast-ballot', '--session', sessionId, '--voter', voter, '--rationale', 'No decision', '--target-sha', assignment.targetArtifactSha256]);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /--vote/);
  assert.equal(readFileSync(ballotPath, 'utf8'), existing);

  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'council_cast_ballot', arguments: { ...assignment, sessionId } } };
  const mcp = run(['mcp'], JSON.stringify(request) + '\n');
  assert.equal(mcp.status, 0, mcp.stderr);
  const response = JSON.parse(mcp.stdout).result;
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /explicit vote is required/);
  assert.equal(readFileSync(ballotPath, 'utf8'), existing);
  assert.equal(workspace.tallyBallots(sessionDir, 1, [voter], { expectedArtifactSha256: assignment.targetArtifactSha256 }).approveCount, 0);
});
