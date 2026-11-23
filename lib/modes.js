import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HerdrClient } from './herdr.js';
import { AgentWorkspace, atomicWrite } from './workspace.js';
import { formatParticipantBrief, formatCouncilReport } from './formatters.js';
import { COLLABORATION_MODES, runCollaboration } from './collaboration.js';
import { saveFormalRound } from './formal-rounds.js';

export const SUPPORTED_MODES = ['council', 'review', 'delegate', ...COLLABORATION_MODES];

/**
 * Orchestrates multi-agent collaboration workflows via Herdr (`hc`),
 * with deterministic artifact exchange in `.agent_workspace/`,
 * formal voting ballots (`council.ballot/v1`), and representative validation.
 */
export class CouncilOrchestrator {
  constructor(options = {}) {
    this.herdr = options.herdr || new HerdrClient(options);
    this.cwd = options.cwd || process.cwd();
    this.workspace = options.workspace || new AgentWorkspace(this.cwd);
  }

  /**
   * Helper to extract explicit ballot vote, score, and rationale from agent text output.
   * NEVER invents a vote: if [VOTE:] marker is not found, returns null.
   */
  parseBallotFromOutput(text) {
    if (!text || typeof text !== 'string') return null;

    let vote = null;
    let score = null;
    let rationale = null;

    const voteMatch = /\[VOTE:\s*(approve|reject|amend)\]/i.exec(text);
    if (voteMatch) vote = voteMatch[1].toLowerCase();

    const scoreMatch = /\[SCORE:\s*(\d{1,2})\]/i.exec(text);
    if (scoreMatch) {
      const parsed = parseInt(scoreMatch[1], 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 10) {
        score = parsed;
      }
    }

    const ratMatch = /\[RATIONALE:\s*([^\]]+)\]/i.exec(text);
    if (ratMatch) rationale = ratMatch[1].trim();

    // Return null if no explicit vote marker is present
    if (!vote) return null;

    return {
      vote,
      score: score !== null ? score : 8,
      rationale: rationale || 'Explicit vote cast via terminal marker.'
    };
  }

  /**
   * Bounded wait for terminal completion:
   * Traverses initial startup-idle (turn 0) and intermediate message notifications (reason: 'message', ended: false)
   * by re-invoking herdr.wait with the remaining timeout until the turn completes (turn >= 1, done/exit),
   * blocks waiting for input, hits an error, or reaches the deadline.
   * Maintains strict raw wait contract (startup-idle is never treated as success).
   */
  waitForTurn(target, { timeoutSec = 180, onProgress = () => {}, afterTurn, deadline = Date.now() + Math.max(1, timeoutSec) * 1000 } = {}) {
    let lastRes = null;

    while (Date.now() < deadline) {
      const timeoutMs = Math.max(1, deadline - Date.now());
      const remainingSec = Math.ceil(timeoutMs / 1000);
      const waitRes = this.herdr.wait(target, { timeoutSec: remainingSec, timeoutMs });
      lastRes = waitRes;

      if (waitRes.success) {
        if (afterTurn !== undefined && waitRes.turn !== afterTurn + 1) {
          return { ...waitRes, success: false, error: `Terminal ${target} did not finish the expected Council turn.` };
        }
        return waitRes;
      }

      // If blocked or explicit error or process exit with error: terminal cannot proceed on its own
      if (waitRes.isBlocked || (waitRes.isError && waitRes.ended)) {
        return waitRes;
      }

      // If timeout: check if remainingSec expired
      if (waitRes.isTimeout && remainingSec <= 1) {
        return waitRes;
      }

      // Check if this is a transient state:
      // 1. Startup-idle: terminal is idle at turn 0 because agent hasn't started execution yet
      // 2. Intermediate message: reason === 'message' with ended === false
      const isStartupIdle = (waitRes.status === 'idle' || waitRes.reason === 'status') && (waitRes.turn === 0 || waitRes.turn === null);
      const isIntermediateMessage = waitRes.reason === 'message' && waitRes.ended === false;

      if (!isStartupIdle && !isIntermediateMessage) {
        // Any other non-transient failure: return immediately
        return waitRes;
      }

      // Transient state: continue waiting until next event or completion
    }

    // Deadline exceeded
    return {
      success: false,
      target,
      terminal: target,
      isTimeout: true,
      ended: false,
      status: 'working',
      reason: 'timeout',
      turn: lastRes?.turn ?? 0,
      error: `Turn timed out for ${target} after ${timeoutSec}s`
    };
  }

  /**
   * Main entry point to run a collaboration mode.
   */
  async runMode({
    mode = 'council',
    sessionId = null,
    task,
    subtasks = [],
    stages = [],
    round = 1,
    previousSession = null,
    context = '',
    criteria = '',
    agents = ['claude', 'codex', 'antigravity'],
    representative = null, // Default: Judge or 3rd agent
    permission = 'read',
    timeoutSec = 180,
    keepTerminals = false,
    onProgress = () => {}
  }) {
    if (!task) throw new Error('A task description is required.');
    const normalizedMode = mode.toLowerCase();
    if (!SUPPORTED_MODES.includes(normalizedMode)) {
      throw new Error(`Unsupported mode: ${mode}. Choose from: ${SUPPORTED_MODES.join(', ')}.`);
    }

    onProgress({ stage: 'start', mode: normalizedMode, task });

    if (COLLABORATION_MODES.includes(normalizedMode)) {
      return runCollaboration(this, { mode: normalizedMode, sessionId, task, subtasks, stages, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress });
    }

    const options = { sessionId, round, previousSession, task, context, criteria, agents, representative, permission, timeoutSec, keepTerminals, onProgress };
    const execute = { council: this.runCouncil, review: this.runReview, delegate: this.runDelegate }[normalizedMode];
    const result = await execute.call(this, { ...options, agent: agents[0] || 'claude' });
    if (!result.success && result.sessionDir && !result.validation) {
      this.workspace.saveFinalDeliverables(result.sessionDir, {
        markdownReport: result.report || result.error || 'This Council workflow did not finish.',
        verdictJson: { sessionId: result.sessionId, mode: normalizedMode, status: 'incomplete',
          completedAt: new Date().toISOString(), error: result.error ?? null },
        validationPassed: false
      });
    }
    return result;
  }

  /**
   * COUNCIL MODE:
   * Multi-agent deliberations: Author drafts, Skeptic critiques, Simplifier trims (Ponytail),
   * Voting round, followed by Representative validation and consensus synthesis.
   */
  async runCouncil({
    sessionId = null,
    round = 1,
    previousSession = null,
    task,
    context,
    criteria,
    agents,
    representative = null,
    permission,
    timeoutSec,
    keepTerminals,
    onProgress
  }) {
    const authorAgent = agents[0] || 'claude';
    const skepticAgent = agents[1] || 'codex';
    const simplifierAgent = agents[2] || 'antigravity';

    const pList = [
      { role: 'author', name: 'council-author', agent: authorAgent, weight: 1.0 },
      { role: 'skeptic', name: 'council-skeptic', agent: skepticAgent, weight: 1.0 },
      { role: 'simplifier', name: 'council-simplifier', agent: simplifierAgent, weight: 1.0 }
    ];

    const chosenRep = representative || 'council-author';

    // 1. Initialize deterministic workspace session
    const { sid, sessionDir, sessionMeta } = this.workspace.initSession({
      sessionId,
      mode: 'council',
      task,
      context,
      criteria,
      participants: pList
    });

    onProgress({ stage: 'workspace_initialized', sessionDir });

    const findings = {};
    const spawned = []; // Track spawned terminals: { name, terminalName, address, role, agent, completed }

    const shortId = this.workspace.sanitizeName(sid).slice(-6);
    const authorTerm = `c-${shortId}-auth`.slice(0, 32);
    const skepticTerm = `c-${shortId}-skep`.slice(0, 32);
    const simplifierTerm = `c-${shortId}-simp`.slice(0, 32);

    try {
      // --- STAGE 1: AUTHOR PROPOSAL PHASE ---
      onProgress({ stage: 'author_phase', agent: authorAgent });
      const authorBrief = formatParticipantBrief({
        role: 'author',
        name: 'council-author',
        agent: authorAgent,
        mode: 'council',
        task,
        context,
        criteria,
        ballot: { sessionDir, round },
        sessionPaths: {
          taskDir: `${sessionDir}/task`,
          artifactPath: `${sessionDir}/artifacts/draft/council-author/artifact.md`,
          ballotPath: `${sessionDir}/ballots/round-${round}/council-author.json`
        }
      });

      this.workspace.writeBrief(sessionDir, 'council-author', authorBrief);

      const aLaunch = this.herdr.launchAgent({
        name: authorTerm,
        agent: authorAgent,
        permission,
        cwd: this.cwd,
        task: authorBrief,
        sessionDir
      });

      if (!aLaunch.success || !aLaunch.address || aLaunch.details?.first_message?.sent === false) {
        const err = !aLaunch.success
          ? aLaunch.error
          : (!aLaunch.address ? 'Launch failed: no terminal address returned' : 'Task delivery failed: first_message not sent');
        onProgress({ stage: 'author_failed', error: err });
        return {
          success: false,
          status: 'launch_failed',
          error: err,
          sessionId: sid,
          sessionDir,
          mode: 'council',
          task,
          participants: pList,
          findings: {},
          tally: null,
          validation: null,
          report: `# Council Deliberation Aborted\n\n**Error**: ${err}\n\nTerminals preserved for recovery.`
        };
      }

      const authorRecord = {
        name: 'council-author',
        terminalName: authorTerm,
        address: aLaunch.address,
        role: 'author',
        agent: authorAgent,
        completed: false
      };
      spawned.push(authorRecord);

      onProgress({ stage: 'waiting_author', terminal: authorRecord.address });
      const aWait = this.waitForTurn(authorRecord.address, { timeoutSec, onProgress, afterTurn: aLaunch.baselineTurn });

      if (!aWait.success) {
        const failMsg = aWait.isTimeout
          ? 'Author turn timed out'
          : (aWait.isBlocked ? 'Author terminal blocked waiting for input' : (aWait.error || 'Author failed to deliver proposal'));
        onProgress({ stage: 'author_failed', error: failMsg });

        return {
          success: false,
          status: 'author_failed',
          error: failMsg,
          sessionId: sid,
          sessionDir,
          mode: 'council',
          task,
          participants: pList,
          findings: {},
          tally: null,
          validation: null,
          report: `# Council Deliberation Aborted\n\n**Error**: ${failMsg}\n\nTerminals preserved for recovery.`
        };
      }

      // Retrieve Author proposal (prefer direct artifact, fall back to screen reading)
      let authorProposal = '';
      let authorSource = 'direct_artifact';
      const authorDirectPath = join(sessionDir, 'artifacts', 'draft', 'council-author', 'artifact.md');

      if (existsSync(authorDirectPath)) {
        try {
          const directText = readFileSync(authorDirectPath, 'utf8');
          if (directText.length > 0) {
            authorProposal = directText;
            this.workspace.writeArtifact(sessionDir, {
              phase: 'draft',
              author: 'council-author',
              agent: authorAgent,
              content: authorProposal,
              metadata: { source: authorSource, role: 'author' }
            });
          }
        } catch {}
      }

      if (!authorProposal) {
        const aRead = this.herdr.read(authorRecord.address, 300);
        if (!aRead.success) {
          return {
            success: false,
            status: 'author_failed',
            error: aRead.error || 'Failed to read screen output from author',
            sessionId: sid,
            sessionDir,
            mode: 'council',
            task,
            participants: pList,
            findings: {},
            tally: null,
            validation: null,
            report: `# Council Deliberation Aborted\n\n**Error**: Author read failed.`
          };
        }
        authorProposal = aRead.content || '';
        authorSource = 'terminal_screen_fallback';
        if (authorProposal) {
          this.workspace.writeArtifact(sessionDir, {
            phase: 'draft',
            author: 'council-author',
            agent: authorAgent,
            content: authorProposal,
            metadata: { source: authorSource, role: 'author' }
          });
        }
      }

      if (!authorProposal) {
        return {
          success: false,
          status: 'author_failed',
          error: 'Author produced empty proposal output.',
          sessionId: sid,
          sessionDir,
          mode: 'council',
          task,
          participants: pList,
          findings: {},
          tally: null,
          validation: null,
          report: `# Council Deliberation Aborted\n\n**Error**: Author produced empty proposal output.`
        };
      }

      const authorSha = this.workspace.sha256(authorProposal);
      atomicWrite(join(sessionDir, 'task', 'proposal-target.json'), JSON.stringify({
        sessionId: sid, createdAt: sessionMeta.createdAt, round: 1, sha256: authorSha
      }));
      findings['council-author'] = authorProposal;
      authorRecord.completed = true;
      onProgress({ stage: 'author_completed', sha256: authorSha, source: authorSource });

      // --- STAGE 2: REVIEW PHASE (HANDOFF AUTHOR PROPOSAL TO SKEPTIC & SIMPLIFIER) ---
      const reviewers = [
        { role: 'skeptic', name: 'council-skeptic', terminalName: skepticTerm, agent: skepticAgent },
        { role: 'simplifier', name: 'council-simplifier', terminalName: simplifierTerm, agent: simplifierAgent }
      ];

      for (const r of reviewers) {
        onProgress({ stage: 'launch', name: r.name, role: r.role, agent: r.agent });
        const reviewBrief = formatParticipantBrief({
          role: r.role,
          name: r.name,
          agent: r.agent,
          mode: 'council',
          task: `Review the author's proposal for: ${task}\n\n## Author Proposal Under Review (SHA-256: ${authorSha})\nSource: artifacts/draft/council-author/artifact.md\n\n${authorProposal}`,
          context,
          criteria,
          ballot: { sessionDir, round, targetArtifactSha256: authorSha },
          sessionPaths: {
            taskDir: `${sessionDir}/task`,
            artifactPath: `${sessionDir}/artifacts/review/${r.name}/artifact.md`,
            ballotPath: `${sessionDir}/ballots/round-${round}/${r.name}.json`
          }
        });

        this.workspace.writeBrief(sessionDir, r.name, reviewBrief);

        const rLaunch = this.herdr.launchAgent({
          name: r.terminalName,
          agent: r.agent,
          permission: 'read',
          cwd: this.cwd,
          task: reviewBrief,
          sessionDir
        });

        if (!rLaunch.success || !rLaunch.address || rLaunch.details?.first_message?.sent === false) {
          const err = !rLaunch.success
            ? rLaunch.error
            : (!rLaunch.address ? `Launch failed for ${r.name}: no address returned` : `Task delivery not sent for ${r.name}`);
          return {
            success: false,
            status: 'launch_failed',
            error: err,
            sessionId: sid,
            sessionDir,
            mode: 'council',
            task,
            participants: pList,
            findings,
            tally: null,
            validation: null,
            report: `# Council Deliberation Aborted\n\n**Error**: ${err}\n\nTerminals preserved for recovery.`
          };
        }

        const rRecord = {
          name: r.name,
          terminalName: r.terminalName,
          address: rLaunch.address,
          baselineTurn: rLaunch.baselineTurn,
          role: r.role,
          agent: r.agent,
          completed: false
        };
        spawned.push(rRecord);
      }

      // Wait on reviewers
      let hasIncomplete = false;
      let incompleteError = null;

      for (const rRecord of spawned.filter(s => s.role !== 'author')) {
        onProgress({ stage: 'waiting_reviewer', name: rRecord.name, terminal: rRecord.address });
        const rWait = this.waitForTurn(rRecord.address, { timeoutSec, onProgress, afterTurn: rRecord.baselineTurn });

        if (!rWait.success) {
          rRecord.completed = false;
          findings[rRecord.name] = '';
          hasIncomplete = true;
          incompleteError = incompleteError || (rWait.isTimeout
            ? `${rRecord.name} timed out`
            : (rWait.isBlocked ? `${rRecord.name} blocked` : (rWait.error || `${rRecord.name} failed`)));
          continue;
        }

        rRecord.completed = true;

        let reviewContent = '';
        let reviewSource = 'direct_artifact';
        const rDirectPath = join(sessionDir, 'artifacts', 'review', rRecord.name, 'artifact.md');

        if (existsSync(rDirectPath)) {
          try {
            const dt = readFileSync(rDirectPath, 'utf8');
            if (dt.length > 0) reviewContent = dt;
          } catch {}
        }

        if (!reviewContent) {
          const rRead = this.herdr.read(rRecord.address, 300);
          if (rRead.success) {
            reviewContent = rRead.content || '';
            reviewSource = 'terminal_screen_fallback';
          }
        }
        if (reviewContent) {
          this.workspace.writeArtifact(sessionDir, {
            phase: 'review', author: rRecord.name, agent: rRecord.agent, content: reviewContent,
            metadata: { source: reviewSource, role: rRecord.role }
          });
        }

        findings[rRecord.name] = reviewContent;
      }

      if (hasIncomplete) {
        return {
          success: false,
          status: 'incomplete',
          error: incompleteError,
          sessionId: sid,
          sessionDir,
          mode: 'council',
          task,
          participants: pList,
          findings,
          tally: null,
          validation: null,
          report: `# Council Deliberation Incomplete\n\n**Error**: ${incompleteError}\n\nTerminals preserved for recovery.`
        };
      }

      // --- STAGE 3: FORMAL BALLOTS (DIRECT ONLY AUTHORIZES) ---
      onProgress({ stage: 'voting_round', round });
      const voterNames = ['council-author', 'council-skeptic', 'council-simplifier'];
      const screenBallots = [];

      for (const vName of voterNames) {
        const sVoter = this.workspace.sanitizeName(vName);
        const directBallotPath = join(sessionDir, 'ballots', `round-${round}`, `${sVoter}.json`);
        if (existsSync(directBallotPath)) {
          onProgress({ stage: 'ballot_detected', name: vName, source: 'direct', path: directBallotPath });
          continue;
        }

        // Screen output and parsed markers remain informational and provisional.
        // They do NOT contribute to authorizing quorum; only direct ballots authorize.
        const parsedBallot = this.parseBallotFromOutput(findings[vName]);
        if (parsedBallot) {
          screenBallots.push({ voter: vName, ...parsedBallot });
          onProgress({ stage: 'ballot_provisional_screen', name: vName, vote: parsedBallot.vote, score: parsedBallot.score });
        } else {
          onProgress({ stage: 'ballot_missing', name: vName, reason: 'No direct ballot or vote marker' });
        }
      }

      // --- STAGE 4: TALLY DIRECT BALLOTS ---
      const tally = this.workspace.tallyBallots(sessionDir, round, voterNames, {
        quorum: 0.67,
        approvalThreshold: 0.6,
        expectedArtifactSha256: authorSha
      });
      onProgress({ stage: 'tally_completed', tally });

      // --- STAGE 5: REPRESENTATIVE ELECTION & VALIDATION ---
      const election = this.workspace.electRepresentative(sessionDir, round, voterNames);
      const repToUse = representative || election.elected;

      onProgress({ stage: 'representative_validation', representative: repToUse });
      const valRes = this.workspace.validateChoice(sessionDir, {
        representative: repToUse,
        election,
        round,
        targetArtifact: { phase: 'draft', author: 'council-author' },
        expectedSha256: authorSha,
        tally,
        validationType: 'mechanical_tally_rule'
      });

      // Check for screen-only evidence when direct quorum is not met
      let isProvisional = false;
      if (!tally.quorumMet && screenBallots.length > 0) {
        isProvisional = true;
        valRes.record.verdict = 'provisional';
        valRes.record.rationale = `Provisional evidence only: ${screenBallots.length} screen marker(s) detected, but insufficient direct ballots (${tally.validCastCount}/${tally.expectedCount}) to meet authorizing quorum.`;
        valRes.passed = false;
      }

      // --- STAGE 6: HONEST MECHANICAL SYNTHESIS ---
      const synthesis = [
        `**Aggregation Type**: Mechanical Orchestrator Tally (No agent synthesis turn executed)`,
        `**Author Proposal**: artifacts/draft/council-author/artifact.md (SHA-256: ${authorSha})`,
        `**Formal Voting Outcome**: ${tally.approveCount} approved, ${tally.rejectCount} rejected, ${tally.amendCount} amended, ${tally.invalidCount} invalid.`,
        `**Quorum Status**: ${tally.quorumMet ? 'Quorum Met' : 'QUORUM FAILED (Only ' + tally.validCastCount + '/' + tally.expectedCount + ' valid ballots cast)'}.`,
        isProvisional ? `**Provisional Notice**: Screen markers observed but direct quorum not met. Promotion refused.` : ''
      ].filter(Boolean).join('\n');

      const verdictText = [
        `### Council Mechanical Tally: ${valRes.record.verdict.toUpperCase()}`,
        `- **Ruling**: ${valRes.record.verdict.toUpperCase()}`,
        `- **Validation Status**: ${valRes.passed ? 'PASSED / PROMOTED' : 'FAILED / PROMOTION DENIED'}`,
        `- **Audit Record**: Sealed in \`.agent_workspace/${sid}/validation/representative.json\`.`,
        `- **Session directory**: \`${sessionDir}\``,
        isProvisional ? '- **Next action**: Participants must submit their own direct ballots through MCP `council_cast_ballot` or CLI `cast-ballot`, using the assigned voter and exact proposal digest. Late ballots refresh the recorded tally.' : '',
        valRes.record.rationale ? `- **Rationale**: ${valRes.record.rationale}` : ''
      ].filter(Boolean).join('\n');

      const report = formatCouncilReport({
        title: `Council Deliberation Report: ${valRes.record.verdict.toUpperCase()}`,
        mode: 'council',
        task,
        participants: pList,
        findings,
        tally,
        validation: valRes.record,
        synthesis,
        verdict: verdictText
      });

      // Save deliverables only if validation passed
      this.workspace.saveFinalDeliverables(sessionDir, {
        markdownReport: report,
        verdictJson: {
          sessionId: sid,
          mode: 'council',
          task,
          tally,
          validation: valRes.record,
          artifactsIndex: `${sessionDir}/artifacts/index.jsonl`
        },
        validationPassed: valRes.passed
      });

      saveFormalRound(sessionDir, { mode: 'council', round, previousSession, sha256: authorSha, representative: valRes.record.representative });

      return {
        success: valRes.passed,
        status: isProvisional ? 'provisional' : valRes.record.verdict,
        authorized: Boolean(valRes.passed),
        ...(isProvisional ? {
          nextActions: [
            'Direct authorizing ballots required. Participants must cast ballots via `council cast-ballot` or MCP `council_cast_ballot` to ratify this proposal.'
          ]
        } : {}),
        sessionId: sid,
        sessionDir,
        mode: 'council',
        task,
        participants: pList,
        findings,
        tally,
        validation: valRes.record,
        report
      };
    } finally {
      if (!keepTerminals && spawned.length > 0) {
        for (const term of spawned) {
          if (term.completed) {
            this.herdr.dismiss(term.address || term.terminalName);
          } else {
            onProgress({ stage: 'terminal_preserved', target: term.address || term.terminalName, reason: 'incomplete' });
          }
        }
      }
    }
  }

  /**
   * REVIEW MODE:
   * Author writes, Reviewer inspects, Simplifier (Ponytail) cuts bloat.
   * Formal ballot voting and Representative sign-off.
   */
  async runReview({
    sessionId = null,
    round = 1,
    previousSession = null,
    task,
    context,
    criteria,
    agents,
    representative = null,
    permission,
    timeoutSec,
    keepTerminals,
    onProgress
  }) {
    const authorAgent = agents[0] || 'claude';
    const reviewerAgent = agents[1] || 'codex';
    const simplifierAgent = agents[2] || 'junie';

    const pList = [
      { role: 'author', name: 'review-author', agent: authorAgent },
      { role: 'reviewer', name: 'review-reviewer', agent: reviewerAgent },
      { role: 'simplifier', name: 'review-simplifier', agent: simplifierAgent }
    ];

    const chosenRep = representative || 'review-reviewer';

    const { sid, sessionDir, sessionMeta } = this.workspace.initSession({
      sessionId,
      mode: 'review',
      task,
      context,
      criteria,
      participants: pList
    });

    const findings = {};
    const spawned = [];

    const shortId = this.workspace.sanitizeName(sid).slice(-6);
    const authorTerm = `r-${shortId}-auth`.slice(0, 32);
    const reviewerTerm = `r-${shortId}-rev`.slice(0, 32);
    const simplifierTerm = `r-${shortId}-simp`.slice(0, 32);

    try {
      // 1. Author executes or proposes solution
      onProgress({ stage: 'author_phase', agent: authorAgent });
      const authorBrief = formatParticipantBrief({
        role: 'author',
        name: 'review-author',
        agent: authorAgent,
        mode: 'review',
        task,
        context,
        criteria,
        sessionPaths: {
          taskDir: `${sessionDir}/task`,
          artifactPath: `${sessionDir}/artifacts/draft/review-author/artifact.md`
        }
      });

      this.workspace.writeBrief(sessionDir, 'review-author', authorBrief);

      const aLaunch = this.herdr.launchAgent({
        name: authorTerm,
        agent: authorAgent,
        permission,
        cwd: this.cwd,
        task: authorBrief,
        sessionDir
      });

      if (!aLaunch.success || !aLaunch.address || aLaunch.details?.first_message?.sent === false) {
        const err = !aLaunch.success
          ? aLaunch.error
          : (!aLaunch.address ? 'Launch failed: no terminal address returned' : 'Task delivery failed: first_message not sent');
        return {
          success: false,
          status: 'launch_failed',
          error: err,
          sessionId: sid,
          sessionDir,
          mode: 'review',
          task,
          participants: pList,
          findings: {},
          tally: null,
          validation: null,
          report: `# Peer Review Aborted\n\n**Error**: ${err}\n\nTerminals preserved for recovery.`
        };
      }

      const authorRecord = {
        name: 'review-author',
        terminalName: authorTerm,
        address: aLaunch.address,
        role: 'author',
        agent: authorAgent,
        completed: false
      };
      spawned.push(authorRecord);

      const aWait = this.waitForTurn(authorRecord.address, { timeoutSec, onProgress, afterTurn: aLaunch.baselineTurn });
      if (!aWait.success) {
        const failMsg = aWait.isTimeout ? 'Author turn timed out' : (aWait.isBlocked ? 'Author terminal blocked' : (aWait.error || 'Author turn failed'));
        return {
          success: false,
          status: 'author_failed',
          error: failMsg,
          sessionId: sid,
          sessionDir,
          mode: 'review',
          task,
          participants: pList,
          findings: {},
          tally: null,
          validation: null,
          report: `# Peer Review Aborted\n\n**Error**: ${failMsg}\n\nTerminals preserved for recovery.`
        };
      }

      let authorOut = '';
      let authorSource = 'direct_artifact';
      const directPaths = [
        join(sessionDir, 'artifacts', 'proposal', 'review-author', 'artifact.md'),
        join(sessionDir, 'artifacts', 'draft', 'review-author', 'artifact.md')
      ];

      for (const dp of directPaths) {
        if (existsSync(dp)) {
          try {
            const dt = readFileSync(dp, 'utf8');
            if (dt.length > 0) {
              authorOut = dt;
              this.workspace.writeArtifact(sessionDir, {
                phase: 'proposal',
                author: 'review-author',
                agent: authorAgent,
                content: authorOut,
                metadata: { source: authorSource }
              });
              break;
            }
          } catch {}
        }
      }

      if (!authorOut) {
        const aRead = this.herdr.read(authorRecord.address, 300);
        if (!aRead.success) {
          return {
            success: false,
            status: 'author_failed',
            error: aRead.error || 'Failed to read screen output from author',
            sessionId: sid,
            sessionDir,
            mode: 'review',
            task,
            participants: pList,
            findings: {},
            tally: null,
            validation: null,
            report: `# Peer Review Aborted\n\n**Error**: Author read failed.`
          };
        }
        authorOut = aRead.content || '';
        authorSource = 'terminal_screen_fallback';
        if (authorOut) {
          this.workspace.writeArtifact(sessionDir, {
            phase: 'proposal',
            author: 'review-author',
            agent: authorAgent,
            content: authorOut,
            metadata: { source: authorSource }
          });
        }
      }

      if (!authorOut) {
        return {
          success: false,
          status: 'author_failed',
          error: 'Author produced empty output.',
          sessionId: sid,
          sessionDir,
          mode: 'review',
          task,
          participants: pList,
          findings: {},
          tally: null,
          validation: null,
          report: `# Peer Review Aborted\n\n**Error**: Author produced empty output.`
        };
      }

      findings['review-author'] = authorOut;
      const authorSha = this.workspace.sha256(authorOut);
      atomicWrite(join(sessionDir, 'task', 'proposal-target.json'), JSON.stringify({
        sessionId: sid, createdAt: sessionMeta.createdAt, round: 1, sha256: authorSha
      }));
      authorRecord.completed = true;

      // 2. Launch Reviewer & Simplifier (Ponytail)
      const reviewers = [
        { role: 'reviewer', name: 'review-reviewer', terminalName: reviewerTerm, agent: reviewerAgent },
        { role: 'simplifier', name: 'review-simplifier', terminalName: simplifierTerm, agent: simplifierAgent }
      ];

      for (const r of reviewers) {
        onProgress({ stage: 'review_phase', name: r.name, role: r.role });
        const brief = formatParticipantBrief({
          role: r.role,
          name: r.name,
          agent: r.agent,
          mode: 'review',
          task: `Review the author's solution for: ${task}\n\n## Author Proposal Under Review (SHA-256: ${authorSha})\nSource: artifacts/draft/review-author/artifact.md\n\n${authorOut}`,
          context,
          criteria,
          ballot: { sessionDir, round, targetArtifactSha256: authorSha },
          sessionPaths: {
            taskDir: `${sessionDir}/task`,
            artifactPath: `${sessionDir}/artifacts/review/${r.name}/artifact.md`,
            ballotPath: `${sessionDir}/ballots/round-${round}/${r.name}.json`
          }
        });

        this.workspace.writeBrief(sessionDir, r.name, brief);

        const rLaunch = this.herdr.launchAgent({
          name: r.terminalName,
          agent: r.agent,
          permission: 'read',
          cwd: this.cwd,
          task: brief,
          sessionDir
        });

        if (!rLaunch.success || !rLaunch.address || rLaunch.details?.first_message?.sent === false) {
          const err = !rLaunch.success
            ? rLaunch.error
            : (!rLaunch.address ? `Launch failed for ${r.name}: no address returned` : `Task delivery not sent for ${r.name}`);
          return {
            success: false,
            status: 'launch_failed',
            error: err,
            sessionId: sid,
            sessionDir,
            mode: 'review',
            task,
            participants: pList,
            findings,
            tally: null,
            validation: null,
            report: `# Peer Review Aborted\n\n**Error**: ${err}\n\nTerminals preserved for recovery.`
          };
        }

        const rRecord = {
          name: r.name,
          terminalName: r.terminalName,
          address: rLaunch.address,
          baselineTurn: rLaunch.baselineTurn,
          role: r.role,
          agent: r.agent,
          completed: false
        };
        spawned.push(rRecord);
      }

      // Wait for reviewers and store artifacts
      let hasIncomplete = false;
      let incompleteError = null;

      for (const rRecord of spawned.filter(s => s.role !== 'author')) {
        const rWait = this.waitForTurn(rRecord.address, { timeoutSec, onProgress, afterTurn: rRecord.baselineTurn });

        if (!rWait.success) {
          rRecord.completed = false;
          findings[rRecord.name] = '';
          hasIncomplete = true;
          incompleteError = incompleteError || (rWait.isTimeout
            ? `${rRecord.name} timed out`
            : (rWait.isBlocked ? `${rRecord.name} blocked` : (rWait.error || `${rRecord.name} failed`)));
          continue;
        }

        rRecord.completed = true;

        let reviewContent = '';
        let reviewSource = 'direct_artifact';
        const rDirectPath = join(sessionDir, 'artifacts', 'review', rRecord.name, 'artifact.md');
        if (existsSync(rDirectPath)) {
          try {
            const dt = readFileSync(rDirectPath, 'utf8');
            if (dt.length > 0) reviewContent = dt;
          } catch {}
        }

        if (!reviewContent) {
          const rRead = this.herdr.read(rRecord.address, 300);
          if (rRead.success) {
            reviewContent = rRead.content || '';
            reviewSource = 'terminal_screen_fallback';
          }
        }
        if (reviewContent) {
          this.workspace.writeArtifact(sessionDir, {
            phase: 'review', author: rRecord.name, agent: rRecord.agent, content: reviewContent,
            metadata: { source: reviewSource, role: rRecord.role }
          });
        }

        findings[rRecord.name] = reviewContent;
      }

      if (hasIncomplete) {
        return {
          success: false,
          status: 'incomplete',
          error: incompleteError,
          sessionId: sid,
          sessionDir,
          mode: 'review',
          task,
          participants: pList,
          findings,
          tally: null,
          validation: null,
          report: `# Peer Review Incomplete\n\n**Error**: ${incompleteError}\n\nTerminals preserved for recovery.`
        };
      }

      // --- STAGE 3: FORMAL BALLOTS (DIRECT ONLY AUTHORIZES) ---
      const expectedReviewers = ['review-reviewer', 'review-simplifier'];
      const screenBallots = [];

      for (const vName of expectedReviewers) {
        const sVoter = this.workspace.sanitizeName(vName);
        const directBallotPath = join(sessionDir, 'ballots', `round-${round}`, `${sVoter}.json`);
        if (existsSync(directBallotPath)) {
          onProgress({ stage: 'ballot_detected', name: vName, source: 'direct', path: directBallotPath });
        } else {
          const parsed = this.parseBallotFromOutput(findings[vName]);
          if (parsed) {
            screenBallots.push({ voter: vName, ...parsed });
            onProgress({ stage: 'ballot_provisional_screen', name: vName, vote: parsed.vote, score: parsed.score });
          } else {
            onProgress({ stage: 'ballot_missing', name: vName, reason: 'No direct ballot or vote marker' });
          }
        }
      }

      // Tally & Validation
      const tally = this.workspace.tallyBallots(sessionDir, round, expectedReviewers, {
        quorum: 0.67,
        approvalThreshold: 0.6,
        expectedArtifactSha256: authorSha
      });

      const valRes = this.workspace.validateChoice(sessionDir, {
        representative: chosenRep,
        round,
        targetArtifact: { phase: 'proposal', author: 'review-author' },
        expectedSha256: authorSha,
        tally,
        validationType: 'mechanical_tally_rule'
      });

      let isProvisional = false;
      if (!tally.quorumMet && screenBallots.length > 0) {
        isProvisional = true;
        valRes.record.verdict = 'provisional';
        valRes.record.rationale = `Provisional evidence only: ${screenBallots.length} screen marker(s) detected, but insufficient direct ballots (${tally.validCastCount}/${tally.expectedCount}) to meet authorizing quorum.`;
        valRes.passed = false;
      }

      const verdictText = [
        `### Peer Review Outcome: ${valRes.record.verdict.toUpperCase()}`,
        `- **Ruling**: ${valRes.record.verdict.toUpperCase()}`,
        `- **Validation Status**: ${valRes.passed ? 'PASSED / PROMOTED' : 'FAILED / PROMOTION DENIED'}`,
        `- **Session directory**: \`${sessionDir}\``,
        `- **Proposal SHA-256**: \`${authorSha}\``,
        isProvisional ? '- **Next action**: Participants must submit their own direct ballots through MCP `council_cast_ballot` or CLI `cast-ballot`, using the assigned voter and exact proposal digest. Late ballots refresh the recorded tally.' : '',
        valRes.record.rationale ? `- **Rationale**: ${valRes.record.rationale}` : '',
        isProvisional ? `- **Provisional Notice**: Screen markers observed but direct quorum not met. Promotion refused.` : ''
      ].filter(Boolean).join('\n');

      const report = formatCouncilReport({
        title: `Peer Review & Simplification Report: ${valRes.record.verdict.toUpperCase()}`,
        mode: 'review',
        task,
        participants: pList,
        findings,
        tally,
        validation: valRes.record,
        verdict: verdictText
      });

      this.workspace.saveFinalDeliverables(sessionDir, {
        markdownReport: report,
        verdictJson: { sessionId: sid, mode: 'review', tally, validation: valRes.record },
        validationPassed: valRes.passed
      });

      saveFormalRound(sessionDir, { mode: 'review', round, previousSession, sha256: authorSha, representative: valRes.record.representative });

      return {
        success: valRes.passed,
        status: isProvisional ? 'provisional' : valRes.record.verdict,
        authorized: Boolean(valRes.passed),
        ...(isProvisional ? {
          nextActions: [
            'Direct authorizing ballots required. Participants must cast ballots via `council cast-ballot` or MCP `council_cast_ballot` to ratify this proposal.'
          ]
        } : {}),
        sessionId: sid,
        sessionDir,
        mode: 'review',
        task,
        participants: pList,
        findings,
        tally,
        validation: valRes.record,
        report
      };
    } finally {
      if (!keepTerminals && spawned.length > 0) {
        for (const term of spawned) {
          if (term.completed) {
            this.herdr.dismiss(term.address || term.terminalName);
          } else {
            onProgress({ stage: 'terminal_preserved', target: term.address || term.terminalName, reason: 'incomplete' });
          }
        }
      }
    }
  }

  /**
   * DELEGATE MODE:
   * Single specialist task delegated in Herdr with deterministic artifact tracking.
   */
  async runDelegate({
    sessionId = null,
    task,
    context = '',
    agent = 'claude',
    permission = 'read',
    timeoutSec = 180,
    keepTerminals = false,
    onProgress = () => {}
  }) {
    const termName = `delegate-${agent}-${Date.now().toString().slice(-4)}`;
    onProgress({ stage: 'delegate_start', name: termName, agent });

    const { sid, sessionDir } = this.workspace.initSession({
      sessionId,
      mode: 'delegate',
      task,
      context,
      participants: [{ name: termName, role: 'specialist', agent }]
    });

    let terminalAddress = null;
    let completed = false;

    try {
      this.workspace.writeBrief(sessionDir, termName, task);

      const res = this.herdr.launchAgent({
        name: termName,
        agent,
        permission,
        cwd: this.cwd,
        task,
        context,
        sessionDir
      });

      if (!res.success || !res.address || res.details?.first_message?.sent === false) {
        const err = !res.success
          ? res.error
          : (!res.address ? 'Launch failed: no terminal address returned' : 'Task delivery failed: first_message not sent');
        onProgress({ stage: 'delegate_failed', error: err });
        return {
          success: false,
          status: 'launch_failed',
          error: err,
          sessionId: sid,
          sessionDir,
          mode: 'delegate',
          name: termName,
          agent,
          task,
          output: ''
        };
      }

      terminalAddress = res.address;

      const deadline = Date.now() + Math.max(1, timeoutSec) * 1000;
      const waitRes = this.waitForTurn(terminalAddress, { timeoutSec, onProgress, afterTurn: res.baselineTurn, deadline });
      if (!waitRes.success) {
        const failMsg = waitRes.isTimeout
          ? 'Delegation turn timed out'
          : (waitRes.isBlocked ? 'Delegation terminal blocked waiting for input' : (waitRes.error || 'Delegation turn failed'));
        onProgress({ stage: 'delegate_failed', error: failMsg });
        return {
          success: false,
          status: 'failed',
          error: failMsg,
          sessionId: sid,
          sessionDir,
          mode: 'delegate',
          name: termName,
          agent,
          task,
          output: ''
        };
      }

      const readRes = await this.herdr.captureTurn(terminalAddress, waitRes.turn, { deadlineMs: deadline, lines: 200 });
      if (!readRes.success) {
        onProgress({ stage: 'delegate_failed', error: readRes.error });
        return {
          success: false,
          status: 'read_failed',
          error: readRes.error || 'Failed to read from specialist terminal',
          sessionId: sid,
          sessionDir,
          mode: 'delegate',
          name: termName,
          agent,
          task,
          output: ''
        };
      }

      const content = readRes.content || '';

      this.workspace.writeArtifact(sessionDir, {
        phase: 'delegation',
        author: termName,
        agent,
        content,
        metadata: { source: 'terminal', captureScope: readRes.captureScope ?? null, turn: waitRes.turn }
      });

      this.workspace.saveFinalDeliverables(sessionDir, {
        markdownReport: `# Delegation Report: ${termName}\n\n${content}`,
        verdictJson: { sessionId: sid, mode: 'delegate', status: 'completed', completedAt: new Date().toISOString(), agent, task }
      });

      completed = true;

      return {
        success: true,
        sessionId: sid,
        sessionDir,
        mode: 'delegate',
        name: termName,
        agent,
        task,
        output: content
      };
    } finally {
      if (!keepTerminals && terminalAddress) {
        if (completed) {
          this.herdr.dismiss(terminalAddress);
        } else {
          onProgress({ stage: 'terminal_preserved', target: terminalAddress, reason: 'incomplete' });
        }
      }
    }
  }
}
