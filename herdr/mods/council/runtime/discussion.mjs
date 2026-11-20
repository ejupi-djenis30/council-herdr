import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectory, readText } from './store-files.mjs';

const sessionModes = ['council', 'review', 'debate'];
const safeName = /^[a-z0-9][a-z0-9-]*$/i;
const sha256 = /^[a-f0-9]{64}$/i;
const messageLimit = 8000;

function string(value) {
  return typeof value === 'string' ? value : null;
}

export function readJson(path) {
  const raw = readText(path, 1024 * 1024);
  return raw === null ? null : JSON.parse(raw);
}

export function readDiscussionSession(dir, id) {
  if (!isDirectory(dir)) return null;
  const session = readJson(join(dir, 'session.json'));
  return session?.sessionId === id && sessionModes.includes(session.mode) && Number.isFinite(Date.parse(session.createdAt))
    ? session : null;
}

function current(timestamp, session) {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && time >= Date.parse(session.createdAt);
}

function participants(session) {
  const roster = Array.isArray(session.participants) ? session.participants : [];
  return new Map(roster.filter(person => typeof person?.name === 'string' && safeName.test(person.name))
    .map(person => [person.name, person]));
}

function ballotAt(path, round, voter, session, roster) {
  const ballot = readJson(path);
  if (ballot?.$schema !== 'council.ballot/v1' || ballot.sessionId !== session.sessionId ||
      ballot.round !== round || ballot.voter !== voter || !current(ballot.submittedAt, session) ||
      !['approve', 'amend', 'reject'].includes(ballot.vote) || typeof ballot.score !== 'number' ||
      ballot.score < 1 || ballot.score > 10) return null;
  const person = roster.get(voter);
  return {
    voter, round, vote: ballot.vote, score: ballot.score, submittedAt: ballot.submittedAt,
    agent: string(person?.agent) ?? string(ballot.agent), role: string(person?.role) ?? string(ballot.role),
    assigned: Boolean(person), bound: typeof ballot.targetArtifactSha256 === 'string' && sha256.test(ballot.targetArtifactSha256),
    rationale: typeof ballot.rationale === 'string' ? ballot.rationale.slice(0, messageLimit) : '',
    amendments: Array.isArray(ballot.amendments)
      ? ballot.amendments.filter(value => typeof value === 'string').slice(0, 20).map(value => value.slice(0, 1000)) : []
  };
}

export function readSubmittedBallots(dir, session) {
  const root = join(dir, 'ballots');
  const ballots = [];
  if (!isDirectory(root)) return ballots;
  const roster = participants(session);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^round-[1-9]\d*$/.test(entry.name)) continue;
    const round = Number(entry.name.slice(6));
    if (!Number.isSafeInteger(round)) continue;
    const roundDir = join(root, entry.name);
    for (const file of readdirSync(roundDir, { withFileTypes: true })) {
      const voter = file.name.slice(0, -5);
      if (!file.isFile() || !file.name.endsWith('.json') || !safeName.test(voter)) continue;
      try {
        const ballot = ballotAt(join(roundDir, file.name), round, voter, session, roster);
        if (ballot) ballots.push(ballot);
      } catch {
        // A malformed submission does not hide other ballots; the formal tally reports invalid votes.
      }
    }
  }
  return ballots.sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || a.voter.localeCompare(b.voter));
}

function contributionAt(root, phase, person, session) {
  const phaseDir = join(root, phase);
  const authorDir = join(phaseDir, person.name);
  if (!isDirectory(phaseDir) || !isDirectory(authorDir)) return null;
  const artifact = join(authorDir, 'artifact.md');
  const body = readText(artifact, 1024 * 1024);
  if (!body?.trim()) return null;
  const meta = readJson(join(authorDir, 'meta.json'));
  const timestamp = meta?.createdAt ?? lstatSync(artifact).mtime.toISOString();
  if (!current(timestamp, session)) return null;
  if (meta && (meta.phase !== phase || meta.author !== person.name ||
      meta.sha256 !== createHash('sha256').update(body).digest('hex'))) return null;
  return {
    id: `${phase}-${person.name}`, kind: person.role === 'author' ? 'proposal' : 'reply',
    author: person.name, role: string(person.role), agent: string(person.agent), timestamp,
    source: !meta ? 'draft' : meta.source === 'terminal_screen_fallback' ? 'terminal' : 'artifact',
    body: body.slice(0, messageLimit), truncated: body.length > messageLimit, path: artifact
  };
}

export function discussionMessages(dir, session) {
  const root = join(dir, 'artifacts');
  const messages = [];
  if (isDirectory(root)) {
    for (const person of participants(session).values()) {
      const phases = session.mode === 'debate' ? ['debate']
        : person.role !== 'author' ? ['review'] : session.mode === 'review' ? ['proposal', 'draft'] : ['draft', 'proposal'];
      for (const phase of phases) {
        try {
          const post = contributionAt(root, phase, person, session);
          if (post) {
            messages.push(post);
            break;
          }
        } catch {
          // Leave a bad artifact out of the conversation and keep other contributions visible.
        }
      }
    }
  }
  for (const ballot of readSubmittedBallots(dir, session)) {
    messages.push({
      id: `ballot-${ballot.round}-${ballot.voter}`, kind: 'ballot', author: ballot.voter,
      agent: ballot.agent, role: ballot.role, timestamp: ballot.submittedAt, ballot
    });
  }
  return messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
    Number(a.kind === 'ballot') - Number(b.kind === 'ballot') || a.id.localeCompare(b.id));
}
