import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HerdrClient } from './herdr.js';
import { AgentWorkspace, sanitizeName } from './workspace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Compute deterministic input fingerprint for job idempotency and conflict detection
 */
export function computeFingerprint(options = {}) {
  const normalized = {
    mode: options.mode || 'delegate',
    task: String(options.task || '').trim(),
    agent: String(options.agent || 'codex').toLowerCase().trim(),
    adopt: options.adopt ? String(options.adopt).trim() : null,
    permission: options.permission || 'read',
    timeoutSec: Number(options.timeoutSec || 180),
    keepTerminals: Boolean(options.keepTerminals || options.keep)
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

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
          // Completed and failed jobs immediately release their claim for reuse
          if (otherJob.state === 'completed' || otherJob.state === 'failed') {
            continue;
          }
          // Uncertain jobs hold claim until deadline expires for manual inspection
          const isExpired = otherJob.deadlineAt && Date.now() > new Date(otherJob.deadlineAt).getTime();
          if (!isExpired) {
            return {
              claimed: true,
              sessionId: otherJob.sessionId,
              state: otherJob.state
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
  defaultWorkerLauncher({ sessionDir, sessionId }) {
    const workerScript = resolve(__dirname, 'job-worker.js');
    const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
    const name = `c-job-${hash}`;
    const res = this.herdr.exec([
      'run',
      '--bg',
      '--outlive-parent',
      '--json',
      '--name',
      name,
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
   * Start an asynchronous single-task delegation job
   */
  async startJob(options = {}) {
    const mode = options.mode || 'delegate';
    if (mode !== 'delegate') {
      return {
        success: false,
        error: `Mode "${mode}" is not supported for asynchronous jobs (only delegate is currently supported)`
      };
    }

    if (!options.task || !String(options.task).trim()) {
      return { success: false, error: 'Task description is required' };
    }

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
    if (options.sessionId !== undefined && options.sessionId !== null) {
      const sid = String(options.sessionId);
      if (!sid.trim() || sid.includes('..') || sid.includes('/') || sid.includes('\\') || /[<>:"|?*]/.test(sid)) {
        return {
          success: false,
          error: `Invalid or unsafe session ID: "${sid}" contains path traversal or invalid characters`
        };
      }
    }

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
    const fingerprint = computeFingerprint(options);

    // 1. FIRST: Check if session record already exists before querying Herdr readiness
    // This ensures identical restarts during a working terminal are accepted without false rejection
    if (existsSync(jobPath)) {
      let existingContent;
      try {
        existingContent = readFileSync(jobPath, 'utf8');
      } catch (err) {
        return { success: false, error: `Failed to read existing job record: ${err.message}` };
      }

      let existingJob;
      try {
        existingJob = JSON.parse(existingContent);
      } catch (err) {
        // Corrupt existing record: fail closed without replacing or dispatching worker
        return { success: false, error: `Existing job record is corrupt: ${err.message}` };
      }

      if (!existingJob || typeof existingJob !== 'object' || existingJob.$schema !== 'council.job/v1') {
        return { success: false, error: 'Existing job record does not match council.job/v1 schema' };
      }

      // Check for conflicting inputs on same session ID
      if (existingJob.fingerprint !== fingerprint) {
        return {
          success: false,
          error: `Session "${sessionId}" already exists with conflicting parameters (fingerprint mismatch)`
        };
      }

      // If prior start had a terminal launch failure, do not redispatch
      if (existingJob.state === 'failed') {
        return {
          success: false,
          error: existingJob.error || 'Prior job launch failed; cannot redispatch',
          sessionId,
          state: existingJob.state
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

    if (isAdopted) {
      const val = validateAdoptedTerminal({
        adopt: adoptAddress,
        callerTerminal,
        herdr: this.herdr,
        baseDir: this.workspace.baseDir,
        currentSessionId: sessionId
      });
      if (!val.valid) {
        return { success: false, error: val.error };
      }
      canonicalAddress = val.canonicalAddress || adoptAddress;
    }

    // Prepare new job record
    mkdirSync(sessionDir, { recursive: true });

    const timeoutSec = Number(options.timeoutSec || 180);
    const now = Date.now();
    const deadlineAt = new Date(now + timeoutSec * 1000).toISOString();

    const job = {
      $schema: 'council.job/v1',
      sessionId,
      mode: 'delegate',
      task: String(options.task).trim(),
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
      participant: {
        ownership: isAdopted ? 'borrowed' : 'owned',
        address: adoptAddress,
        canonicalAddress,
        agent: options.agent || 'codex',
        permission: options.permission || 'read'
      },
      worker: {
        status: 'launching',
        address: null
      },
      ackPayload: null,
      waitDetails: null,
      result: null,
      error: null
    };

    // Exclusive atomic file creation to prevent race conditions on concurrent starts
    try {
      writeFileSync(jobPath, JSON.stringify(job, null, 2), { flag: 'wx', encoding: 'utf8' });
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Another start process won the race: re-read and handle idempotency/conflict
        try {
          const winnerJob = JSON.parse(readFileSync(jobPath, 'utf8'));
          if (winnerJob.fingerprint === fingerprint) {
            return {
              success: true,
              reconnect: true,
              sessionId,
              state: winnerJob.state,
              participant: winnerJob.participant,
              deadlineAt: winnerJob.deadlineAt,
              nextAction: `Check status with: council status --session ${sessionId}`
            };
          }
          return {
            success: false,
            error: `Session "${sessionId}" already exists with conflicting parameters`
          };
        } catch {
          return { success: false, error: 'Concurrent start conflict detected on session' };
        }
      }
      return { success: false, error: `Failed to create job record: ${err.message}` };
    }

    // Dispatch background worker.
    // NOTE: JobManager NEVER rewrites job.json after creation; the worker is the sole writer.
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
      return {
        success: false,
        error: `Worker launcher exception: ${err.message}`
      };
    }

    if (!launchRes || launchRes.success === false) {
      return {
        success: false,
        error: launchRes?.error || 'Failed to dispatch job worker'
      };
    }

    return {
      success: true,
      sessionId,
      state: 'starting',
      participant: job.participant,
      deadlineAt: job.deadlineAt,
      workerAddress: launchRes.address || null,
      nextAction: `Check status with: council status --session ${sessionId}`
    };
  }

  /**
   * Non-blocking snapshot read of job status
   */
  async getStatus(sessionId) {
    if (!sessionId) {
      return { success: false, error: 'Session ID is required' };
    }
    const cleanId = this.workspace.sanitizeName(sessionId);
    const sessionDir = join(this.workspace.baseDir, cleanId);
    const jobPath = join(sessionDir, 'job.json');

    if (!existsSync(jobPath)) {
      return { success: false, error: `Job "${cleanId}" not found` };
    }

    let job;
    try {
      job = JSON.parse(readFileSync(jobPath, 'utf8'));
    } catch (err) {
      return { success: false, error: `Job record is corrupt: ${err.message}` };
    }

    const isExpired = Date.now() > new Date(job.deadlineAt).getTime();

    return {
      success: true,
      sessionId: cleanId,
      state: isExpired && job.state !== 'completed' && job.state !== 'failed' ? 'timed_out' : job.state,
      deliveryState: job.deliveryState,
      participant: job.participant,
      deadlineAt: job.deadlineAt,
      isExpired,
      worker: job.worker,
      updatedAt: job.updatedAt,
      error: job.error || null
    };
  }

  /**
   * Snapshot read of job result without triggering side effects
   */
  async getResult(sessionId) {
    if (!sessionId) {
      return { success: false, ready: false, error: 'Session ID is required' };
    }
    const cleanId = this.workspace.sanitizeName(sessionId);
    const sessionDir = join(this.workspace.baseDir, cleanId);
    const jobPath = join(sessionDir, 'job.json');

    if (!existsSync(jobPath)) {
      return { success: false, ready: false, error: `Job "${cleanId}" not found` };
    }

    let job;
    try {
      job = JSON.parse(readFileSync(jobPath, 'utf8'));
    } catch (err) {
      return { success: false, ready: false, error: `Job record is corrupt: ${err.message}` };
    }

    if (job.state === 'completed') {
      return {
        success: true,
        ready: true,
        sessionId: cleanId,
        state: 'completed',
        output: job.result?.output || '',
        artifactPath: job.result?.artifactPath || null,
        participant: job.participant,
        completedAt: job.result?.completedAt || null
      };
    }

    if (job.state === 'failed' || job.state === 'uncertain') {
      return {
        success: false,
        ready: true,
        sessionId: cleanId,
        state: job.state,
        error: job.error || 'Job failed during execution',
        participant: job.participant,
        details: job.waitDetails || null
      };
    }

    const isExpired = Date.now() > new Date(job.deadlineAt).getTime();
    if (isExpired) {
      return {
        success: false,
        ready: false,
        sessionId: cleanId,
        state: 'timed_out',
        error: 'Job deadline exceeded',
        participant: job.participant
      };
    }

    return {
      success: true,
      ready: false,
      sessionId: cleanId,
      state: job.state,
      message: 'Job is still running',
      participant: job.participant,
      nextAction: `Check result again with: council result --session ${cleanId}`
    };
  }
}
