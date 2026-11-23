import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopRequest } from '../herdr/mods/council/runtime/desktop.mjs';
import { createDebate } from '../herdr/mods/council/runtime/debate-room.mjs';

function temporaryFolder(t) {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'council-discovery-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function agentDebate(folder, question) {
  mkdirSync(folder, { recursive: true });
  return createDebate(folder, { question, createdBy: 't12' }).sessionId;
}

test('Desktop finds nested agent debates from the space alone and keeps a pinned view local', t => {
  const space = temporaryFolder(t);
  const project = join(space, 'services', 'team', 'parser');
  const debateId = agentDebate(project, 'Ship the parser?');
  const scope = { projects: [space], spaceFolder: space };
  const { debates, errors } = desktopRequest(space, 'debates', scope);
  assert.deepEqual(errors, []);
  assert.deepEqual(debates.map(({ id, project }) => [id, project]), [[debateId, project]]);
  const activity = desktopRequest(space, 'activity', scope);
  assert.ok(activity.decisions.some(item => item.id === debateId && item.project === project));
  assert.deepEqual(desktopRequest(space, 'activity', { followFocus: false }).decisions, []);
});

test('descendant discovery skips linked directories, linked stores and generated or hidden trees', t => {
  const space = temporaryFolder(t);
  const outside = temporaryFolder(t);
  const group = join(space, 'code');
  const keep = agentDebate(join(group, 'apps', 'tracker'), 'Show this debate');
  const external = join(outside, 'private');
  agentDebate(external, 'Outside');
  for (const folder of ['.hidden', 'node_modules', 'dist']) agentDebate(join(group, folder, 'project'), folder);
  symlinkSync(outside, join(group, 'elsewhere'), 'junction');
  const linkedProject = join(group, 'linked-store');
  mkdirSync(linkedProject);
  symlinkSync(join(external, '.agent_workspace'), join(linkedProject, '.agent_workspace'), 'junction');
  const { debates, errors } = desktopRequest(space, 'debates', { projects: [space], spaceFolder: space });
  assert.deepEqual(errors, []);
  assert.deepEqual(debates.map(item => item.id), [keep]);
});
