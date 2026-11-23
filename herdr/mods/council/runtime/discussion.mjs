import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectory, isFile, readBytes, readText } from './store-files.mjs';

const sessionModes = ['council', 'review', 'debate', 'delegate', 'parallel', 'pipeline'];
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

export function currentFormalVerdict(dir, session) {
  const { sessionId: id } = session;
  const createdAt = Date.parse(session.createdAt);
  const candidates = ['reports', 'validation'].flatMap(folder => {
    const results = join(dir, folder);
    if (!isDirectory(results)) return [];
    const verdict = readJson(join(results, 'verdict.json'));
    const validation = verdict?.validation;
    const timestamp = Date.parse(validation?.validatedAt);
    if (verdict?.sessionId !== id || verdict.mode !== session.mode ||
        validation?.$schema !== 'council.validation/v1' || !verdict.tally ||
        !Number.isFinite(createdAt) || !Number.isFinite(timestamp) || timestamp < createdAt) return [];
    return [{ folder, verdict, timestamp }];
  });
  // A reused ID may have an older report alongside its current validation.
  candidates.sort((a, b) => b.timestamp - a.timestamp ||
    Number(b.folder === 'validation') - Number(a.folder === 'validation'));
  const latest = candidates[0];
  if (!latest) return null;
  const { validation, tally } = latest.verdict;
  if (tally.round !== undefined && (tally.round !== validation.round ||
      !Number.isSafeInteger(tally.round) || tally.round < 1)) return null;
  const marker = readJson(join(dir, 'validation', 'round.json'));
  if (marker?.sessionCreatedAt === session.createdAt && (marker.mode !== session.mode || marker.sessionId !== id ||
      marker.round !== validation.round || marker.sha256 !== validation.expectedSha256)) return null;
  return latest;
}

export function reviewStatus(saved) {
  const validation = saved?.verdict.validation;
  const tally = saved?.verdict.tally;
  const authorized = saved?.folder === 'reports' && validation.passed === true &&
    ['validated', 'conditional'].includes(validation.verdict) && validation.artifactIntegrity === true &&
    validation.mutationDetected === false && tally.passed === true && tally.quorumMet === true && tally.invalidCount === 0;
  return authorized ? 'approved'
    : ['approved', 'validated', 'conditional'].includes(validation?.verdict) ? 'unconfirmed' : validation?.verdict ?? 'pending';
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

function digest(value) {
  return typeof value === 'string' && sha256.test(value) ? value : null;
}

function proposalMatch(target, round, proposal) {
  if (target == null || target === '') return 'missing';
  if (!digest(target)) return 'invalid';
  if (proposal?.round !== round) return 'unavailable';
  return target === proposal.sha256 ? 'match' : 'mismatch';
}

function ballotAt(path, round, voter, session, roster, proposal) {
  const ballot = readJson(path);
  if (ballot?.$schema !== 'council.ballot/v1' || ballot.sessionId !== session.sessionId ||
      ballot.round !== round || ballot.voter !== voter || !current(ballot.submittedAt, session) ||
      !['approve', 'amend', 'reject'].includes(ballot.vote) || typeof ballot.score !== 'number' ||
      ballot.score < 1 || ballot.score > 10) return null;
  const person = roster.get(voter);
  const match = proposalMatch(ballot.targetArtifactSha256, round, proposal);
  return {
    voter, round, vote: ballot.vote, score: ballot.score, submittedAt: ballot.submittedAt,
    agent: string(person?.agent) ?? string(ballot.agent), role: string(person?.role) ?? string(ballot.role),
    assigned: Boolean(person), bound: match === 'match', proposalMatch: match,
    rationale: typeof ballot.rationale === 'string' ? ballot.rationale.slice(0, messageLimit) : '',
    amendments: Array.isArray(ballot.amendments)
      ? ballot.amendments.filter(value => typeof value === 'string').slice(0, 20).map(value => value.slice(0, 1000)) : []
  };
}

export function readSubmittedBallots(dir, session, proposal) {
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
        const ballot = ballotAt(join(roundDir, file.name), round, voter, session, roster, proposal);
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
  const bytes = readBytes(artifact, 1024 * 1024);
  const body = bytes?.toString('utf8');
  if (!body?.trim()) return null;
  const meta = readJson(join(authorDir, 'meta.json'));
  const timestamp = meta?.createdAt ?? lstatSync(artifact).mtime.toISOString();
  if (!current(timestamp, session)) return null;
  if (meta && (meta.phase !== phase || meta.author !== person.name ||
      meta.sha256 !== createHash('sha256').update(bytes).digest('hex'))) return null;
  return {
    id: `${phase}-${person.name}`, kind: {
      arguments: 'argument', verdict: 'recommendation', subtasks: 'result', delegation: 'result'
    }[phase] ?? (phase.startsWith('stage-') ? 'result' : person.role === 'author' ? 'proposal' : 'reply'),
    author: person.name, role: string(person.role), agent: string(person.agent), timestamp,
    source: !meta ? 'draft' : ['terminal', 'terminal_screen_fallback'].includes(meta.source) ? 'terminal' : 'artifact',
    body: body.slice(0, messageLimit), truncated: body.length > messageLimit, path: artifact,
    sha256: meta?.sha256 ?? null
  };
}

export function proposalReference(dir, session, validation) {
  if (!['review', 'council'].includes(session.mode)) return null;
  const saved = digest(validation?.expectedSha256) ??
    (validation?.artifactIntegrity === true && validation.mutationDetected === false
      ? digest(validation.verifiedSha256) : null);
  if (saved) return { sha256: saved, round: validation.round ?? 1, source: 'saved' };

  try {
    const task = join(dir, 'task');
    const target = isDirectory(task) ? readJson(join(task, 'proposal-target.json')) : null;
    if (target?.createdAt === session.createdAt) {
      return target.sessionId === session.sessionId && Number.isSafeInteger(target.round) && target.round > 0 && digest(target.sha256)
        ? { sha256: target.sha256, round: target.round, source: 'handoff' } : null;
    }
  } catch {
    // A damaged handoff leaves the proposal comparison unavailable.
    return null;
  }

  // Earlier sessions recorded the target only in the canonical artifact metadata.
  try {
    const authors = [...participants(session).values()].filter(person => person.role === 'author');
    if (authors.length !== 1) return null;
    const root = join(dir, 'artifacts');
    if (!isDirectory(root)) return null;
    const phase = session.mode === 'review' ? 'proposal' : 'draft';
    const proposal = contributionAt(root, phase, authors[0], session);
    return proposal?.sha256 ? { sha256: proposal.sha256, round: 1, source: 'artifact' } : null;
  } catch {
    return null;
  }
}

export function discussionMessages(dir, session, proposal) {
  const root = join(dir, 'artifacts');
  const messages = [];
  if (isDirectory(root)) {
    const workflowPhases = session.mode === 'pipeline'
      ? readdirSync(root, { withFileTypes: true }).filter(entry =>
        entry.isDirectory() && /^stage-[1-9]\d*$/.test(entry.name)).map(entry => entry.name)
      : { debate: ['arguments', 'verdict', 'debate'], parallel: ['subtasks'], delegate: ['delegation'] }[session.mode];
    for (const person of participants(session).values()) {
      const phases = workflowPhases ?? (person.role !== 'author' ? ['review']
        : session.mode === 'review' ? ['proposal', 'draft'] : ['draft', 'proposal']);
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
  for (const ballot of readSubmittedBallots(dir, session, proposal)) {
    messages.push({
      id: `ballot-${ballot.round}-${ballot.voter}`, kind: 'ballot', author: ballot.voter,
      agent: ballot.agent, role: ballot.role, timestamp: ballot.submittedAt, ballot
    });
  }
  return messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
    Number(a.kind === 'ballot') - Number(b.kind === 'ballot') || a.id.localeCompare(b.id));
}

export function readAdvisoryRun(dir, session) {
  const folders = session.mode === 'delegate' ? ['reports', 'validation'] : ['validation'];
  const records = folders.flatMap(name => {
    const folder = join(dir, name);
    if (!isDirectory(folder)) return [];
    const verdictPath = join(folder, 'verdict.json');
    const verdict = readJson(verdictPath);
    if (!verdict || verdict.sessionId !== session.sessionId) return [];
    const legacyDelegate = session.mode === 'delegate' && name === 'reports' && verdict.mode === undefined && Boolean(verdict.agent);
    if (!legacyDelegate && (verdict.mode !== session.mode || !['completed', 'incomplete'].includes(verdict.status))) return [];
    const updatedAt = verdict.completedAt ?? lstatSync(verdictPath).mtime.toISOString();
    if (!current(updatedAt, session)) return [];
    const reportPath = join(folder, 'report.md');
    return [{
      status: legacyDelegate ? 'completed' : verdict.status, updatedAt,
      reportPath: isFile(reportPath) ? reportPath : null, error: string(verdict.error)?.slice(0, messageLimit),
      execution: verdict.execution && typeof verdict.execution === 'object' ? Object.fromEntries(
        Object.entries(verdict.execution).filter(([name, turn]) => safeName.test(name) && turn && typeof turn === 'object')
          .map(([name, turn]) => [name, { address: string(turn.address), status: string(turn.status), error: string(turn.error) }])
      ) : null
    }];
  });
  return records.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? { status: 'pending_result' };
}
