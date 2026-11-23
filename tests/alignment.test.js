import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignmentChallenge, alignmentKey, alignmentOf, challengeKey, reportAlignment, skillRevision } from '../herdr/mods/council/runtime/alignment.mjs';
import { setupAlignment } from '../lib/alignment-setup.js';
import { CouncilMcpServer } from '../lib/mcp-server.js';

function terminal() {
  return { address: 't7', state: 'live', reported: true, created_ms: 1, pid: 23, status: { state: 'idle', app: 'claude-code' }, labels: {} };
}

function transport(subject, owner = subject.address) {
  const herdr = { terminalId: owner,
    get: address => ({ success: true, details: address === subject.address ? subject : null }),
    exec(argv) {
      assert.equal(argv[0], 'label');
      for (const argument of argv.slice(3)) {
        const [label, value] = argument.split('=');
        if (value) subject.labels[label] = value;
        else delete subject.labels[label];
      }
      return { success: true };
    }
  };
  return herdr;
}

test('readiness requires the current skill and MCP and expires with the terminal identity', async () => {
  const subject = terminal();
  const herdr = transport(subject);
  assert.throws(() => reportAlignment(herdr, { state: 'aligned', revision: skillRevision }), /MCP tool/);
  assert.throws(() => reportAlignment(herdr, { state: 'aligned', revision: 'previous' }, { viaMcp: true }), /current Council skill/);
  assert.equal(alignmentOf(subject), 'unconfirmed');
  assert.equal(reportAlignment(herdr, { state: 'not_aligned' }).state, 'not_aligned');
  assert.equal(alignmentOf(subject), 'not_aligned');

  const server = new CouncilMcpServer();
  server.herdr = herdr;
  let response;
  server.sendResult = (_id, value) => { response = value; };
  await server.handleToolCall(1, { name: 'council_alignment', arguments: { action: 'report', state: 'aligned', revision: skillRevision } });
  assert.equal(JSON.parse(response.content[0].text).state, 'aligned');
  assert.equal(alignmentOf(subject), 'aligned');
  assert.equal(alignmentOf({ ...subject, pid: subject.pid + 1 }), 'unconfirmed');
  assert.equal(alignmentOf(subject, Date.now() + 9 * 60 * 60 * 1000), 'unconfirmed');
});

test('an MCP host without Herdr identity uses a current one-time challenge only', () => {
  const subject = terminal();
  const herdr = transport(subject, 't9');
  const challenge = alignmentChallenge(subject);
  subject.labels[challengeKey] = challenge.argument.split('=')[1];
  const report = { target: subject.address, state: 'aligned', revision: skillRevision };
  assert.throws(() => reportAlignment(herdr, report, { viaMcp: true }), /challenge/);
  assert.throws(() => reportAlignment(herdr, { ...report, challenge: 'wrong' }, { viaMcp: true }), /challenge/);
  assert.equal(reportAlignment(herdr, { ...report, challenge: challenge.token }, { viaMcp: true }).address, 't7');
  assert.ok(subject.labels[alignmentKey]);
  assert.equal(subject.labels[challengeKey], undefined);
  assert.throws(() => reportAlignment(herdr, { ...report, challenge: challenge.token }, { viaMcp: true }), /challenge/);
});

test('project setup previews paths and updates Council without replacing other servers', t => {
  const project = mkdtempSync(join(tmpdir(), 'council-setup-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const request = { project, host: 'opencode' };
  const preview = setupAlignment(request);
  assert.equal(existsSync(preview.config), false);
  assert.equal(existsSync(preview.skill), false);
  const old = { mcp: { servers: { other: { type: 'local', command: ['other'] }, council: { type: 'local', command: ['old'] } } } };
  writeFileSync(preview.config, JSON.stringify(old));
  assert.throws(() => setupAlignment({ ...request, apply: true }), /--replace/);
  const result = setupAlignment({ ...request, apply: true, replace: true });
  const configured = JSON.parse(readFileSync(result.config, 'utf8'));
  assert.deepEqual(configured.mcp.servers.other, old.mcp.servers.other);
  assert.deepEqual(configured.mcp.servers.council, preview.server);
  assert.ok(readFileSync(result.skill, 'utf8').includes(skillRevision));
  assert.ok(result.skills.every(path => existsSync(path)));
});

test('Codex setup installs workflow skills and leaves the project MCP configuration untouched', t => {
  const project = mkdtempSync(join(tmpdir(), 'council-codex-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const request = { project, host: 'codex' };
  const preview = setupAlignment(request);
  assert.deepEqual(preview.skills, ['council', 'council-delegate', 'council-review', 'council-team']
    .map(name => join(project, '.agents', 'skills', name, 'SKILL.md')));
  assert.equal(preview.config, null);
  assert.equal(preview.server.cwd, project);
  assert.ok(preview.skills.every(path => !existsSync(path)));
  setupAlignment({ ...request, apply: true });
  assert.ok(preview.skills.every(path => existsSync(path)));
  assert.equal(existsSync(join(project, '.codex')), false);

  writeFileSync(preview.skills[1], 'A local edit.');
  assert.throws(() => setupAlignment({ ...request, apply: true }), /--replace/);
  assert.equal(readFileSync(preview.skills[1], 'utf8'), 'A local edit.');
  setupAlignment({ ...request, apply: true, replace: true });
  assert.match(readFileSync(preview.skills[1], 'utf8'), /^name: council-delegate$/m);
});
