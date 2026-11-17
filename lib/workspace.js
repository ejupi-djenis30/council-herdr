import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Deterministic Workspace Manager for Council Agents
 * All exchanged artifacts, briefs, ballots, and validation reports live under `.agent_workspace/`.
 */
export class AgentWorkspace {
  constructor(workspaceRoot = process.cwd()) {
    this.root = resolve(workspaceRoot);
    this.baseDir = join(this.root, '.agent_workspace');
  }

  /**
   * Sanitizes names to lowercase safe strings [a-z0-9-]
   */
  sanitizeName(name) {
    return String(name || 'anon')
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Compute sha256 hex digest of a string or buffer
   */
  sha256(content) {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Atomic file write via temporary file
   */
  atomicWrite(filePath, content) {
    const tmp = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, filePath);
  }

  /**
   * Initialize a deterministic session workspace
   */
  initSession({ sessionId, mode, task, context = '', criteria = '', participants = [] }) {
    const sid = this.sanitizeName(sessionId || `council-${Date.now().toString(36)}`);
    const sessionDir = join(this.baseDir, sid);

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

    // Write canonical task files
    this.atomicWrite(join(sessionDir, 'task', 'task.md'), task);
    if (context) this.atomicWrite(join(sessionDir, 'task', 'context.md'), context);
    if (criteria) this.atomicWrite(join(sessionDir, 'task', 'criteria.md'), criteria);

    // Write session manifest
    const sessionMeta = {
      sessionId: sid,
      mode,
      taskHash: this.sha256(task),
      participants: participants.map(p => ({
        name: this.sanitizeName(p.name),
        role: p.role,
        agent: p.agent,
        weight: p.weight || 1.0
      })),
      createdAt: new Date().toISOString(),
      status: 'active'
    };
    this.atomicWrite(join(sessionDir, 'session.json'), JSON.stringify(sessionMeta, null, 2));

    return { sid, sessionId: sid, sessionDir, sessionMeta };
  }

  /**
   * Write an agent brief file in briefs/<name>.md
   */
  writeBrief(sessionDir, name, content) {
    const sName = this.sanitizeName(name);
    const briefPath = join(sessionDir, 'briefs', `${sName}.md`);
    this.atomicWrite(briefPath, content);
    return briefPath;
  }

  /**
   * Write an agent artifact under artifacts/<phase>/<author>/artifact.md
   * Appends to artifacts/index.jsonl with SHA-256
   */
  writeArtifact(sessionDir, { phase = 'draft', author, agent, content, metadata = {} }) {
    const sPhase = this.sanitizeName(phase);
    const sAuthor = this.sanitizeName(author);
    const dir = join(sessionDir, 'artifacts', sPhase, sAuthor);
    mkdirSync(dir, { recursive: true });

    const artifactPath = join(dir, 'artifact.md');
    this.atomicWrite(artifactPath, content);

    const digest = this.sha256(content);
    const metaPath = join(dir, 'meta.json');
    const metaRecord = {
      phase: sPhase,
      author: sAuthor,
      agent,
      sha256: digest,
      byteLength: Buffer.byteLength(content, 'utf8'),
      createdAt: new Date().toISOString(),
      ...metadata
    };
    this.atomicWrite(metaPath, JSON.stringify(metaRecord, null, 2));

    // Append to index.jsonl
    const indexLine = JSON.stringify({
      phase: sPhase,
      author: sAuthor,
      path: `artifacts/${sPhase}/${sAuthor}/artifact.md`,
      sha256: digest,
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
    let recordedDigest = currentDigest;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        recordedDigest = meta.sha256;
      } catch {}
    }

    return {
      content,
      sha256: currentDigest,
      verified: currentDigest === recordedDigest,
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
    const roundDir = join(sessionDir, 'ballots', `round-${round}`);
    mkdirSync(roundDir, { recursive: true });

    const sVoter = this.sanitizeName(voter);
    const ballotRecord = {
      $schema: 'council.ballot/v1',
      round,
      voter: sVoter,
      role,
      agent,
      vote,
      score: Math.max(1, Math.min(10, Number(score) || 5)),
      rationale,
      amendments,
      targetArtifactSha256,
      submittedAt: new Date().toISOString()
    };

    const ballotPath = join(roundDir, `${sVoter}.json`);
    this.atomicWrite(ballotPath, JSON.stringify(ballotRecord, null, 2));

    return { ballotPath, ballot: ballotRecord };
  }

  /**
   * Tally ballots in a given round
   */
  tallyBallots(sessionDir, round = 1, expectedVoters = [], options = {}) {
    const roundDir = join(sessionDir, 'ballots', `round-${round}`);
    if (!existsSync(roundDir)) {
      throw new Error(`Round directory does not exist: round-${round}`);
    }

    const quorumRatio = options.quorum || 0.67; // 2/3 default
    const approvalThreshold = options.approvalThreshold || 0.6; // 60% approval

    const ballots = [];
    let approveCount = 0;
    let rejectCount = 0;
    let amendCount = 0;
    let totalScore = 0;
    const dissent = [];

    for (const voter of expectedVoters) {
      const sVoter = this.sanitizeName(voter);
      const bPath = join(roundDir, `${sVoter}.json`);
      if (existsSync(bPath)) {
        try {
          const b = JSON.parse(readFileSync(bPath, 'utf8'));
          ballots.push(b);
          totalScore += b.score;
          if (b.vote === 'approve') approveCount++;
          else if (b.vote === 'reject') {
            rejectCount++;
            dissent.push({ voter: b.voter, rationale: b.rationale });
          } else if (b.vote === 'amend') {
            amendCount++;
            dissent.push({ voter: b.voter, rationale: b.rationale, amendments: b.amendments });
          }
        } catch {}
      }
    }

    const castCount = ballots.length;
    const quorumMet = expectedVoters.length === 0 || (castCount / expectedVoters.length) >= quorumRatio;
    const approvalRate = castCount > 0 ? (approveCount / castCount) : 0;
    const passed = quorumMet && (approvalRate >= approvalThreshold);

    const tally = {
      round,
      expectedCount: expectedVoters.length,
      castCount,
      quorumMet,
      approveCount,
      rejectCount,
      amendCount,
      approvalRate,
      averageScore: castCount > 0 ? (totalScore / castCount).toFixed(1) : 0,
      passed,
      dissent,
      talliedAt: new Date().toISOString()
    };

    this.atomicWrite(join(roundDir, 'tally.json'), JSON.stringify(tally, null, 2));
    return tally;
  }

  /**
   * Representative validation pipeline:
   * Validates election/tally outcome, artifact integrity, and signs representative report.
   */
  validateChoice(sessionDir, {
    representative,
    round = 1,
    targetArtifact = null,
    verdict = 'validated', // 'validated' | 'vetoed' | 'conditional'
    rationale = '',
    conditions = []
  }) {
    const valDir = join(sessionDir, 'validation');
    mkdirSync(valDir, { recursive: true });

    let artifactIntegrity = true;
    let verifiedSha = null;

    if (targetArtifact) {
      const readRes = this.readArtifact(sessionDir, targetArtifact.phase, targetArtifact.author);
      if (!readRes || !readRes.verified) {
        artifactIntegrity = false;
      } else {
        verifiedSha = readRes.sha256;
      }
    }

    const record = {
      $schema: 'council.validation/v1',
      representative: this.sanitizeName(representative),
      round,
      verdict,
      artifactIntegrity,
      verifiedSha256: verifiedSha,
      rationale,
      conditions,
      validatedAt: new Date().toISOString()
    };

    this.atomicWrite(join(valDir, 'representative.json'), JSON.stringify(record, null, 2));

    const auditMarkdown = [
      `# Council Representative Validation Report`,
      `**Representative**: ${record.representative}`,
      `**Round**: ${round}`,
      `**Verdict**: ${verdict.toUpperCase()}`,
      `**Artifact Integrity**: ${artifactIntegrity ? 'PASSED (SHA-256 Matched)' : 'FAILED / UNVERIFIED'}`,
      `**Validated Timestamp**: ${record.validatedAt}`,
      '',
      `## Representative Rationale`,
      rationale || '(No detailed rationale provided)',
      '',
      conditions.length > 0 ? `## Binding Conditions\n${conditions.map(c => `- ${c}`).join('\n')}\n` : ''
    ].join('\n');

    this.atomicWrite(join(valDir, 'report.md'), auditMarkdown);

    return { record, auditReportPath: join(valDir, 'report.md') };
  }

  /**
   * Final report promotion into reports/
   */
  saveFinalDeliverables(sessionDir, { markdownReport, verdictJson = {} }) {
    const repDir = join(sessionDir, 'reports');
    mkdirSync(repDir, { recursive: true });

    const repPath = join(repDir, 'report.md');
    this.atomicWrite(repPath, markdownReport);

    const verdPath = join(repDir, 'verdict.json');
    this.atomicWrite(verdPath, JSON.stringify(verdictJson, null, 2));

    return { reportPath: repPath, verdictPath: verdPath };
  }
}
