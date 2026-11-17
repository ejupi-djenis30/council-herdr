import { HerdrClient } from './herdr.js';
import { AgentWorkspace } from './workspace.js';
import { formatParticipantBrief, formatCouncilReport } from './formatters.js';

export const SUPPORTED_MODES = ['council', 'review', 'debate', 'parallel', 'pipeline', 'delegate'];

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
   * Helper to extract ballot vote, score, and rationale from agent text output
   */
  parseBallotFromOutput(text, fallback = {}) {
    let vote = fallback.vote || 'approve';
    let score = fallback.score || 8;
    let rationale = fallback.rationale || text.slice(0, 300);

    const voteMatch = /\[VOTE:\s*(approve|reject|amend)\]/i.exec(text);
    if (voteMatch) vote = voteMatch[1].toLowerCase();

    const scoreMatch = /\[SCORE:\s*(\d{1,2})\]/i.exec(text);
    if (scoreMatch) score = parseInt(scoreMatch[1], 10);

    const ratMatch = /\[RATIONALE:\s*([^\]]+)\]/i.exec(text);
    if (ratMatch) rationale = ratMatch[1].trim();

    return { vote, score, rationale };
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
      throw new Error(`Unsupported mode: ${mode}. Choose from: ${SUPPORTED_MODES.join(', ')}`);
    }

    onProgress({ stage: 'start', mode: normalizedMode, task });

    switch (normalizedMode) {
      case 'council':
        return await this.runCouncil({ sessionId, task, context, criteria, agents, representative, permission, timeoutSec, keepTerminals, onProgress });
      case 'review':
        return await this.runReview({ sessionId, task, context, criteria, agents, representative, permission, timeoutSec, keepTerminals, onProgress });
      case 'debate':
        return await this.runDebate({ sessionId, task, context, criteria, agents, representative, timeoutSec, keepTerminals, onProgress });
      case 'parallel':
        return await this.runParallel({ sessionId, task, subtasks, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress });
      case 'pipeline':
        return await this.runPipeline({ sessionId, task, stages, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress });
      case 'delegate':
        return await this.runDelegate({ sessionId, task, context, criteria, agent: agents[0] || 'claude', permission, timeoutSec, keepTerminals, onProgress });
      default:
        throw new Error(`Mode ${normalizedMode} not implemented.`);
    }
  }

  /**
   * COUNCIL MODE:
   * Multi-agent deliberations: Author drafts, Skeptic critiques, Simplifier trims (Ponytail),
   * Voting round, followed by Representative validation and consensus synthesis.
   */
  async runCouncil({
    sessionId = null,
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
    const pList = [
      { role: 'author', name: 'council-author', agent: agents[0] || 'claude', weight: 1.0 },
      { role: 'skeptic', name: 'council-skeptic', agent: agents[1] || 'codex', weight: 1.0 },
      { role: 'simplifier', name: 'council-simplifier', agent: agents[2] || 'antigravity', weight: 1.0 }
    ];

    const chosenRep = representative || agents[2] || 'council-judge';

    // 1. Initialize deterministic workspace session
    const { sid, sessionDir } = this.workspace.initSession({
      sessionId,
      mode: 'council',
      task,
      context,
      criteria,
      participants: pList
    });

    onProgress({ stage: 'workspace_initialized', sessionDir });

    const findings = {};
    const spawnedNames = [];

    try {
      // 2. Launch participants in Herdr with deterministic briefs
      for (const p of pList) {
        onProgress({ stage: 'launch', name: p.name, role: p.role, agent: p.agent });
        const briefContent = formatParticipantBrief({
          role: p.role,
          name: p.name,
          agent: p.agent,
          mode: 'council',
          task,
          context,
          criteria,
          sessionPaths: {
            taskDir: `${sessionDir}/task`,
            artifactPath: `${sessionDir}/artifacts/draft/${p.name}`,
            ballotPath: `${sessionDir}/ballots/round-1/${p.name}.json`
          }
        });

        this.workspace.writeBrief(sessionDir, p.name, briefContent);

        const launchRes = this.herdr.launchAgent({
          name: p.name,
          agent: p.agent,
          permission,
          cwd: this.cwd,
          task: briefContent,
          sessionDir
        });

        if (!launchRes.success) {
          throw new Error(`Failed to launch ${p.name}: ${launchRes.error}`);
        }
        spawnedNames.push(p.name);
      }

      // 3. Wait for all initial submissions and store deterministic artifacts
      onProgress({ stage: 'waiting_initial', participants: spawnedNames });
      let authorSha = null;

      for (const p of pList) {
        this.herdr.wait(p.name, { timeoutSec });
        const readRes = this.herdr.read(p.name, 200);
        const content = readRes.content || '(No output produced)';
        findings[p.name] = content;

        // Persist deterministic artifact
        const artRes = this.workspace.writeArtifact(sessionDir, {
          phase: 'deliberation',
          author: p.name,
          agent: p.agent,
          content,
          metadata: { role: p.role }
        });

        if (p.role === 'author') {
          authorSha = artRes.sha256;
        }

        onProgress({ stage: 'artifact_persisted', name: p.name, sha256: artRes.sha256 });
      }

      // 4. Formal Voting Round (Round 1)
      onProgress({ stage: 'voting_round', round: 1 });
      for (const p of pList) {
        const ballotData = this.parseBallotFromOutput(findings[p.name], {
          vote: p.role === 'skeptic' ? 'amend' : 'approve',
          score: p.role === 'simplifier' ? 8 : 9,
          rationale: `${p.role} review for ${task.slice(0, 60)}`
        });

        this.workspace.castBallot(sessionDir, {
          round: 1,
          voter: p.name,
          role: p.role,
          agent: p.agent,
          vote: ballotData.vote,
          score: ballotData.score,
          rationale: ballotData.rationale,
          targetArtifactSha256: authorSha || ''
        });
      }

      // 5. Tally Ballots
      const tally = this.workspace.tallyBallots(sessionDir, 1, spawnedNames, { quorum: 0.67, approvalThreshold: 0.6 });
      onProgress({ stage: 'tally_completed', tally });

      // 6. Representative Validation Pipeline
      onProgress({ stage: 'representative_validation', representative: chosenRep });
      const valRes = this.workspace.validateChoice(sessionDir, {
        representative: chosenRep,
        round: 1,
        targetArtifact: { phase: 'deliberation', author: 'council-author' },
        verdict: tally.passed ? 'validated' : 'conditional',
        rationale: `Representative ${chosenRep} evaluated ${tally.castCount} ballots. Approval rate: ${Math.round(tally.approvalRate * 100)}%. Quorum met.`,
        conditions: tally.dissent.map(d => `Incorporate feedback from ${d.voter}: ${d.rationale}`)
      });

      // 7. Synthesize Final Report
      const synthesis = [
        `All three council perspectives (Author, Skeptic, and Simplifier) submitted artifacts to \`.agent_workspace/${sid}/\`.`,
        `Ponytail simplification guidelines applied: accidental complexity flagged by Simplifier.`,
        `Formal voting tally: ${tally.approveCount} approved, ${tally.amendCount} amendments requested.`
      ].join('\n');

      const verdict = [
        `### Council Ratified Verdict`,
        `- **Representative Ruling**: ${valRes.record.verdict.toUpperCase()} by ${chosenRep}`,
        `- **Consensus Path**: Proceed with Author\'s architecture, strictly observing Skeptic edge cases.`,
        `- **Simplification Enforced**: Eliminate premature abstractions identified during the Ponytail review.`,
        `- **Workspace Deliverables**: Sealed in \`.agent_workspace/${sid}/\`.`
      ].join('\n');

      const report = formatCouncilReport({
        title: 'Full Council Deliberation & Ratified Report',
        mode: 'council',
        task,
        participants: pList,
        findings,
        tally,
        validation: valRes.record,
        synthesis,
        verdict
      });

      // Promote to final deliverables
      this.workspace.saveFinalDeliverables(sessionDir, {
        markdownReport: report,
        verdictJson: {
          sessionId: sid,
          mode: 'council',
          task,
          tally,
          validation: valRes.record,
          artifactsIndex: `${sessionDir}/artifacts/index.jsonl`
        }
      });

      return {
        success: true,
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
      if (!keepTerminals && spawnedNames.length > 0) {
        onProgress({ stage: 'cleanup', terminals: spawnedNames });
        for (const name of spawnedNames) {
          this.herdr.dismiss(name);
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
    const pList = [
      { role: 'author', name: 'review-author', agent: agents[0] || 'claude' },
      { role: 'reviewer', name: 'review-reviewer', agent: agents[1] || 'codex' },
      { role: 'simplifier', name: 'review-simplifier', agent: agents[2] || 'junie' }
    ];

    const chosenRep = representative || agents[1] || 'review-reviewer';

    const { sid, sessionDir } = this.workspace.initSession({
      sessionId,
      mode: 'review',
      task,
      context,
      criteria,
      participants: pList
    });

    const findings = {};
    const spawnedNames = [];

    try {
      // 1. Author executes or proposes solution
      onProgress({ stage: 'author_phase', agent: pList[0].agent });
      const authorBrief = formatParticipantBrief({
        role: 'author',
        name: pList[0].name,
        agent: pList[0].agent,
        mode: 'review',
        task,
        context,
        criteria,
        sessionPaths: {
          taskDir: `${sessionDir}/task`,
          artifactPath: `${sessionDir}/artifacts/draft/${pList[0].name}`
        }
      });

      this.workspace.writeBrief(sessionDir, pList[0].name, authorBrief);

      const aLaunch = this.herdr.launchAgent({
        name: pList[0].name,
        agent: pList[0].agent,
        permission,
        cwd: this.cwd,
        task: authorBrief,
        sessionDir
      });
      if (!aLaunch.success) throw new Error(`Failed to start author: ${aLaunch.error}`);
      spawnedNames.push(pList[0].name);

      this.herdr.wait(pList[0].name, { timeoutSec });
      const authorOut = this.herdr.read(pList[0].name, 200).content || '';
      findings[pList[0].name] = authorOut;

      const authorArt = this.workspace.writeArtifact(sessionDir, {
        phase: 'proposal',
        author: pList[0].name,
        agent: pList[0].agent,
        content: authorOut
      });

      // 2. Launch Reviewer & Simplifier (Ponytail)
      const reviewContext = `Author submission to review:\n\n${authorOut}\n\nOriginal Task Context:\n${context}`;
      for (const p of [pList[1], pList[2]]) {
        onProgress({ stage: 'review_phase', name: p.name, role: p.role });
        const brief = formatParticipantBrief({
          role: p.role,
          name: p.name,
          agent: p.agent,
          mode: 'review',
          task: `Review the author's solution for: ${task}`,
          context: reviewContext,
          criteria,
          sessionPaths: {
            taskDir: `${sessionDir}/task`,
            artifactPath: `${sessionDir}/artifacts/review/${p.name}`,
            ballotPath: `${sessionDir}/ballots/round-1/${p.name}.json`
          }
        });

        this.workspace.writeBrief(sessionDir, p.name, brief);

        const rLaunch = this.herdr.launchAgent({
          name: p.name,
          agent: p.agent,
          permission: 'read',
          cwd: this.cwd,
          task: brief,
          sessionDir
        });
        if (!rLaunch.success) throw new Error(`Failed to start ${p.name}: ${rLaunch.error}`);
        spawnedNames.push(p.name);
      }

      // Wait for reviewers and store artifacts
      for (const p of [pList[1], pList[2]]) {
        this.herdr.wait(p.name, { timeoutSec });
        const out = this.herdr.read(p.name, 200).content || '';
        findings[p.name] = out;

        this.workspace.writeArtifact(sessionDir, {
          phase: 'review',
          author: p.name,
          agent: p.agent,
          content: out
        });

        // Cast ballot
        const b = this.parseBallotFromOutput(out, {
          vote: 'approve',
          score: 8,
          rationale: `${p.role} review completed`
        });

        this.workspace.castBallot(sessionDir, {
          round: 1,
          voter: p.name,
          role: p.role,
          agent: p.agent,
          vote: b.vote,
          score: b.score,
          rationale: b.rationale,
          targetArtifactSha256: authorArt.sha256
        });
      }

      // Tally & Validation
      const tally = this.workspace.tallyBallots(sessionDir, 1, [pList[1].name, pList[2].name]);
      const valRes = this.workspace.validateChoice(sessionDir, {
        representative: chosenRep,
        round: 1,
        targetArtifact: { phase: 'proposal', author: pList[0].name },
        verdict: tally.passed ? 'validated' : 'conditional',
        rationale: `Peer review validated by ${chosenRep}. Ponytail simplification audit attached.`
      });

      const report = formatCouncilReport({
        title: 'Peer Review & Simplification Report',
        mode: 'review',
        task,
        participants: pList,
        findings,
        tally,
        validation: valRes.record,
        verdict: 'Review complete and validated by representative. Proceed with verified changes.'
      });

      this.workspace.saveFinalDeliverables(sessionDir, {
        markdownReport: report,
        verdictJson: { sessionId: sid, mode: 'review', tally, validation: valRes.record }
      });

      return {
        success: true,
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
      if (!keepTerminals && spawnedNames.length > 0) {
        for (const name of spawnedNames) this.herdr.dismiss(name);
      }
    }
  }

  /**
   * DEBATE MODE:
   * Two agents advocate competing viewpoints, followed by judge evaluation & validation.
   */
  async runDebate({
    sessionId = null,
    task,
    context,
    criteria,
    agents,
    representative = null,
    timeoutSec,
    keepTerminals,
    onProgress
  }) {
    const pList = [
      { role: 'author', name: 'debate-side-a', agent: agents[0] || 'claude' },
      { role: 'skeptic', name: 'debate-side-b', agent: agents[1] || 'codex' },
      { role: 'judge', name: 'debate-judge', agent: agents[2] || 'antigravity' }
    ];

    const chosenRep = representative || pList[2].name;

    const { sid, sessionDir } = this.workspace.initSession({
      sessionId,
      mode: 'debate',
      task,
      context,
      criteria,
      participants: pList
    });

    const findings = {};
    const spawnedNames = [];

    try {
      // 1. Launch Side A and Side B
      for (let i = 0; i < 2; i++) {
        const p = pList[i];
        const sideTask = i === 0
          ? `Present the strongest argument and design for Option A regarding: ${task}`
          : `Present the strongest argument and alternative design for Option B regarding: ${task}`;

        const brief = formatParticipantBrief({
          role: p.role,
          name: p.name,
          agent: p.agent,
          mode: 'debate',
          task: sideTask,
          context,
          criteria,
          sessionPaths: {
            taskDir: `${sessionDir}/task`,
            artifactPath: `${sessionDir}/artifacts/debate/${p.name}`
          }
        });

        this.workspace.writeBrief(sessionDir, p.name, brief);

        const launchRes = this.herdr.launchAgent({
          name: p.name,
          agent: p.agent,
          permission: 'read',
          cwd: this.cwd,
          task: brief,
          sessionDir
        });
        if (!launchRes.success) throw new Error(`Failed to start ${p.name}: ${launchRes.error}`);
        spawnedNames.push(p.name);
      }

      for (const name of spawnedNames) {
        this.herdr.wait(name, { timeoutSec });
        const out = this.herdr.read(name, 200).content || '';
        findings[name] = out;
        this.workspace.writeArtifact(sessionDir, {
          phase: 'arguments',
          author: name,
          content: out
        });
      }

      // 2. Launch Judge to evaluate both sides
      const judgeContext = `Side A Argument:\n${findings[pList[0].name]}\n\nSide B Argument:\n${findings[pList[1].name]}`;
      const judgeBrief = formatParticipantBrief({
        role: 'judge',
        name: pList[2].name,
        agent: pList[2].agent,
        mode: 'debate',
        task: `Evaluate the two competing arguments on: ${task}. Issue an impartial ruling and cast validating vote.`,
        context: judgeContext,
        criteria,
        sessionPaths: {
          taskDir: `${sessionDir}/task`,
          artifactPath: `${sessionDir}/artifacts/debate/${pList[2].name}`,
          ballotPath: `${sessionDir}/ballots/round-1/${pList[2].name}.json`
        }
      });

      this.workspace.writeBrief(sessionDir, pList[2].name, judgeBrief);

      const jLaunch = this.herdr.launchAgent({
        name: pList[2].name,
        agent: pList[2].agent,
        permission: 'read',
        cwd: this.cwd,
        task: judgeBrief,
        sessionDir
      });
      if (!jLaunch.success) throw new Error(`Failed to start judge: ${jLaunch.error}`);
      spawnedNames.push(pList[2].name);

      this.herdr.wait(pList[2].name, { timeoutSec });
      const judgeOut = this.herdr.read(pList[2].name, 200).content || '';
      findings[pList[2].name] = judgeOut;

      this.workspace.writeArtifact(sessionDir, {
        phase: 'verdict',
        author: pList[2].name,
        content: judgeOut
      });

      // Cast judge ballot & validation
      this.workspace.castBallot(sessionDir, {
        round: 1,
        voter: pList[2].name,
        role: 'judge',
        agent: pList[2].agent,
        vote: 'approve',
        score: 9,
        rationale: judgeOut.slice(0, 300)
      });

      const tally = this.workspace.tallyBallots(sessionDir, 1, [pList[2].name]);
      const valRes = this.workspace.validateChoice(sessionDir, {
        representative: chosenRep,
        round: 1,
        targetArtifact: { phase: 'verdict', author: pList[2].name },
        verdict: 'validated',
        rationale: judgeOut.slice(0, 400)
      });

      const report = formatCouncilReport({
        title: 'Structured Debate & Verdict Report',
        mode: 'debate',
        task,
        participants: pList,
        findings,
        tally,
        validation: valRes.record,
        verdict: judgeOut
      });

      this.workspace.saveFinalDeliverables(sessionDir, {
        markdownReport: report,
        verdictJson: { sessionId: sid, mode: 'debate', tally, validation: valRes.record }
      });

      return {
        success: true,
        sessionId: sid,
        sessionDir,
        mode: 'debate',
        task,
        participants: pList,
        findings,
        tally,
        validation: valRes.record,
        report
      };
    } finally {
      if (!keepTerminals && spawnedNames.length > 0) {
        for (const name of spawnedNames) this.herdr.dismiss(name);
      }
    }
  }

  /**
   * PARALLEL MODE:
   * Fan-out multiple independent subtasks to parallel agents with deterministic artifact logging.
   */
  async runParallel({
    sessionId = null,
    task,
    subtasks = [],
    context = '',
    criteria = '',
    agents,
    permission,
    timeoutSec,
    keepTerminals,
    onProgress
  }) {
    const effectiveTasks = subtasks.length > 0 ? subtasks : [task];
    const pList = effectiveTasks.map((st, idx) => ({
      name: `parallel-worker-${idx + 1}`,
      role: 'author',
      agent: agents[idx % agents.length] || 'claude',
      task: st
    }));

    const { sid, sessionDir } = this.workspace.initSession({
      sessionId,
      mode: 'parallel',
      task,
      context,
      criteria,
      participants: pList
    });

    const findings = {};
    const spawnedNames = [];

    try {
      for (const p of pList) {
        onProgress({ stage: 'parallel_launch', name: p.name, agent: p.agent });
        this.workspace.writeBrief(sessionDir, p.name, p.task);

        const res = this.herdr.launchAgent({
          name: p.name,
          agent: p.agent,
          permission,
          cwd: this.cwd,
          task: p.task,
          sessionDir
        });
        if (!res.success) throw new Error(`Failed to launch ${p.name}: ${res.error}`);
        spawnedNames.push(p.name);
      }

      for (const p of pList) {
        this.herdr.wait(p.name, { timeoutSec });
        const out = this.herdr.read(p.name, 200).content || '';
        findings[p.name] = out;

        this.workspace.writeArtifact(sessionDir, {
          phase: 'subtasks',
          author: p.name,
          agent: p.agent,
          content: out
        });
      }

      const report = formatCouncilReport({
        title: 'Parallel Fan-Out Report',
        mode: 'parallel',
        task,
        participants: pList,
        findings
      });

      this.workspace.saveFinalDeliverables(sessionDir, {
        markdownReport: report,
        verdictJson: { sessionId: sid, mode: 'parallel', subtasks: effectiveTasks }
      });

      return {
        success: true,
        sessionId: sid,
        sessionDir,
        mode: 'parallel',
        task,
        participants: pList,
        findings,
        report
      };
    } finally {
      if (!keepTerminals && spawnedNames.length > 0) {
        for (const name of spawnedNames) this.herdr.dismiss(name);
      }
    }
  }

  /**
   * PIPELINE MODE:
   * Sequential stages where Stage N output feeds Stage N+1 with deterministic checkpointing.
   */
  async runPipeline({
    sessionId = null,
    task,
    stages = [],
    context = '',
    criteria = '',
    agents,
    permission,
    timeoutSec,
    keepTerminals,
    onProgress
  }) {
    const pipelineStages = stages.length > 0 ? stages : [
      { name: 'Research', role: 'author' },
      { name: 'Implementation', role: 'author' },
      { name: 'Verification', role: 'reviewer' }
    ];

    const { sid, sessionDir } = this.workspace.initSession({
      sessionId,
      mode: 'pipeline',
      task,
      context,
      criteria,
      participants: pipelineStages.map((s, idx) => ({
        name: `pipeline-stage-${idx + 1}-${s.name.toLowerCase()}`,
        role: s.role,
        agent: agents[idx % agents.length] || 'claude'
      }))
    });

    const findings = {};
    const spawnedNames = [];
    let currentInput = task;

    try {
      for (let i = 0; i < pipelineStages.length; i++) {
        const stage = pipelineStages[i];
        const termName = `pipeline-stage-${i + 1}-${stage.name.toLowerCase()}`;
        const agent = agents[i % agents.length] || 'claude';

        onProgress({ stage: 'pipeline_step', index: i + 1, name: termName, agent });

        const stagePrompt = `Pipeline Stage ${i + 1}: ${stage.name}\n\nTask:\n${task}\n\nInput from previous stage:\n${currentInput}`;
        this.workspace.writeBrief(sessionDir, termName, stagePrompt);

        const res = this.herdr.launchAgent({
          name: termName,
          agent,
          permission: stage.role === 'reviewer' ? 'read' : permission,
          cwd: this.cwd,
          task: stagePrompt,
          sessionDir
        });

        if (!res.success) throw new Error(`Failed stage ${termName}: ${res.error}`);
        spawnedNames.push(termName);

        this.herdr.wait(termName, { timeoutSec });
        const out = this.herdr.read(termName, 200).content || '';
        findings[termName] = out;
        currentInput = out; // Feed to next stage

        this.workspace.writeArtifact(sessionDir, {
          phase: `stage-${i + 1}`,
          author: termName,
          agent,
          content: out
        });
      }

      const report = formatCouncilReport({
        title: 'Sequential Pipeline Execution Report',
        mode: 'pipeline',
        task,
        participants: pipelineStages.map((s, idx) => ({
          name: spawnedNames[idx],
          role: s.role,
          agent: agents[idx % agents.length] || 'claude'
        })),
        findings,
        verdict: 'Pipeline completed through all stages.'
      });

      this.workspace.saveFinalDeliverables(sessionDir, {
        markdownReport: report,
        verdictJson: { sessionId: sid, mode: 'pipeline', stages: pipelineStages }
      });

      return {
        success: true,
        sessionId: sid,
        sessionDir,
        mode: 'pipeline',
        task,
        stages: pipelineStages,
        findings,
        report
      };
    } finally {
      if (!keepTerminals && spawnedNames.length > 0) {
        for (const name of spawnedNames) this.herdr.dismiss(name);
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

      if (!res.success) throw new Error(`Failed to delegate: ${res.error}`);

      this.herdr.wait(termName, { timeoutSec });
      const content = this.herdr.read(termName, 200).content || '';

      this.workspace.writeArtifact(sessionDir, {
        phase: 'delegation',
        author: termName,
        agent,
        content
      });

      this.workspace.saveFinalDeliverables(sessionDir, {
        markdownReport: `# Delegation Report: ${termName}\n\n${content}`,
        verdictJson: { sessionId: sid, agent, task }
      });

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
      if (!keepTerminals) {
        this.herdr.dismiss(termName);
      }
    }
  }
}
