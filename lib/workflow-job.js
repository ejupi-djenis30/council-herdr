import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CouncilOrchestrator, SUPPORTED_MODES } from './modes.js';
import { COLLABORATION_MODES, planCollaboration } from './collaboration.js';
import { normalizeAgentName, SUPPORTED_AGENTS } from './recipes.js';

export function workflowInputs(options, mode) {
  if (!SUPPORTED_MODES.includes(mode)) throw new Error(`Unsupported mode: ${mode}. Choose from: ${SUPPORTED_MODES.join(', ')}.`);
  if (mode === 'delegate') return null;
  if (options.adopt || options.team) throw new Error('Adopted terminals and named Team calls use delegate mode.');
  const { agents = ['claude', 'codex', 'antigravity'], subtasks = [], stages = [], round = 1 } = options;
  if (!Array.isArray(agents) || !agents.length || !agents.every(agent => typeof agent === 'string' && agent.trim() &&
      SUPPORTED_AGENTS.includes(normalizeAgentName(agent)))) throw new Error('Supply a nonempty list of supported Council agents.');
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('Round must be a positive integer.');
  if (COLLABORATION_MODES.includes(mode)) planCollaboration({ mode, agents, subtasks, stages, task: options.task });
  return { agents, subtasks, stages, round, context: options.context ?? '', criteria: options.criteria ?? '',
    representative: options.representative ?? null, previousSession: options.previousSession ?? null };
}

export async function runWorkflowJob({ job, herdr, workspace, sessionDir, deadlineMs, saveJob, run }) {
  const remaining = () => deadlineMs - Date.now();
  const expired = () => ({ success: false, isTimeout: true, isError: true, ended: true, error: 'Workflow deadline expired.' });
  const bounded = Object.create(herdr, {
    launchAgent: { value: options => remaining() > 0
      ? herdr.launchAgent({ ...options, alignmentTimeoutSec: Math.min(options.alignmentTimeoutSec ?? Infinity, remaining() / 1000) }) : expired() },
    wait: { value: (address, options = {}) => remaining() > 0
      ? herdr.wait(address, { ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? Infinity, remaining())),
        timeoutSec: Math.max(1, Math.min(options.timeoutSec ?? Infinity, Math.ceil(remaining() / 1000))) }) : expired() },
    captureTurn: { value: (address, turn, options) => remaining() > 0
      ? herdr.captureTurn(address, turn, { ...options, deadlineMs: Math.min(options.deadlineMs, deadlineMs) }) : expired() },
    read: { value: (address, lines, options = {}) => remaining() > 0
      ? herdr.read(address, lines, { ...options, timeout: Math.max(1, Math.min(options.timeout ?? Infinity, remaining())) }) : expired() }
  });
  const orchestrator = new CouncilOrchestrator({ cwd: workspace.root, workspace, herdr: bounded });
  job.state = 'deliberating';
  job.deliveryState = 'attempting';
  saveJob();

  let result;
  try {
    result = await (run ?? orchestrator.runMode.bind(orchestrator))({
      ...job.workflow, mode: job.mode, task: job.task, permission: job.permission, timeoutSec: job.timeoutSec,
      keepTerminals: job.keepTerminals, onProgress: event => {
        job.workflowProgress = { stage: event.stage, name: event.name ?? null };
        saveJob();
      }
    });
  } catch (error) {
    result = { success: false, error: error.message };
  }

  const success = result.success === true;
  const output = result.report || result.output || result.error || 'The workflow did not save a report.';
  const artifactPath = join(sessionDir, 'workflow-report.md');
  writeFileSync(artifactPath, output, 'utf8');
  job.state = success ? 'completed' : 'failed';
  if (success) job.deliveryState = 'acknowledged';
  if (!success && remaining() <= 0) job.failureKind = 'timed_out';
  job.error = success ? null : job.failureKind === 'timed_out' ? 'Workflow deadline expired.' : (result.error || `Workflow ended with ${result.status || 'an incomplete result'}.`);
  job.result = {
    success, ready: true, output, artifactPath, workflowSessionId: result.sessionId ?? job.workflow.sessionId,
    workflowStatus: result.status ?? null, authorized: result.authorized ?? false, execution: result.execution ?? null,
    completedAt: new Date().toISOString()
  };
  saveJob();
  return job.result;
}
