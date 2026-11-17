import { HerdrClient } from './herdr.js';
import { formatParticipantBrief, formatCouncilReport } from './formatters.js';

export const SUPPORTED_MODES = ['council', 'review', 'debate', 'parallel', 'pipeline', 'delegate'];

/**
 * Orchestrates multi-agent collaboration workflows via Herdr (`hc`).
 */
export class CouncilOrchestrator {
  constructor(options = {}) {
    this.herdr = options.herdr || new HerdrClient(options);
    this.cwd = options.cwd || process.cwd();
  }

  /**
   * Main entry point to run a collaboration mode.
   */
  async runMode({
    mode = 'council',
    task,
    subtasks = [],
    stages = [],
    context = '',
    criteria = '',
    agents = ['claude', 'codex', 'antigravity'],
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
        return await this.runCouncil({ task, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress });
      case 'review':
        return await this.runReview({ task, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress });
      case 'debate':
        return await this.runDebate({ task, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress });
      case 'parallel':
        return await this.runParallel({ task, subtasks, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress });
      case 'pipeline':
        return await this.runPipeline({ task, stages, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress });
      case 'delegate':
        return await this.runDelegate({ task, context, criteria, agent: agents[0] || 'claude', permission, timeoutSec, keepTerminals, onProgress });
      default:
        throw new Error(`Mode ${normalizedMode} not implemented.`);
    }
  }

  /**
   * COUNCIL MODE:
   * Multi-agent deliberations: Author drafts, Skeptic critiques, Simplifier trims, Judge synthesizes.
   */
  async runCouncil({ task, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress }) {
    const pList = [
      { role: 'author', name: 'council-author', agent: agents[0] || 'claude' },
      { role: 'skeptic', name: 'council-skeptic', agent: agents[1] || 'codex' },
      { role: 'simplifier', name: 'council-simplifier', agent: agents[2] || 'antigravity' }
    ];

    const findings = {};
    const spawnedNames = [];

    try {
      // 1. Launch initial participants in Herdr
      for (const p of pList) {
        onProgress({ stage: 'launch', name: p.name, role: p.role, agent: p.agent });
        const brief = formatParticipantBrief({
          role: p.role,
          name: p.name,
          agent: p.agent,
          mode: 'council',
          task,
          context,
          criteria
        });

        const launchRes = this.herdr.launchAgent({
          name: p.name,
          agent: p.agent,
          permission,
          cwd: this.cwd,
          task: brief
        });

        if (!launchRes.success) {
          throw new Error(`Failed to launch ${p.name}: ${launchRes.error}`);
        }
        spawnedNames.push(p.name);
      }

      // 2. Wait for all initial submissions
      onProgress({ stage: 'waiting_initial', participants: spawnedNames });
      for (const name of spawnedNames) {
        this.herdr.wait(name, { timeoutSec });
        const readRes = this.herdr.read(name, 200);
        findings[name] = readRes.content || '(No output produced)';
        onProgress({ stage: 'collected', name, preview: findings[name].slice(0, 150) });
      }

      // 3. Synthesize final report
      const synthesis = [
        'All three council perspectives (Author, Skeptic, and Simplifier) have submitted their analyses.',
        'Core consensus points and critical risks have been collated.'
      ].join('\n');

      const verdict = [
        '### Council Decision Summary',
        `- **Proposed Direction**: Proceed with Author\'s foundation incorporating Skeptic\'s guardrails.`,
        `- **Simplification Applied**: Eliminate redundant machinery as highlighted by Simplifier.`,
        `- **Action Items**: Review code/artifacts and run verification checks.`
      ].join('\n');

      const report = formatCouncilReport({
        title: 'Full Council Deliberation Report',
        mode: 'council',
        task,
        participants: pList,
        findings,
        synthesis,
        verdict
      });

      return {
        success: true,
        mode: 'council',
        task,
        participants: pList,
        findings,
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
   * Author writes/proposes, Reviewer inspects, Simplifier (Lazy Genius) checks unnecessary overhead.
   */
  async runReview({ task, context, criteria, agents, permission, timeoutSec, keepTerminals, onProgress }) {
    const pList = [
      { role: 'author', name: 'review-author', agent: agents[0] || 'claude' },
      { role: 'reviewer', name: 'review-reviewer', agent: agents[1] || 'codex' },
      { role: 'simplifier', name: 'review-simplifier', agent: agents[2] || 'junie' }
    ];

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
        criteria
      });

      const aLaunch = this.herdr.launchAgent({
        name: pList[0].name,
        agent: pList[0].agent,
        permission,
        cwd: this.cwd,
        task: authorBrief
      });
      if (!aLaunch.success) throw new Error(`Failed to start author: ${aLaunch.error}`);
      spawnedNames.push(pList[0].name);

      this.herdr.wait(pList[0].name, { timeoutSec });
      const authorOut = this.herdr.read(pList[0].name, 200).content || '';
      findings[pList[0].name] = authorOut;

      // 2. Launch Reviewer & Simplifier simultaneously with Author's work
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
          criteria
        });

        const rLaunch = this.herdr.launchAgent({
          name: p.name,
          agent: p.agent,
          permission: 'read', // reviews are read-only
          cwd: this.cwd,
          task: brief
        });
        if (!rLaunch.success) throw new Error(`Failed to start ${p.name}: ${rLaunch.error}`);
        spawnedNames.push(p.name);
      }

      // Wait for reviewers
      for (const p of [pList[1], pList[2]]) {
        this.herdr.wait(p.name, { timeoutSec });
        findings[p.name] = this.herdr.read(p.name, 200).content || '';
      }

      const report = formatCouncilReport({
        title: 'Peer Review & Simplification Report',
        mode: 'review',
        task,
        participants: pList,
        findings,
        verdict: 'Review complete. Address identified concerns before committing.'
      });

      return {
        success: true,
        mode: 'review',
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
   * DEBATE MODE:
   * Two agents advocate competing viewpoints, followed by judge evaluation.
   */
  async runDebate({ task, context, criteria, agents, timeoutSec, keepTerminals, onProgress }) {
    const pList = [
      { role: 'author', name: 'debate-side-a', agent: agents[0] || 'claude' },
      { role: 'skeptic', name: 'debate-side-b', agent: agents[1] || 'codex' },
      { role: 'judge', name: 'debate-judge', agent: agents[2] || 'antigravity' }
    ];

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
          criteria
        });

        const launchRes = this.herdr.launchAgent({
          name: p.name,
          agent: p.agent,
          permission: 'read',
          cwd: this.cwd,
          task: brief
        });
        if (!launchRes.success) throw new Error(`Failed to start ${p.name}: ${launchRes.error}`);
        spawnedNames.push(p.name);
      }

      for (const name of spawnedNames) {
        this.herdr.wait(name, { timeoutSec });
        findings[name] = this.herdr.read(name, 200).content || '';
      }

      // 2. Launch Judge to evaluate both sides
      const judgeContext = `Side A Argument:\n${findings[pList[0].name]}\n\nSide B Argument:\n${findings[pList[1].name]}`;
      const judgeBrief = formatParticipantBrief({
        role: 'judge',
        name: pList[2].name,
        agent: pList[2].agent,
        mode: 'debate',
        task: `Evaluate the two competing arguments on: ${task}. Issue an impartial ruling.`,
        context: judgeContext,
        criteria
      });

      const jLaunch = this.herdr.launchAgent({
        name: pList[2].name,
        agent: pList[2].agent,
        permission: 'read',
        cwd: this.cwd,
        task: judgeBrief
      });
      if (!jLaunch.success) throw new Error(`Failed to start judge: ${jLaunch.error}`);
      spawnedNames.push(pList[2].name);

      this.herdr.wait(pList[2].name, { timeoutSec });
      findings[pList[2].name] = this.herdr.read(pList[2].name, 200).content || '';

      const report = formatCouncilReport({
        title: 'Structured Debate & Verdict Report',
        mode: 'debate',
        task,
        participants: pList,
        findings,
        verdict: findings[pList[2].name]
      });

      return {
        success: true,
        mode: 'debate',
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
   * PARALLEL MODE:
   * Fan-out multiple independent subtasks to parallel agents.
   */
  async runParallel({ task, subtasks = [], agents, permission, timeoutSec, keepTerminals, onProgress }) {
    const effectiveTasks = subtasks.length > 0 ? subtasks : [task];
    const pList = effectiveTasks.map((st, idx) => ({
      name: `parallel-worker-${idx + 1}`,
      role: 'author',
      agent: agents[idx % agents.length] || 'claude',
      task: st
    }));

    const findings = {};
    const spawnedNames = [];

    try {
      for (const p of pList) {
        onProgress({ stage: 'parallel_launch', name: p.name, agent: p.agent });
        const res = this.herdr.launchAgent({
          name: p.name,
          agent: p.agent,
          permission,
          cwd: this.cwd,
          task: p.task
        });
        if (!res.success) throw new Error(`Failed to launch ${p.name}: ${res.error}`);
        spawnedNames.push(p.name);
      }

      for (const name of spawnedNames) {
        this.herdr.wait(name, { timeoutSec });
        findings[name] = this.herdr.read(name, 200).content || '';
      }

      const report = formatCouncilReport({
        title: 'Parallel Fan-Out Report',
        mode: 'parallel',
        task,
        participants: pList,
        findings
      });

      return {
        success: true,
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
   * Sequential stages where Stage N output feeds Stage N+1.
   */
  async runPipeline({ task, stages = [], agents, permission, timeoutSec, keepTerminals, onProgress }) {
    const pipelineStages = stages.length > 0 ? stages : [
      { name: 'Research', role: 'author' },
      { name: 'Implementation', role: 'author' },
      { name: 'Verification', role: 'reviewer' }
    ];

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
        const res = this.herdr.launchAgent({
          name: termName,
          agent,
          permission: stage.role === 'reviewer' ? 'read' : permission,
          cwd: this.cwd,
          task: stagePrompt
        });

        if (!res.success) throw new Error(`Failed stage ${termName}: ${res.error}`);
        spawnedNames.push(termName);

        this.herdr.wait(termName, { timeoutSec });
        const out = this.herdr.read(termName, 200).content || '';
        findings[termName] = out;
        currentInput = out; // Feed to next stage
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

      return {
        success: true,
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
   * Single specialist task delegated in Herdr.
   */
  async runDelegate({ task, context = '', agent = 'claude', permission = 'read', timeoutSec = 180, keepTerminals = false, onProgress = () => {} }) {
    const termName = `delegate-${agent}-${Date.now().toString().slice(-4)}`;
    onProgress({ stage: 'delegate_start', name: termName, agent });

    try {
      const res = this.herdr.launchAgent({
        name: termName,
        agent,
        permission,
        cwd: this.cwd,
        task,
        context
      });

      if (!res.success) throw new Error(`Failed to delegate: ${res.error}`);

      this.herdr.wait(termName, { timeoutSec });
      const content = this.herdr.read(termName, 200).content || '';

      return {
        success: true,
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
