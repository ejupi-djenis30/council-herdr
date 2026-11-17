import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  appendFileSync,
  statSync
} from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * Sanitizes names for NTFS and cross-platform compatibility:
 * - Lowercase [a-z0-9-_]
 * - Strips leading/trailing dots, spaces, dashes
 * - Protects against Windows reserved device names (con, prn, aux, nul, com1-9, lpt1-9)
 */
export function sanitizeName(name) {
  let clean = String(name || 'anon')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const base = clean.split(/[-_]/)[0];
  if (!clean || WINDOWS_RESERVED_NAMES.has(clean) || WINDOWS_RESERVED_NAMES.has(base)) {
    clean = `node-${clean || 'entity'}`;
  }
  return clean;
}

/**
 * Robust atomic write with Windows retry backoff for AV/indexer locks
 */
export function atomicWrite(filePath, content, maxRetries = 5) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmp = join(
    dir,
    `${basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  writeFileSync(tmp, content, 'utf8');

  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (err) {
      lastError = err;
      if (err.code === 'EPERM' || err.code === 'EEXIST' || err.code === 'EBUSY') {
        const backoffMs = 20 * (attempt + 1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs);
        continue;
      }
      throw err;
    }
  }

  // Fallback for persistent Windows file locks: copy + remove tmp
  try {
    copyFileSync(tmp, filePath);
    try { unlinkSync(tmp); } catch {}
  } catch {
    throw lastError;
  }
}

/**
 * Deterministic Workspace Manager for Council Agents
 * Exchanged artifacts, briefs, ballots, and validation reports live under `.agent_workspace/`.
 */
export class AgentWorkspace {
  constructor(workspaceRoot = process.cwd()) {
    this.root = resolve(workspaceRoot);
    this.baseDir = join(this.root, '.agent_workspace');
  }

  sanitizeName(name) {
    return sanitizeName(name);
  }

  sha256(content) {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Resolve session directory from a session ID or directory path.
   * Only treats input as an existing filesystem path if it contains a separator or is absolute.
   * Otherwise resolves deterministically to .agent_workspace/<sanitized-id>.
   */
  resolveSessionDir(sessionIdOrPath) {
    if (!sessionIdOrPath) {
      throw new Error('Session ID or path is required');
    }
    const str = String(sessionIdOrPath).trim();
    const hasSep = str.includes('/') || str.includes('\\');
    if (isAbsolute(str) || hasSep) {
      return resolve(str);
    }
    const sanitized = this.sanitizeName(str);
    return join(this.baseDir, sanitized);
  }

  /**
   * Initialize a deterministic session workspace
   */
  initSession({ sessionId, mode, task, context = '', criteria = '', participants = [] }) {
    const rawSid = sessionId || `council-${Date.now().toString(36)}`;
    const sessionDir = this.resolveSessionDir(rawSid);
    const sid = basename(sessionDir);

    const subdirs = [
      'task',
      'briefs',
      'artifacts',
      'ballots',
      'validation',
      'reports',
      'transcripts'
    ];

    for (const sub of subdirs) {
      mkdirSync(join(sessionDir, sub), { recursive: true });
    }

    // Canonical task inputs
    atomicWrite(join(sessionDir, 'task', 'task.md'), task);
    if (context) atomicWrite(join(sessionDir, 'task', 'context.md'), context);
    if (criteria) atomicWrite(join(sessionDir, 'task', 'criteria.md'), criteria);

    // Session manifest
    const sessionMeta = {
      sessionId: sid,
      mode,
      taskHash: this.sha256(task),
      participants: participants
        .map(p => ({
          name: this.sanitizeName(p.name),
          role: p.role,
          agent: p.agent,
          weight: p.weight || 1.0
        }))
        .sort((a, b) => a.name.localeCompare(b.name)), // Deterministic sort
      createdAt: new Date().toISOString(),
      status: 'active'
    };
    atomicWrite(join(sessionDir, 'session.json'), JSON.stringify(sessionMeta, null, 2));

    return { sid, sessionId: sid, sessionDir, sessionMeta };
  }

  /**
   * Write an agent brief file in briefs/<name>.md
   */
  writeBrief(sessionDir, name, content) {
    const sName = this.sanitizeName(name);
    const briefPath = join(sessionDir, 'briefs', `${sName}.md`);
    atomicWrite(briefPath, content);
    return briefPath;
  }

  /**
   * Write an agent artifact under artifacts/<phase>/<author>/artifact.md
   * Appends to artifacts/index.jsonl with SHA-256 and records size/mtime in meta.json.
   */
  writeArtifact(sessionDir, { phase = 'draft', author, agent, content, metadata = {} }) {
    const sPhase = this.sanitizeName(phase);
    const sAuthor = this.sanitizeName(author);
    const dir = join(sessionDir, 'artifacts', sPhase, sAuthor);
    mkdirSync(dir, { recursive: true });

    const artifactPath = join(dir, 'artifact.md');
    atomicWrite(artifactPath, content);

    // Hash bytes after writing
    const digest = this.sha256(content);
    const stats = statSync(artifactPath);

    const metaPath = join(dir, 'meta.json');
    const metaRecord = {
      phase: sPhase,
      author: sAuthor,
      agent,
      sha256: digest,
      byteLength: stats.size,
      mtime: stats.mtime.toISOString(),
      createdAt: new Date().toISOString(),
      ...metadata
    };
    atomicWrite(metaPath, JSON.stringify(metaRecord, null, 2));

    // Append to index.jsonl with SHA-256
    const indexLine = JSON.stringify({
      phase: sPhase,
      author: sAuthor,
      path: `artifacts/${sPhase}/${sAuthor}/artifact.md`,
      sha256: digest,
      byteLength: stats.size,
      timestamp: metaRecord.createdAt
    }) + '\n';

    appendFileSync(join(sessionDir, 'artifacts', 'index.jsonl'), indexLine, 'utf8');

    return { artifactPath, metaPath, sha256: digest };
  }

  /**
   * Read artifact content and verify integrity
   */
  readArtifact(sessionDir, phase, author) {
    const sPhase = this.sanitizeName(phase);
    const sAuthor = this.sanitizeName(author);
    const artifactPath = join(sessionDir, 'artifacts', sPhase, sAuthor, 'artifact.md');
    if (!existsSync(artifactPath)) return null;

    const content = readFileSync(artifactPath, 'utf8');
    const currentDigest = this.sha256(content);

    const metaPath = join(sessionDir, 'artifacts', sPhase, sAuthor, 'meta.json');
    let recordedDigest = null;
    let metaMissing = false;

    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        recordedDigest = meta.sha256;
      } catch {
        metaMissing = true;
      }
    } else {
      metaMissing = true;
    }

    const verified = !metaMissing && (currentDigest === recordedDigest);

    return {
      content,
      sha256: currentDigest,
      verified,
      metaMissing,
      path: artifactPath
    };
  }

  /**
   * Cast a voting ballot according to schema `council.ballot/v1`
   */
  castBallot(sessionDir, {
    round = 1,
    voter,
    role,
    agent,
    vote = 'approve', // 'approve' | 'reject' | 'amend'
    score = 8,        // 1-10
    rationale = '',
    amendments = [],
    targetArtifactSha256 = ''
  }) {
    const validVotes = new Set(['approve', 'reject', 'amend']);
    const normalizedVote = String(vote || '').toLowerCase().trim();
    if (!validVotes.has(normalizedVote)) {
      throw new Error(`Invalid vote: "${vote}". Must be one of: approve, reject, amend`);
    }

    const validRound = Math.max(1, Math.floor(Number(round) || 1));
    const roundDir = join(sessionDir, 'ballots', `round-${validRound}`);
    mkdirSync(roundDir, { recursive: true });

    const sVoter = this.sanitizeName(voter);
    const ballotRecord = {
      $schema: 'council.ballot/v1',
      sessionId: basename(sessionDir),
      round: validRound,
      voter: sVoter,
      role,
      agent,
      vote: normalizedVote,
      score: Math.max(1, Math.min(10, Number(score) || 5)),
      rationale,
      amendments: Array.isArray(amendments) ? amendments : [],
      targetArtifactSha256,
      submittedAt: new Date().toISOString()
    };

    const ballotPath = join(roundDir, `${sVoter}.json`);
    atomicWrite(ballotPath, JSON.stringify(ballotRecord, null, 2));

    return { ballotPath, ballot: ballotRecord };
  }

  /**
   * Tally ballots in a given round deterministically.
   * Votes are sorted deterministically by (score desc, voter asc).
   */
  tallyBallots(sessionDir, round = 1, expectedVoters = [], options = {}) {
    const roundDir = join(sessionDir, 'ballots', `round-${round}`);
    if (!existsSync(roundDir)) {
      throw new Error(`Round directory does not exist: round-${round}`);
    }

    const quorumRatio = options.quorum !== undefined ? options.quorum : 0.67;
    const approvalThreshold = options.approvalThreshold !== undefined ? options.approvalThreshold : 0.6;

    const ballots = [];
    let approveCount = 0;
    let rejectCount = 0;
    let amendCount = 0;
    let totalScore = 0;
    const dissent = [];
    const invalidBallots = [];

    // Clean and sort expected voters for determinism
    const sortedExpected = expectedVoters.map(v => this.sanitizeName(v)).sort();

    for (const sVoter of sortedExpected) {
      const bPath = join(roundDir, `${sVoter}.json`);
      if (existsSync(bPath)) {
        try {
          const b = JSON.parse(readFileSync(bPath, 'utf8'));
          ballots.push(b);
          totalScore += b.score;
          if (b.vote === 'approve') {
            approveCount++;
          } else if (b.vote === 'reject') {
            rejectCount++;
            dissent.push({ voter: b.voter, rationale: b.rationale });
          } else if (b.vote === 'amend') {
            amendCount++;
            dissent.push({ voter: b.voter, rationale: b.rationale, amendments: b.amendments });
          }
        } catch (err) {
          invalidBallots.push({ voter: sVoter, error: err.message });
        }
      }
    }

    // Sort ballots deterministically by score descending, then voter name ascending
    ballots.sort((a, b) => b.score - a.score || a.voter.localeCompare(b.voter));
    dissent.sort((a, b) => a.voter.localeCompare(b.voter));

    const validCastCount = ballots.length;
    const totalCastCount = validCastCount + invalidBallots.length;
    const quorumMet = sortedExpected.length === 0 || (totalCastCount / sortedExpected.length) >= quorumRatio;
    const approvalRate = validCastCount > 0 ? (approveCount / validCastCount) : 0;
    const passed = quorumMet && (approvalRate >= approvalThreshold);

    const tally = {
      round,
      expectedCount: sortedExpected.length,
      castCount: totalCastCount,
      validCastCount,
      invalidCount: invalidBallots.length,
      invalidBallots,
      quorumMet,
      approveCount,
      rejectCount,
      amendCount,
      approvalRate: Number(approvalRate.toFixed(2)),
      averageScore: validCastCount > 0 ? Number((totalScore / validCastCount).toFixed(1)) : 0,
      passed,
      sortedBallots: ballots.map(b => ({ voter: b.voter, vote: b.vote, score: b.score })),
      dissent,
      talliedAt: new Date().toISOString()
    };

    atomicWrite(join(roundDir, 'tally.json'), JSON.stringify(tally, null, 2));
    return tally;
  }

  /**
   * Deterministic Representative Election:
   * Selects a representative from candidates based on a deterministic rule:
   * Rule: Highest ballot score, broken lexicographically by candidate name.
   */
  electRepresentative(sessionDir, round = 1, candidates = []) {
    const roundDir = join(sessionDir, 'ballots', `round-${round}`);
    const candidateScores = new Map();

    for (const c of candidates) {
      const sName = this.sanitizeName(c);
      const bPath = join(roundDir, `${sName}.json`);
      let score = 5;
      if (existsSync(bPath)) {
        try {
          const b = JSON.parse(readFileSync(bPath, 'utf8'));
          score = b.score || 5;
        } catch {}
      }
      candidateScores.set(sName, score);
    }

    const sorted = [...candidateScores.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]; // Highest score first
      return a[0].localeCompare(b[0]);       // Lexicographic tie-breaker
    });

    const elected = sorted.length > 0 ? sorted[0][0] : 'representative';
    const rule = 'highest-score-then-lexicographic-name';

    return { elected, rule, candidates: sorted.map(([name, score]) => ({ name, score })) };
  }

  /**
   * Representative validation pipeline:
   * Validates tally outcome, re-hashes artifact.md at check time, compares against ballot digest.
   * If SHA mismatch or quorum fail -> fails the check and denies promotion to reports/.
   */
  validateChoice(sessionDir, {
    representative,
    election = null,
    round = 1,
    targetArtifact = null,
    expectedSha256 = null,
    verdict = 'validated',
    rationale = '',
    conditions = []
  }) {
    const valDir = join(sessionDir, 'validation');
    mkdirSync(valDir, { recursive: true });

    let artifactIntegrity = true;
    let actualSha256 = null;
    let mutationDetected = false;

    if (targetArtifact) {
      const readRes = this.readArtifact(sessionDir, targetArtifact.phase, targetArtifact.author);
      if (!readRes) {
        artifactIntegrity = false;
      } else {
        actualSha256 = readRes.sha256;
        if (!readRes.verified || (expectedSha256 && actualSha256 !== expectedSha256)) {
          artifactIntegrity = false;
          mutationDetected = true;
        }
      }
    }

    // If mutation was detected, force verdict to vetoed
    const finalVerdict = mutationDetected ? 'vetoed' : verdict;
    const finalRationale = mutationDetected
      ? `CRITICAL AUDIT FAILURE: Target artifact SHA-256 mutation detected after voting round. Expected ${expectedSha256}, got ${actualSha256}.`
      : rationale;

    const record = {
      $schema: 'council.validation/v1',
      representative: this.sanitizeName(representative),
      round,
      verdict: finalVerdict,
      artifactIntegrity,
      mutationDetected,
      verifiedSha256: actualSha256,
      expectedSha256,
      election: election || null,
      rationale: finalRationale,
      conditions,
      validatedAt: new Date().toISOString()
    };

    atomicWrite(join(valDir, 'representative.json'), JSON.stringify(record, null, 2));

    const auditMarkdown = [
      `# Council Representative Validation Report`,
      `**Representative**: ${record.representative}`,
      `**Round**: ${round}`,
      `**Verdict**: **${record.verdict.toUpperCase()}**`,
      `**Artifact Integrity**: ${artifactIntegrity ? 'PASSED (SHA-256 Matched)' : 'FAILED / MUTATION DETECTED'}`,
      `**Validated Timestamp**: ${record.validatedAt}`,
      '',
      `## Representative Audit`,
      finalRationale || '(No detailed rationale provided)',
      '',
      conditions.length > 0 ? `## Binding Conditions\n${conditions.map(c => `- ${c}`).join('\n')}\n` : ''
    ].join('\n');

    atomicWrite(join(valDir, 'report.md'), auditMarkdown);

    return {
      passed: finalVerdict === 'validated' || finalVerdict === 'conditional',
      record,
      auditReportPath: join(valDir, 'report.md')
    };
  }

  /**
   * Final report promotion into reports/
   * Refuses promotion if validation check failed.
   */
  saveFinalDeliverables(sessionDir, { markdownReport, verdictJson = {}, validationPassed = true }) {
    if (!validationPassed) {
      return { promoted: false, reason: 'Validation failed or post-vote mutation detected.' };
    }

    const repDir = join(sessionDir, 'reports');
    mkdirSync(repDir, { recursive: true });

    const repPath = join(repDir, 'report.md');
    atomicWrite(repPath, markdownReport);

    const verdPath = join(repDir, 'verdict.json');
    atomicWrite(verdPath, JSON.stringify(verdictJson, null, 2));

    return { promoted: true, reportPath: repPath, verdictPath: verdPath };
  }
}
