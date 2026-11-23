import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { alignmentError, alignmentOf } from '../herdr/mods/council/runtime/alignment.mjs';
import { recordJobSnapshot } from '../herdr/mods/council/runtime/activity-log.mjs';
import { HerdrClient } from './herdr.js';
import { AgentWorkspace, atomicWrite, sanitizeName } from './workspace.js';
import { computeFingerprint, isJobRecord, jobExpired, jobInterruption, jobRecordProblem, jobRecovery, readDispatchError } from '../herdr/mods/council/runtime/job-record.mjs';
import { observeWorker, sameActiveWorker, workerLabel } from '../herdr/mods/council/runtime/worker-observation.mjs';
import { workflowInputs } from './workflow-job.js';
import { readFormalDecision } from './formal-rounds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function describeParticipant(participant) {
  if (participant?.ownership !== 'borrowed') return participant;
  return { ...participant, agent: participant.reportedApp ?? null, permission: null };
}

function sessionIdProblem(sessionId) {
  const id = String(sessionId);
  if (!id.trim() || id.includes('..') || /[\\/:<>"|?*]/.test(id)) {
    return `Invalid or unsafe session ID: "${id}" contains path traversal or invalid characters`;
  }
  return null;
}

function alignmentNextAction(address, requestStatus) {
  switch (requestStatus) {
    case 'sent':
      return `After the readiness turn finishes, run council alignment status ${address}. Retry start once it reports aligned.`;
    case 'already_aligned':
      return 'The terminal registered during preflight. Retry start with the same options.';
    case 'deferred_busy':
      return `Once the terminal is idle or done, run council alignment check ${address}.`;
    case 'uncertain':
      return `Inspect the existing terminal with hc read ${address} before requesting another check.`;
    case 'unavailable':
      return `Verify that hc get ${address} shows a live agent before retrying.`;
    default:
      return `After the host loads its Council skill and MCP tools, run council alignment check ${address}.`;
  }
}

export { computeFingerprint };

/**
 * Check if a terminal address is currently claimed by another active Council job
 */
export function isAddressClaimedByOtherSession(baseDir, adoptAddress, currentSessionId) {
  if (!baseDir || !existsSync(baseDir) || !adoptAddress) return { claimed: false };

  // 1. Check atomic lock file in .locks/
  const locksDir = join(baseDir, '.locks');
  if (existsSync(locksDir)) {
    const safeName = sanitizeName(adoptAddress);
    const lockPath = join(locksDir, `borrow-${safeName}.lock`);
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (lock.sessionId && lock.sessionId !== currentSessionId) {
          return {
            claimed: true,
            sessionId: lock.sessionId,
            state: 'locked'
          };
        }
      } catch {}
    }
  }

  // 2. Check active job.json records
  try {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === currentSessionId || entry.name.startsWith('.')) continue;
      const jobPath = join(baseDir, entry.name, 'job.json');
      if (!existsSync(jobPath)) continue;
      try {
        const otherJob = JSON.parse(readFileSync(jobPath, 'utf8'));
        const otherAddr = otherJob.participant?.canonicalAddress || otherJob.participant?.address;
        if (otherAddr === adoptAddress) {
          // Completed jobs and failed jobs WITHOUT uncertain delivery release their claim
          if (otherJob.state === 'completed' || (otherJob.state === 'failed' && otherJob.deliveryState !== 'uncertain')) {
            continue;
          }
          // Uncertain jobs hold claim until deadline expires for manual inspection
          const isExpired = otherJob.deadlineAt && Date.now() > new Date(otherJob.deadlineAt).getTime();
          if (!isExpired) {
            return {
              claimed: true,
              sessionId: otherJob.sessionId,
              state: otherJob.deliveryState === 'uncertain' ? 'uncertain' : otherJob.state
            };
          }
        }
      } catch {}
    }
  } catch {}
  return { claimed: false };
}

/**
 * Validate an adopted terminal address before delivery or launch
 */
export function validateAdoptedTerminal({ adopt, callerTerminal = null, herdr = null, baseDir = null, currentSessionId = null }) {
  if (!adopt || typeof adopt !== 'string') {
    return { valid: false, error: 'Adopt address must be a non-empty string' };
  }

  const cleanAdopt = adopt.trim();
  if (callerTerminal && cleanAdopt === callerTerminal) {
    return { valid: false, error: `Cannot adopt caller terminal (${callerTerminal})` };
  }

  if (herdr?.terminalId && cleanAdopt === herdr.terminalId) {
    return { valid: false, error: `Cannot adopt caller terminal (${herdr.terminalId})` };
  }

  // Check against concurrent Council job claims
  if (baseDir) {
    const claimCheck = isAddressClaimedByOtherSession(baseDir, cleanAdopt, currentSessionId);
    if (claimCheck.claimed) {
      return {
        valid: false,
        error: `Adopted terminal "${cleanAdopt}" is already in use by active Council session "${claimCheck.sessionId}"`
      };
    }
  }

  if (!herdr || typeof herdr.get !== 'function') {
    return { valid: true, canonicalAddress: cleanAdopt, details: null };
  }

  const probe = herdr.get(cleanAdopt);
  if (!probe || !probe.success || !probe.details) {
    return { valid: false, error: probe?.error || `Adopted terminal ${cleanAdopt} not found in Herdr` };
  }

  const details = probe.details;
  const canonicalAddress = details.address || cleanAdopt;

  // Check canonical address against caller
  if (callerTerminal && canonicalAddress === callerTerminal) {
    return { valid: false, error: `Cannot adopt caller terminal (${callerTerminal})` };
  }
  if (herdr?.terminalId && canonicalAddress === herdr.terminalId) {
    return { valid: false, error: `Cannot adopt caller terminal (${herdr.terminalId})` };
  }

  if (details.state !== 'live') {
    return { valid: false, error: `Adopted terminal ${cleanAdopt} is not live (${details.state})` };
  }

  if (details.reported === false) {
    return { valid: false, error: `Adopted terminal ${cleanAdopt} has not reported readiness` };
  }

  const statusState = typeof details.status === 'object' && details.status !== null
    ? details.status.state
    : details.status;

  if (statusState === 'working') {
    return { valid: false, error: `Adopted terminal ${cleanAdopt} is busy working` };
  }
  if (statusState === 'blocked') {
    return { valid: false, error: `Adopted terminal ${cleanAdopt} is blocked waiting for input` };
  }
  if (statusState === 'error') {
    return { valid: false, error: `Adopted terminal ${cleanAdopt} is in error state` };
  }

  const alignment = alignmentOf(details);
  if (alignment !== 'aligned') return { valid: false, canonicalAddress, alignment, error: alignmentError(canonicalAddress, alignment) };

  return { valid: true, canonicalAddress, details };
}

/**
 * Service managing asynchronous Council delegation jobs
 */
export class JobManager {
  constructor(options = {}) {
    this.cwd = resolve(options.cwd || process.cwd());
    this.herdr = options.herdr || new HerdrClient({ cwd: this.cwd });
    this.workspace = options.workspace || new AgentWorkspace(this.cwd);
    this.workerLauncher = options.workerLauncher || this.defaultWorkerLauncher.bind(this);
  }

  /**
   * Default launcher: spawn background Node worker via Herdr
   */
  defaultWorkerLauncher({ sessionDir, sessionId, job }) {
    const workerScript = resolve(__dirname, 'job-worker.js');
    const team = job?.participant?.team;
    const hash = createHash('sha256').update(JSON.stringify([this.cwd, sessionId])).digest('hex').slice(0, 8);
    const name = `c-job-${hash}`;
    const res = this.herdr.exec([
      'run',
      '--bg',
      '--outlive-parent',
      ...(team ? ['--no-parent', '--no-notify', '--rm'] : []),
      '--json',
      '--name',
      name,
      '--label',
      `${workerLabel}=${job.worker.label}`,
      '--cwd',
      this.cwd,
      '--',
      process.execPath,
      workerScript,
      sessionDir
    ]);

    if (!res.success) {
      return {
        success: false,
        error: res.stderr || res.stdout || 'Failed to launch background worker via Herdr'
      };
    }

    const data = this.herdr.parseJson(res.stdout);
    return {
      success: true,
      address: data?.address || null,
      details: data
    };
  }

  /**
   * Helper to load and validate a job record with dispatch-error sidecar integration
   */
  readJobRecord(sessionId) {
    if (!sessionId) {
      return { success: false, notFound: false, error: 'Session ID is required' };
    }
    const invalid = sessionIdProblem(sessionId);
    if (invalid) return { success: false, error: invalid };
    const cleanId = this.workspace.sanitizeName(sessionId);
    const sessionDir = join(this.workspace.baseDir, cleanId);
    const jobPath = join(sessionDir, 'job.json');

    if (!existsSync(jobPath)) {
      return { success: false, notFound: true, error: `Job "${cleanId}" not found`, sessionId: cleanId, sessionDir };
    }

    let job;
    try {
      job = JSON.parse(readFileSync(jobPath, 'utf8'));
    } catch (err) {
      return { success: false, corrupt: true, error: `Job record is corrupt: ${err.message}`, sessionId: cleanId, sessionDir };
    }

    if (!isJobRecord(job) || job.sessionId !== cleanId) {
      return { success: false, corrupt: true, error: 'Job record has invalid schema', sessionId: cleanId, sessionDir };
    }
    job.participant = describeParticipant(job.participant);

    const problem = jobRecordProblem(job, readDispatchError(sessionDir)?.error);
    if (problem) {
      return { success: false, ...problem, sessionId: cleanId, sessionDir, jobPath, job, state: 'failed' };
    }

    return {
      success: true,
      sessionId: cleanId,
      sessionDir,
      jobPath,
      job
    };
  }

  /**
   * Start an asynchronous single-task delegation job
   */
  async startJob(options = {}) {
    const mode = options.mode || 'delegate';
    if (!options.task || !String(options.task).trim()) {
      return { success: false, error: 'Task description is required' };
    }
    let workflow;
    try { workflow = workflowInputs(options, mode); }
    catch (error) { return { success: false, error: error.message }; }

    // Validate permission
    if (options.permission !== undefined && options.permission !== null) {
      const perm = String(options.permission).toLowerCase().trim();
      if (perm !== 'read' && perm !== 'write') {
        return {
          success: false,
          error: `Invalid permission "${options.permission}": only "read" and "write" are supported`
        };
      }
    }

    // Validate timeoutSec
    if (options.timeoutSec !== undefined && options.timeoutSec !== null) {
      const t = Number(options.timeoutSec);
      if (!Number.isFinite(t) || t <= 0) {
        return {
          success: false,
          error: `Invalid timeoutSec "${options.timeoutSec}": must be a positive finite number`
        };
      }
    }

    // Validate session ID safety
    const invalid = options.sessionId == null ? null : sessionIdProblem(options.sessionId);
    if (invalid) return { success: false, error: invalid };

    const sessionId = options.sessionId
      ? this.workspace.sanitizeName(options.sessionId)
      : `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const sessionDir = resolve(this.workspace.baseDir, sessionId);
    const resolvedBase = resolve(this.workspace.baseDir);
    if (!sessionDir.startsWith(resolvedBase + sep)) {
      return {
        success: false,
        error: `Session directory escapes workspace base directory: ${sessionId}`
      };
    }

    // Prevent clobbering or replacing legacy sessions (e.g. session.json from convene)
    if (existsSync(sessionDir)) {
      const legacyPath = join(sessionDir, 'session.json');
      if (existsSync(legacyPath)) {
        return {
          success: false,
          error: `Cannot replace or reinitialize existing legacy session in "${sessionId}"`
        };
      }
    }

    const jobPath = join(sessionDir, 'job.json');
    const fingerprint = computeFingerprint(options, workflow);

    // 1. FIRST: Check if session record already exists before querying Herdr readiness
    // This ensures identical restarts during a working terminal are accepted without false rejection
    if (existsSync(jobPath)) {
      const record = this.readJobRecord(sessionId);
      if (!record.success) {
        return {
          success: false,
          error: record.error,
          sessionId,
          state: record.state || 'failed',
          ...(record.dispatchFailed ? { nextAction: jobRecovery('dispatch_failed') } : {})
        };
      }

      const existingJob = record.job;

      // Check for conflicting inputs on same session ID
      if (existingJob.fingerprint !== fingerprint) {
        return {
          success: false,
          error: `Session "${sessionId}" already exists with conflicting parameters (fingerprint mismatch)`
        };
      }

      // A failed execution stays recorded under its original ID.
      if (existingJob.state === 'failed') {
        const outcome = jobInterruption(existingJob, jobExpired(existingJob)) ?? existingJob.state;
        const recovery = jobRecovery(outcome, existingJob.deliveryState);
        return {
          success: false,
          error: existingJob.error || 'The previous job failed',
          sessionId,
          state: existingJob.state,
          outcome,
          nextAction: outcome === 'failed' ? recovery : `${recovery} Use a new session ID for another job.`
        };
      }

      // Idempotent reconnect on identical fingerprint: return existing job without touching Herdr or worker
      return {
        success: true,
        reconnect: true,
        sessionId,
        state: existingJob.state,
        participant: existingJob.participant,
        deadlineAt: existingJob.deadlineAt,
        nextAction: `Check status with: council status --session ${sessionId}`
      };
    }

    // 2. NEW SESSION: Validate adopted terminal before creating job or launching worker
    const callerTerminal = options.callerTerminal || this.herdr?.terminalId || null;
    const isAdopted = Boolean(options.adopt);
    const adoptAddress = options.adopt ? String(options.adopt).trim() : null;
    let canonicalAddress = adoptAddress;
    let reportedApp;
    let borrowedIdentity;

    if (isAdopted) {
      const val = validateAdoptedTerminal({
        adopt: adoptAddress,
        callerTerminal,
        herdr: this.herdr,
        baseDir: this.workspace.baseDir,
        currentSessionId: sessionId
      });
      if (!val.valid) {
        if (!val.alignment) return { success: false, error: val.error };
        const check = val.alignment === 'unconfirmed' ? this.herdr.requestAlignment?.(val.canonicalAddress) : null;
        const request = check?.request;
        return {
          success: false,
          error: request ? `Terminal ${val.canonicalAddress} needed a readiness check before delegation could start.` : val.error,
          alignment: check?.state ?? val.alignment,
          address: val.canonicalAddress,
          ...(request ? { alignmentRequest: request } : {}),
          nextAction: val.alignment === 'needs_reload' ? val.error : alignmentNextAction(val.canonicalAddress, request?.status)
        };
      }
      canonicalAddress = val.canonicalAddress || adoptAddress;
      const app = val.details?.status?.app;
      if (typeof app === 'string' && app.trim()) reportedApp = app.trim();
      if (Number.isSafeInteger(val.details?.pid) && Number.isSafeInteger(val.details?.created_ms)) {
        borrowedIdentity = { pid: val.details.pid, createdMs: val.details.created_ms };
      }
    }

    // Prepare new job record
    const timeoutSec = Number(options.timeoutSec || 180);
    const now = Date.now();
    const deadlineAt = new Date(now + timeoutSec * 1000).toISOString();

    const job = {
      $schema: 'council.job/v1',
      sessionId,
      mode,
      task: String(options.task).trim(),
      ...(workflow ? { workflow: { ...workflow, sessionId: `workflow-${randomUUID()}` } } : {}),
      agent: options.agent || 'codex',
      fingerprint,
      callerTerminal,
      permission: options.permission || 'read',
      timeoutSec,
      keepTerminals: Boolean(options.keepTerminals || options.keep),
      deadlineAt,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      state: 'starting',
      deliveryState: 'planned',
      baselineTurn: null,
      participant: workflow ? null : describeParticipant({
        ownership: isAdopted ? 'borrowed' : 'owned',
        address: adoptAddress,
        canonicalAddress,
        ...(borrowedIdentity ? { identity: borrowedIdentity } : {}),
        ...(reportedApp ? { reportedApp } : {}),
        agent: options.agent || 'codex',
        permission: options.permission || 'read',
        ...(options.team ? { team: options.team, name: options.teamName, power: 'starting' } : {})
      }),
      ...(options.team ? { teamSource: options.teamSource, teamReports: options.teamReports } : {}),
      worker: {
        status: 'launching',
        address: null,
        label: randomUUID()
      },
      ackPayload: null,
      waitDetails: null,
      result: null,
      error: null
    };

    recordJobSnapshot(job, job.createdAt);

    // Both synchronous sessions and background jobs claim this directory before publishing records.
    mkdirSync(this.workspace.baseDir, { recursive: true });
    try {
      mkdirSync(sessionDir);
    } catch (err) {
      if (err.code === 'EEXIST') {
        if (existsSync(jobPath)) return this.startJob(options);
        return { success: false, sessionId, error: `Session "${sessionId}" is already reserved.`,
          nextAction: `Inspect council status --session ${sessionId} before starting another run.` };
      }
      return { success: false, error: `Failed to reserve job directory: ${err.message}` };
    }
    try { atomicWrite(jobPath, JSON.stringify(job, null, 2)); }
    catch (err) { return { success: false, sessionId, error: `Failed to create job record: ${err.message}` }; }

    // Dispatch background worker.
    // NOTE: JobManager NEVER rewrites job.json after creation; errors are written to dispatch-error.json sidecar.
    let launchRes;
    try {
      launchRes = await this.workerLauncher({
        sessionDir,
        sessionId,
        options,
        jobPath,
        job
      });
    } catch (err) {
      launchRes = { success: false, error: `Worker launcher exception: ${err.message}` };
    }

    if (!launchRes || launchRes.success === false) {
      const errMsg = launchRes?.error || 'Failed to dispatch job worker';
      writeFileSync(join(sessionDir, 'dispatch-error.json'), JSON.stringify({ error: errMsg, failedAt: new Date().toISOString() }, null, 2), 'utf8');
      return {
        success: false,
        error: errMsg,
        sessionId,
        nextAction: jobRecovery('dispatch_failed')
      };
    }

    return {
      success: true,
      sessionId,
      state: 'starting',
      ...(job.workflow ? { mode, workflowSessionId: job.workflow.sessionId } : {}),
      participant: job.participant,
      deadlineAt: job.deadlineAt,
      workerAddress: launchRes.address || null,
      nextAction: `Check status with: council status --session ${sessionId}`
    };
  }

  #readJobSnapshot(sessionId) {
    const record = this.readJobRecord(sessionId);
    if (!record.success) return record;
    const observation = observeWorker(record.job, record.sessionDir, (address, timeout) => {
      const probe = this.herdr.get?.(address, { timeout });
      return probe?.success ? probe.details : null;
    });
    if (observation?.state !== 'stopped') return { ...record, observation };

    // The worker may have saved a result immediately before it exited.
    const latest = this.readJobRecord(sessionId);
    if (!latest.success || !sameActiveWorker(record.job, latest.job)) return latest;
    return { ...latest, observation };
  }

  /**
   * Non-blocking snapshot read of job status
   */
  async getStatus(sessionId) {
    const record = this.#readJobSnapshot(sessionId);
    if (!record.success) {
      return {
        success: false,
        sessionId: record.sessionId,
        state: record.state || 'failed',
        error: record.error,
        participant: record.job?.participant || null,
        updatedAt: record.job?.updatedAt || null,
        ...(record.dispatchFailed ? { nextAction: jobRecovery('dispatch_failed') } : {})
      };
    }

    const job = record.job;
    const isExpired = jobExpired(job);
    const recordedState = isExpired && job.state !== 'completed' && job.state !== 'failed' ? 'timed_out' : job.state;
    const decision = this.#formalDecision(job);
    const state = decision ? (decision.authorized ? 'completed' : 'failed') : recordedState;
    const outcome = decision ? state : jobInterruption(job, isExpired, record.observation) ?? state;
    const { label, ...worker } = job.worker ?? {};

    return {
      success: true,
      sessionId: record.sessionId,
      state,
      outcome,
      ...(job.workflow ? { mode: job.mode, workflowSessionId: job.workflow.sessionId, progress: job.workflowProgress ?? null } : {}),
      ...(decision ? { workflowStatus: decision.workflowStatus, authorized: decision.authorized } : {}),
      deliveryState: job.deliveryState,
      participant: job.participant,
      deadlineAt: job.deadlineAt,
      isExpired,
      worker: job.worker && { ...worker, ...(record.observation ? { observation: record.observation } : {}) },
      updatedAt: job.updatedAt,
      waitDetails: job.waitDetails || null,
      error: decision?.authorized ? null : job.error || null,
      nextAction: jobRecovery(outcome, job.deliveryState)
    };
  }

  /**
   * Snapshot read of job result without triggering side effects
   */
  async getResult(sessionId) {
    const record = this.#readJobSnapshot(sessionId);
    if (!record.success) {
      return {
        success: false,
        ready: !record.notFound,
        sessionId: record.sessionId,
        state: record.state || 'failed',
        error: record.error,
        participant: record.job?.participant || null,
        ...(record.dispatchFailed ? { nextAction: jobRecovery('dispatch_failed') } : {})
      };
    }

    const job = record.job;
    const cleanId = record.sessionId;
    const decision = this.#formalDecision(job);
    if (decision) {
      const state = decision.authorized ? 'completed' : 'failed';
      return { success: decision.authorized, ready: true, sessionId: cleanId, mode: job.mode,
        workflowSessionId: job.workflow.sessionId, state, outcome: state, deliveryState: job.deliveryState,
        ...decision, completedAt: job.result.completedAt };
    }
    const isExpired = jobExpired(job);
    const outcome = jobInterruption(job, isExpired, record.observation) ?? job.state;
    const nextAction = jobRecovery(outcome, job.deliveryState);
    const delivery = {
      outcome,
      deliveryState: job.deliveryState,
      ...(job.workflow && outcome === 'awaiting_input' ? { waitDetails: job.waitDetails } : {}),
      ...(job.workflow ? { mode: job.mode, workflowSessionId: job.workflow.sessionId } : {}),
      ...(record.observation ? { worker: { address: job.worker.address, observation: record.observation } } : {})
    };
    const workflowResult = job.workflow && job.result ? {
      workflowStatus: job.result.workflowStatus, authorized: job.result.authorized, execution: job.result.execution
    } : {};

    if (job.state === 'completed') {
      return {
        success: true,
        ready: true,
        sessionId: cleanId,
        state: 'completed',
        ...delivery,
        ...workflowResult,
        output: job.result.output,
        artifactPath: job.result.artifactPath || null,
        ...(Number.isSafeInteger(job.result.turn) ? { turn: job.result.turn } : {}),
        ...(job.result.captureScope ? { captureScope: job.result.captureScope } : {}),
        participant: job.participant,
        completedAt: job.result.completedAt || null
      };
    }

    if (job.state === 'failed' || job.state === 'uncertain') {
      return {
        success: false,
        ready: true,
        sessionId: cleanId,
        state: job.state,
        ...delivery,
        ...workflowResult,
        ...(job.workflow && job.result ? { output: job.result.output, artifactPath: job.result.artifactPath } : {}),
        error: job.error || 'Job failed during execution',
        participant: job.participant,
        details: job.waitDetails || null,
        nextAction
      };
    }

    if (outcome === 'worker_stopped') {
      return {
        success: false,
        ready: false,
        sessionId: cleanId,
        state: isExpired ? 'timed_out' : job.state,
        ...delivery,
        error: 'The worker stopped before Council saved a result.',
        participant: job.participant,
        nextAction
      };
    }

    if (isExpired) {
      return {
        success: false,
        ready: false,
        sessionId: cleanId,
        state: 'timed_out',
        ...delivery,
        error: 'Job deadline exceeded',
        participant: job.participant,
        nextAction
      };
    }

    return {
      success: true,
      ready: false,
      sessionId: cleanId,
      state: job.state,
      ...delivery,
      message: outcome === 'awaiting_input' ? 'The agent is waiting for input in Herdr' : 'Job is still running',
      participant: job.participant,
      nextAction: nextAction ?? `Check result again with: council result --session ${cleanId}`
    };
  }

  #formalDecision(job) {
    if (!job.workflow || !job.result || !['council', 'review'].includes(job.mode)) return null;
    let latest;
    try { latest = readFormalDecision(this.workspace, job.workflow.sessionId); }
    catch { /* A damaged current record cannot establish approval. */ }
    if (!latest && job.result.authorized === true) {
      return { authorized: false, workflowStatus: 'unconfirmed', artifactPath: null,
        output: 'Council could not verify the saved approval against the current session and verdict.' };
    }
    return latest ?? null;
  }
}
