import { randomUUID } from 'node:crypto';
import { formatCouncilReport } from './formatters.js';
import { normalizeAgentName, SUPPORTED_AGENTS } from './recipes.js';

export const COLLABORATION_MODES = ['debate', 'parallel', 'pipeline'];

const titles = {
  debate: 'Structured Debate Report',
  parallel: 'Parallel Fan-Out Report',
  pipeline: 'Sequential Pipeline Report'
};
const isText = value => typeof value === 'string' && value.trim().length > 0;
const isAgent = value => isText(value) && SUPPORTED_AGENTS.includes(normalizeAgentName(value));

export function planCollaboration({ mode, agents, task, subtasks, stages }) {
  if (!Array.isArray(agents) || !agents.length || !agents.every(isAgent)) {
    throw new Error('Supply a nonempty list of supported Council agents.');
  }
  if (mode === 'debate') {
    if (agents.length !== 3) throw new Error('Debate needs three agents ordered as side A, side B, and judge.');
    return [
      { name: 'debate-side-a', role: 'author', agent: agents[0], phase: 'arguments',
        instruction: 'Make the strongest affirmative case. Identify evidence, assumptions, and a serious objection.' },
      { name: 'debate-side-b', role: 'skeptic', agent: agents[1], phase: 'arguments',
        instruction: 'Make the strongest opposing case or alternative. Identify evidence, assumptions, and a serious objection.' },
      { name: 'debate-judge', role: 'judge', agent: agents[2], phase: 'verdict',
        instruction: 'Read the two saved arguments. Compare their evidence and trade-offs, then give an advisory recommendation and state any unresolved questions.' }
    ];
  }
  if (mode === 'parallel') {
    if (!Array.isArray(subtasks) || !subtasks.every(isText)) throw new Error('Subtasks must be an array of nonempty strings.');
    const assignments = subtasks.length ? subtasks : agents.map(() => task);
    return assignments.map((instruction, index) => ({
      name: `parallel-worker-${index + 1}`, role: 'author', phase: 'subtasks',
      agent: agents[index % agents.length], instruction
    }));
  }
  if (!Array.isArray(stages)) throw new Error('Stages must be an array of objects.');
  const assignments = stages.length ? stages : [
    { name: 'Research', task: 'Gather relevant evidence and clarify the constraints.' },
    { name: 'Implementation plan', task: 'Use the research to propose a concrete solution and acceptance criteria.' },
    { name: 'Verification', role: 'reviewer', task: 'Verify the proposal against the original task and flag remaining risks.' }
  ];
  return assignments.map((stage, index) => {
    if (!isText(stage?.name) || (stage.task !== undefined && !isText(stage.task)) ||
        (stage.role !== undefined && !['author', 'reviewer'].includes(stage.role)) ||
        (stage.agent !== undefined && !isAgent(stage.agent))) {
      throw new Error(`Stage ${index + 1} requires a name. Its optional fields are task text, a supported agent, and role author or reviewer.`);
    }
    return {
      name: `pipeline-stage-${index + 1}`, title: stage.name.trim(), phase: `stage-${index + 1}`,
      role: stage.role ?? 'author', agent: stage.agent ?? agents[index % agents.length],
      instruction: stage.task ?? 'Advance the original task using the preceding stage output when provided.'
    };
  });
}

export async function runCollaboration(orchestrator, options) {
  const { herdr, workspace, cwd } = orchestrator;
  const { mode, task, context, criteria, permission, timeoutSec, keepTerminals, onProgress } = options;
  if (!isText(task) || !['read', 'write'].includes(permission) || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new Error('Provide a task, read or write permission, and a positive timeout.');
  }
  const participants = planCollaboration(options);
  const id = options.sessionId ?? `${mode}-${randomUUID()}`;
  const { sid, sessionDir } = workspace.initSession({ sessionId: id, mode, task, context, criteria, participants });
  onProgress({ stage: 'workspace_initialized', sessionDir });

  const findings = {};
  const turns = {};
  const artifacts = [];
  const runId = randomUUID().slice(0, 8);

  function launch(participant, index, inputs) {
    const { name, title = name, role, agent, instruction } = participant;
    const brief = [
      `# ${title}`, `Original task: ${task}`, instruction,
      context && `Context:\n${context}`, criteria && `Criteria:\n${criteria}`,
      ...inputs.map(input => `Read the ${input.name} capture at ${input.path}\nSHA-256: ${input.sha256}`),
      'Work within this assignment without launching other agents. Return your complete response in the terminal.'
    ].filter(Boolean).join('\n\n');
    const turn = { status: 'incomplete', address: null };
    turns[name] = turn;
    try {
      for (const input of inputs) {
        const saved = workspace.readArtifact(sessionDir, input.phase, input.name);
        if (!saved?.verified || saved.sha256 !== input.sha256) throw new Error(`The saved capture for ${input.name} changed before handoff.`);
      }
      workspace.writeBrief(sessionDir, name, brief);
      onProgress({ stage: 'launch', name, agent });
      const launched = herdr.launchAgent({
        name: `c-${runId}-${index + 1}`, agent, cwd, task: brief, sessionDir, alignmentTimeoutSec: timeoutSec,
        permission: ['judge', 'reviewer'].includes(role) ? 'read' : permission
      });
      turn.address = launched?.address ?? null;
      if (launched?.success !== true || !turn.address || launched.details?.first_message?.sent !== true ||
          !Number.isSafeInteger(launched.baselineTurn)) {
        turn.error = launched?.error || 'Could not verify task delivery.';
      } else {
        turn.baseline = launched.baselineTurn;
        turn.identity = launched.terminalIdentity;
      }
    } catch (error) {
      turn.error = error.message;
    }
  }

  async function collect(participant) {
    const { name, phase, agent } = participant;
    const turn = turns[name];
    if (turn.error) return false;
    const deadline = Date.now() + timeoutSec * 1000;
    try {
      const wait = await orchestrator.waitForParticipant(turn.address, { timeoutSec, deadline, afterTurn: turn.baseline,
        name, identity: turn.identity, onProgress });
      if (wait?.success !== true || wait.terminal !== turn.address || wait.ended !== true || wait.reason !== 'status' ||
          wait.status !== 'done') {
        turn.error = wait?.error || 'Could not verify the expected Council turn.';
        return false;
      }
      const read = await herdr.captureTurn(turn.address, wait.turn, { deadlineMs: deadline, lines: 300, identity: turn.identity });
      if (Date.now() >= deadline || read?.success !== true || !isText(read.content)) {
        turn.error = read?.error || 'Could not save a verified terminal capture before the deadline.';
        return false;
      }
      const artifact = workspace.writeArtifact(sessionDir, { phase, author: name, agent, content: read.content,
        metadata: { source: 'terminal', captureScope: read.captureScope ?? null, turn: wait.turn } });
      artifacts.push({ name, phase, path: artifact.artifactPath, sha256: artifact.sha256 });
      findings[name] = read.content;
      turn.status = 'completed';
      turn.completedTurn = wait.turn;
      return true;
    } catch (error) {
      turn.error = error.message;
      return false;
    }
  }

  try {
    if (mode === 'pipeline') {
      for (const [index, participant] of participants.entries()) {
        launch(participant, index, artifacts.slice(-1));
        if (!await collect(participant)) break;
      }
    } else {
      const independent = mode === 'debate' ? participants.slice(0, 2) : participants;
      independent.forEach((participant, index) => launch(participant, index, []));
      for (const participant of independent) await collect(participant);
      if (mode === 'debate' && artifacts.length === 2) {
        launch(participants[2], 2, artifacts);
        await collect(participants[2]);
      }
    }

    const success = artifacts.length === participants.length;
    const status = success ? 'completed' : 'incomplete';
    const summary = participants.map(({ name }) => {
      const turn = turns[name];
      if (!turn) return `- ${name} did not start because its required input was unavailable.`;
      const address = turn.address ? ` (${turn.address})` : '';
      return `- ${name}${address} ${turn.error ?? turn.status}`;
    }).join('\n');
    const reportedParticipants = participants.map(participant => ({
      ...participant, status: turns[participant.name]?.status ?? 'not started'
    }));
    const report = formatCouncilReport({ title: titles[mode], mode, task, participants: reportedParticipants, findings }) +
      `\n\n## Execution\n\nSession \`${sid}\`\n\n${summary}\n\nThis report records advisory evidence.\n` +
      (success ? '' : '\nInspect the incomplete turns in Herdr and review the saved captures.\n');
    const execution = Object.fromEntries(Object.entries(turns).map(([name, { status, address, error }]) => [name, { status, address, error }]));
    const saved = workspace.saveFinalDeliverables(sessionDir, {
      markdownReport: report, verdictJson: { sessionId: sid, mode, status, authorized: false,
        completedAt: new Date().toISOString(), execution, artifacts }, validationPassed: false
    });
    return { success, status, authorized: false, sessionId: sid, sessionDir, mode, task, participants: reportedParticipants,
      findings, execution, report, reportPath: saved.reportPath };
  } finally {
    if (!keepTerminals) {
      for (const turn of Object.values(turns)) {
        if (turn.status === 'completed') {
          try { herdr.dismiss(turn.address, { identity: turn.identity, turn: turn.completedTurn }); } catch {}
        }
      }
    }
  }
}
