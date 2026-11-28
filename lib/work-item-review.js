import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isDirectory, readBytes } from '../herdr/mods/council/runtime/store-files.mjs';
import { hashBytes, hashTuple } from '../herdr/mods/council/runtime/work-item-lifecycle-store.mjs';
import { definitionDigest } from './work-item-lifecycle.js';
import { AgentWorkspace, sanitizeName } from './workspace.js';
import { completedFormalRound, currentFormalVerdict, readDiscussionSession, reviewStatus, verifiedFormalProposal } from '../herdr/mods/council/runtime/discussion.mjs';

const captureLimit = 16 * 1024 * 1024;
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function evidenceDirectory(store, id, create = false) {
  const item = store.directory(id, create);
  if (!item) return null;
  const dir = join(item, 'evidence');
  return isDirectory(dir, { create }) ? dir : null;
}

export function saveEvidence(store, id, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > captureLimit) throw new Error('Evidence exceeds the capture limit.');
  const digest = hashBytes(bytes);
  const dir = evidenceDirectory(store, id, true);
  const file = join(dir, `${digest}.blob`);
  const existing = readBytes(file, captureLimit);
  if (existing !== null) {
    if (!existing.equals(bytes)) throw new Error('Evidence digest collision.');
    return digest;
  }
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    try { linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = readBytes(file, captureLimit);
      if (!winner || !winner.equals(bytes)) throw new Error('Conflicting evidence bytes.');
    }
  } finally { unlinkSync(temporary); }
  return digest;
}

export function readEvidence(store, id, digest, byteCount) {
  if (!isDigest(digest) || !Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount > captureLimit) return null;
  try {
    const dir = evidenceDirectory(store, id);
    const bytes = dir && readBytes(join(dir, `${digest}.blob`), captureLimit);
    return bytes && bytes.length === byteCount && hashBytes(bytes) === digest ? bytes : null;
  } catch { return null; }
}

export function freezeCapture(store, item, state, reviewId, owner, policy, ctx) {
  const effective = { ...item, ...state.definition };
  const execution = ctx.project(store, effective, state.attempt);
  if (execution.state !== 'result_ready' || !execution.job?.linked || !execution.result) {
    ctx.fail('invalid_transition', 'A verified completed handoff is required.');
  }
  const result = execution.result;
  const bytes = Buffer.from(result.output, 'utf8');
  if (bytes.length > captureLimit) ctx.fail('integrity_error', 'Capture exceeds the evidence size limit.');
  if (result.artifactPath) {
    const artifact = readBytes(result.artifactPath, captureLimit);
    if (!artifact || !artifact.equals(bytes)) ctx.fail('integrity_error', 'The saved capture differs from its artifact.');
  }
  const captureSha256 = saveEvidence(store, item.id, bytes);
  const definitionSha256 = definitionDigest(state.definition);
  const snapshot = ['council.work-item-review-snapshot/v2', item.id, state.cycle, state.workRevision,
    reviewId, owner, policy, definitionSha256, execution.job.sessionId, captureSha256, bytes.length,
    result.source, result.captureScope, result.turn, result.completedAt];
  return { id: reviewId, cycle: state.cycle, workRevision: state.workRevision, reviewOwnerRoleId: owner,
    policy, definition: state.definition, definitionSha256, snapshot, snapshotSha256: hashTuple(snapshot),
    capture: { sessionId: execution.job.sessionId, sha256: captureSha256, byteCount: bytes.length,
      source: result.source, captureScope: result.captureScope, turn: result.turn, completedAt: result.completedAt },
    notes: [], formal: null };
}

export function displayReview(store, itemId, review) {
  const bytes = readEvidence(store, itemId, review.capture.sha256, review.capture.byteCount);
  let output = null;
  if (bytes) {
    try { output = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Damaged evidence is not reviewable. */ }
  }
  const verified = output !== null && hashTuple(review.snapshot) === review.snapshotSha256;
  const formalVerified = !review.formal || review.formal.sources || verifyArchivedFormal(store, itemId, review.formal);
  const formalState = review.policy === 'operator' ? 'operator' : review.formal?.state ?? 'pending';
  const formal = review.formal && Object.fromEntries(['sessionId', 'round', 'state', 'verdict', 'proposalSha256', 'manifestSha256', 'dissent'].map(key => [key, review.formal[key] ?? null]));
  const token = verified && formalVerified ? hashTuple([review.snapshotSha256, formalState, review.formal?.manifestSha256 ?? null]) : null;
  return { ...review, snapshot: undefined, definitionSha256: undefined,
    capture: { ...review.capture, output: verified ? output : null, verified }, formal, evidenceToken: token };
}

// Observe only a pre-existing formal round. All source files are checked twice
// around the existing read-only tally; a torn retally cannot grant authority.
export function observeFormal(store, sessionId, requestedRound, snapshotSha256) {
  const unverified = { sessionId, round: requestedRound, state: 'unverified', verdict: null,
    proposalSha256: null, manifestSha256: null, dissent: [], sources: [] };
  try {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(sessionId) || sanitizeName(sessionId) !== sessionId || !isDirectory(store.base)) return unverified;
    let directory = join(store.base, sessionId);
    if (!isDirectory(directory)) return unverified;
    const jobPath = join(directory, 'job.json');
    const jobBytes = readBytes(jobPath, captureLimit);
    let linkedMode = null;
    if (jobBytes) {
      const job = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jobBytes));
      if (job.$schema !== 'council.job/v1' || job.sessionId !== sessionId || !['council', 'review'].includes(job.mode) ||
          typeof job.workflow?.sessionId !== 'string' || !/^workflow-[0-9a-f-]+$/.test(job.workflow.sessionId)) return unverified;
      linkedMode = job.mode;
      directory = join(store.base, job.workflow.sessionId);
      if (!isDirectory(directory)) return unverified;
    }
    const actualId = directory.slice(directory.lastIndexOf(sep) + 1);
    const lock = join(directory, 'validation', 'retally.lock');
    if (existsSync(lock)) return unverified;
    const session = readDiscussionSession(directory, actualId);
    if (!session || !['council', 'review'].includes(session.mode) || (linkedMode && session.mode !== linkedMode)) return unverified;
    if (!isDirectory(join(directory, 'validation'))) return unverified;
    const markerBytes = readBytes(join(directory, 'validation', 'round.json'), 65536);
    if (!markerBytes) return unverified;
    const marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(markerBytes));
    if (marker.$schema !== 'council.formal-round/v1' || marker.sessionId !== actualId || marker.mode !== session.mode ||
        marker.sessionCreatedAt !== session.createdAt || marker.round !== requestedRound) return unverified;
    // Reject linked or oversized verdict files before the shared reader sees them.
    for (const folder of ['validation', 'reports']) {
      const dir = join(directory, folder);
      if (isDirectory(dir)) for (const file of ['verdict.json', 'report.md', 'representative.json']) readBytes(join(dir, file), captureLimit);
    }
    const saved = currentFormalVerdict(directory, session);
    const round = completedFormalRound(directory, session, saved);
    if (!round || round.round !== requestedRound) return unverified;
    const proposal = verifiedFormalProposal(directory, round);
    if (!proposal) return unverified;
    const proposalBytes = readBytes(proposal, 1024 * 1024);
    if (hashBytes(proposalBytes) !== round.sha256) return unverified;
    const firstLine = new TextDecoder('utf-8', { fatal: true }).decode(proposalBytes).split(/\r?\n/, 1)[0];
    if (firstLine !== `Council-Work-Item-Review: sha256:${snapshotSha256}`) return unverified;

    const paths = [join(directory, 'session.json'), join(directory, 'validation', 'round.json'), proposal,
      join(directory, 'artifacts', round.proposal.phase, round.proposal.author, 'meta.json')];
    for (const folder of ['validation', 'reports']) {
      const dir = join(directory, folder);
      if (isDirectory(dir)) for (const file of ['verdict.json', 'report.md', 'representative.json']) paths.push(join(dir, file));
    }
    const ballotRoot = join(directory, 'ballots');
    const ballotDir = join(ballotRoot, `round-${requestedRound}`);
    const ballotRootExists = isDirectory(ballotRoot);
    const ballotDirExists = ballotRootExists && isDirectory(ballotDir);
    const ballotNames = ballotDirExists ? readdirSync(ballotDir).filter(name => name.endsWith('.json') && name !== 'tally.json').sort() : [];
    if (ballotNames.some(name => !round.voters.some(voter => name === `${voter}.json`))) return unverified;
    for (const voter of round.voters) paths.push(join(ballotDir, `${voter}.json`));
    if (jobBytes) paths.push(jobPath);
    const collect = () => paths.map(path => {
      const rel = relative(store.root, path).split(sep).join('/');
      const bytes = readBytes(path, captureLimit);
      return { path: rel, bytes, sha256: bytes ? hashBytes(bytes) : null };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const before = collect();
    const workspace = new AgentWorkspace(store.root);
    const tally = workspace.tallyBallots(directory, requestedRound, round.voters, {
      quorum: 0.67, approvalThreshold: 0.6, expectedArtifactSha256: round.sha256, readOnly: true
    });
    const after = collect();
    const latestSession = readDiscussionSession(directory, actualId);
    const latestVerdict = latestSession && currentFormalVerdict(directory, latestSession);
    if (existsSync(lock) || isDirectory(ballotRoot) !== ballotRootExists ||
        (ballotRootExists && isDirectory(ballotDir) !== ballotDirExists) ||
        (ballotDirExists && JSON.stringify(readdirSync(ballotDir).filter(name => name.endsWith('.json') && name !== 'tally.json').sort()) !== JSON.stringify(ballotNames)) ||
        !sameSources(before, after) ||
        JSON.stringify(latestSession) !== JSON.stringify(session) || JSON.stringify(latestVerdict) !== JSON.stringify(saved)) return unverified;
    const manifest = before.filter(entry => entry.bytes).map(entry => [entry.path, entry.sha256, entry.bytes.length]);
    const manifestSha256 = hashTuple(manifest);
    const verdict = saved?.verdict?.validation?.verdict ?? null;
    const observed = saved?.verdict?.tally;
    const fields = ['round','expectedCount','castCount','validCastCount','invalidCount','quorumMet','approveCount','rejectCount','amendCount','approvalRate','passed'];
    const coherent = Boolean(saved && fields.every(field => observed?.[field] === tally[field]) &&
      saved.verdict.validation.round === requestedRound && saved.verdict.validation.expectedSha256 === round.sha256 &&
      before.some(entry => entry.path === relative(store.root, join(directory, saved.folder, 'report.md')).split(sep).join('/') && entry.bytes));
    let state = 'unverified';
    if (coherent && verdict === 'provisional') state = 'provisional';
    else if (coherent && verdict === 'rejected') state = 'rejected';
    else if (coherent && reviewStatus(saved) === 'approved' && tally.passed && tally.invalidCount === 0) state = 'approved';
    const direct = tally.sortedBallots.filter(ballot => ['reject', 'amend'].includes(ballot.vote)).map(ballot => {
      const file = before.find(entry => entry.path.endsWith(`/ballots/round-${requestedRound}/${ballot.voter}.json`));
      const raw = file?.bytes ? JSON.parse(file.bytes.toString('utf8')) : {};
      return { voter: ballot.voter, vote: ballot.vote, rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 8000) : '' };
    });
    return { sessionId, round: requestedRound, state, verdict, proposalSha256: round.sha256,
      manifestSha256, dissent: direct, manifest, sources: before.filter(entry => entry.bytes) };
  } catch { return unverified; }
}

function sameSources(before, after) {
  return before.length === after.length && before.every((entry, index) =>
    entry.path === after[index].path && entry.sha256 === after[index].sha256);
}

export function archiveFormal(store, itemId, observation) {
  if (!observation.manifest || !observation.sources) { const { sources, ...saved } = observation; return saved; }
  for (const source of observation.sources) saveEvidence(store, itemId, source.bytes);
  const manifestBytes = Buffer.from(JSON.stringify(observation.manifest), 'utf8');
  if (saveEvidence(store, itemId, manifestBytes) !== observation.manifestSha256) throw new Error('Formal manifest digest mismatch.');
  const { sources, ...saved } = observation;
  return saved;
}

function verifyArchivedFormal(store, itemId, formal) {
  if (formal.state === 'unverified' && formal.manifestSha256 == null) return true;
  if (!Array.isArray(formal.manifest) || !isDigest(formal.manifestSha256)) return false;
  const encoded = Buffer.from(JSON.stringify(formal.manifest), 'utf8');
  if (hashBytes(encoded) !== formal.manifestSha256 || !readEvidence(store, itemId, formal.manifestSha256, encoded.length)) return false;
  return formal.manifest.every(entry => {
    if (!Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== 'string' ||
        !readEvidence(store, itemId, entry[1], entry[2])) return false;
    const parts = entry[0].split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return false;
    try {
      let path = store.root;
      for (const part of parts.slice(0, -1)) {
        path = join(path, part);
        if (!isDirectory(path)) return false;
      }
      const bytes = readBytes(join(path, parts.at(-1)), captureLimit);
      return Boolean(bytes && bytes.length === entry[2] && hashBytes(bytes) === entry[1]);
    } catch { return false; }
  });
}

export function verifyCaptureSource(store, item, state, review, ctx) {
  try {
    const execution = ctx.project(store, { ...item, ...state.definition }, state.attempt);
    const result = execution.result;
    if (execution.state !== 'result_ready' || !execution.job?.linked || execution.job.sessionId !== review.capture.sessionId || !result) return false;
    const bytes = Buffer.from(result.output, 'utf8');
    if (bytes.length !== review.capture.byteCount || hashBytes(bytes) !== review.capture.sha256 || result.source !== review.capture.source ||
        result.captureScope !== review.capture.captureScope || result.turn !== review.capture.turn || result.completedAt !== review.capture.completedAt) return false;
    return !result.artifactPath || Boolean(readBytes(result.artifactPath, captureLimit)?.equals(bytes));
  } catch { return false; }
}
