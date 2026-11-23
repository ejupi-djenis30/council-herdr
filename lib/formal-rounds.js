import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWrite } from './workspace.js';
import { formatCouncilReport } from './formatters.js';
import { currentFormalVerdict, readDiscussionSession, reviewStatus } from '../herdr/mods/council/runtime/discussion.mjs';

const roundFile = dir => join(dir, 'validation', 'round.json');
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const definition = {
  council: { proposal: { phase: 'draft', author: 'council-author' }, voters: ['council-author', 'council-skeptic', 'council-simplifier'] },
  review: { proposal: { phase: 'proposal', author: 'review-author' }, voters: ['review-reviewer', 'review-simplifier'] }
};

export function resolveVotingSession(workspace, id) {
  const dir = workspace.resolveSessionDir(id);
  if (existsSync(join(dir, 'session.json'))) return dir;
  const job = readJson(join(dir, 'job.json'));
  const linked = job?.workflow?.sessionId;
  return job?.$schema === 'council.job/v1' && Object.hasOwn(definition, job.mode) &&
    typeof linked === 'string' && /^workflow-[a-f0-9-]+$/.test(linked) ? workspace.resolveSessionDir(linked) : dir;
}

export function readFormalDecision(workspace, id) {
  const dir = resolveVotingSession(workspace, id);
  const session = readDiscussionSession(dir, basename(dir));
  if (!session || !Object.hasOwn(definition, session.mode)) return null;
  const current = currentFormalVerdict(dir, session);
  if (!current) return null;
  const artifactPath = join(dir, current.folder, 'report.md');
  if (!existsSync(artifactPath)) return null;
  return { authorized: reviewStatus(current) === 'approved', workflowStatus: current.verdict.validation.verdict,
    artifactPath, output: readFileSync(artifactPath, 'utf8') };
}

export function saveFormalRound(dir, { mode, round, previousSession, sha256, representative }) {
  const { createdAt } = readDiscussionSession(dir, basename(dir));
  atomicWrite(roundFile(dir), JSON.stringify({
    $schema: 'council.formal-round/v1', sessionId: basename(dir), sessionCreatedAt: createdAt, mode, round, previousSession, sha256, representative
  }, null, 2));
}

function findRound(dir) {
  const sessionId = basename(dir);
  const session = readDiscussionSession(dir, sessionId);
  if (!session || !Object.hasOwn(definition, session.mode)) return null;
  const recorded = readJson(roundFile(dir));
  const previous = currentFormalVerdict(dir, session)?.verdict;
  const legacy = previous?.tally?.expectedCount === definition[session.mode].voters.length
    ? { sessionId, mode: session.mode, round: previous.validation?.round,
      sha256: previous.validation?.expectedSha256, representative: previous.validation?.representative } : null;
  // Earlier round files have no session timestamp. A verdict from this run must corroborate them.
  const recordedMatches = recorded && (recorded.sessionCreatedAt === session.createdAt ||
    (recorded.sessionCreatedAt === undefined && legacy && recorded.round === legacy.round && recorded.sha256 === legacy.sha256));
  const round = recordedMatches ? recorded : legacy;
  const roster = session.participants;
  if (!round || round.sessionId !== sessionId || round.mode !== session.mode || !Number.isSafeInteger(round.round) ||
      round.round < 1 || !/^[a-f0-9]{64}$/.test(round.sha256) || !Array.isArray(roster) ||
      !definition[session.mode].voters.every(voter => roster.some(person => person.name === voter))) return null;
  return { ...round, ...definition[session.mode], roster };
}

function withRoundLock(dir, action) {
  const lock = join(dir, 'validation', 'retally.lock');
  for (let attempt = 0; ; attempt++) {
    try { writeFileSync(lock, '', { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt >= 60) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return action(); } finally { unlinkSync(lock); }
}

export function retallyFormalRound(workspace, sessionId, { optional = false, ballotRound } = {}) {
  const dir = resolveVotingSession(workspace, sessionId);
  const saved = findRound(dir);
  if (!saved || (ballotRound !== undefined && saved.round !== Number(ballotRound))) {
    if (optional) return null;
    throw new Error('A documented formal round with completed participant turns is required.');
  }
  return withRoundLock(dir, () => {
    const { mode, round, proposal, voters, roster, sha256, representative } = saved;
    if (!existsSync(roundFile(dir))) saveFormalRound(dir, saved);
    const tally = workspace.tallyBallots(dir, round, voters, {
      quorum: 0.67, approvalThreshold: 0.6, expectedArtifactSha256: sha256
    });
    const archive = join(dir, 'validation', 'history', randomUUID());
    for (const folder of ['reports', 'validation']) {
      const active = join(dir, folder);
      for (const file of ['verdict.json', 'report.md', 'representative.json']) {
        if (!existsSync(join(active, file))) continue;
        mkdirSync(join(archive, folder), { recursive: true });
        renameSync(join(active, file), join(archive, folder, file));
      }
    }
    const { passed, record } = workspace.validateChoice(dir, { round, targetArtifact: proposal, expectedSha256: sha256,
      tally, representative, validationType: 'mechanical_tally_rule' });
    const task = readFileSync(join(dir, 'task', 'task.md'), 'utf8');
    const markdownReport = formatCouncilReport({ title: `Formal Round ${round} Tally`, mode, task, participants: roster,
      tally, validation: record, synthesis: `Proposal digest ${sha256}. This report reflects the ballots read during re-tallying.` });
    const { reportPath } = workspace.saveFinalDeliverables(dir, {
      markdownReport, verdictJson: { sessionId: saved.sessionId, mode, tally, validation: record }, validationPassed: passed
    });
    return { success: passed, authorized: passed, sessionId: saved.sessionId, round, status: record.verdict, tally, reportPath };
  });
}

export function retallyAfterBallot(workspace, dir, round) {
  try { return retallyFormalRound(workspace, dir, { optional: true, ballotRound: round }); }
  catch (error) { return { error: error.message, nextAction: 'Use council retally to refresh the saved tally.' }; }
}

export function nextFormalRound(workspace, sessionId, options) {
  const dir = resolveVotingSession(workspace, sessionId);
  const saved = findRound(dir);
  if (!saved) throw new Error('A saved formal review or council is required before starting another round.');
  const proposal = workspace.readArtifact(dir, saved.proposal.phase, saved.proposal.author);
  if (!proposal?.verified || proposal.sha256 !== saved.sha256) throw new Error('The previous proposal is missing or has changed.');
  const readTask = name => {
    const file = join(dir, 'task', `${name}.md`);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const round = saved.round + 1;
  const roles = saved.mode === 'council' ? ['author', 'skeptic', 'simplifier'] : ['author', 'reviewer', 'simplifier'];
  return {
    ...options, mode: saved.mode, previousSession: saved.sessionId, round,
    sessionId: options.sessionId ?? `${saved.sessionId}-round-${round}`,
    task: options.task ?? readTask('task'), criteria: options.criteria ?? readTask('criteria'),
    agents: options.agents ?? roles.map(role => saved.roster.find(person => person.role === role)?.agent),
    context: [readTask('context'), `Revise or reassess the proposal from session ${saved.sessionId}.`,
      `Previous proposal at ${proposal.path}\nSHA-256: ${proposal.sha256}`, options.context].filter(Boolean).join('\n\n')
  };
}
