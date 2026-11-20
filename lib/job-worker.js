import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { alignmentError, alignmentOf } from '../herdr/mods/council/runtime/alignment.mjs';
import { HerdrClient } from './herdr.js';
import { AgentWorkspace, sanitizeName, atomicWrite } from './workspace.js';
import { isAddressClaimedByOtherSession } from './jobs.js';

export class JobWorker {
  constructor({ sessionDir, herdr = null, workspace = null, hooks = {} } = {}) {
    if (!sessionDir) {
      throw new Error('sessionDir is required for JobWorker');
    }
    this.sessionDir = resolve(sessionDir);
    this.workspace = workspace || new AgentWorkspace(dirname(dirname(this.sessionDir)));
    this.herdr = herdr || new HerdrClient({ cwd: this.workspace.root });
    this.hooks = hooks || {};
  }

  /**
   * Main worker execution loop
   */
  async execute() {
    let acquiredWorkerLock = false;
    let acquiredBorrowLock = false;
    let workerLockPath = null;
    let borrowLockPath = null;

    try {
      // 1. Exclusive atomic worker-per-job claim: prevents duplicate worker processes on same job
      const localLocksDir = join(this.sessionDir, '.locks');
      mkdirSync(localLocksDir, { recursive: true });
      workerLockPath = join(localLocksDir, 'worker.lock');
      try {
        writeFileSync(workerLockPath, JSON.stringify({ pid: process.pid, time: Date.now() }), { flag: 'wx' });
        acquiredWorkerLock = true;
      } catch (err) {
        // Any error acquiring worker lock fails closed immediately WITHOUT mutating job.json
        return {
          success: false,
          error: err.code === 'EEXIST'
            ? 'Job is already claimed by an active worker process'
            : `Failed to acquire worker lock: ${err.message}`
        };
      }

      const jobPath = join(this.sessionDir, 'job.json');
      if (!existsSync(jobPath)) {
        throw new Error(`Job file not found at ${jobPath}`);
      }

      let job = JSON.parse(readFileSync(jobPath, 'utf8'));

      if (!job || typeof job !== 'object' || job.$schema !== 'council.job/v1') {
        return { success: false, error: 'Job record has invalid schema' };
      }

      // If job is already finished, attempting, or acknowledged, do not mutate job.json or retry
      if (job.state === 'completed' || job.state === 'failed' || job.state === 'uncertain') {
        return { success: false, error: `Job is already in terminal state "${job.state}"` };
      }
      if (job.deliveryState === 'acknowledged') {
        return { success: false, error: 'Job task has already been acknowledged; duplicate execution forbidden' };
      }
      if (job.deliveryState === 'attempting') {
        return { success: false, error: 'Job task delivery is already attempting; duplicate execution forbidden' };
      }

      const saveJob = () => {
        job.updatedAt = new Date().toISOString();
        atomicWrite(jobPath, JSON.stringify(job, null, 2));
      };

      // Strict deadline check: verify deadline has not expired before starting execution
      const deadlineMs = new Date(job.deadlineAt).getTime();
      if (Date.now() >= deadlineMs) {
        job.state = 'failed';
        job.error = 'Job deadline expired before task delivery';
        saveJob();
        return { success: false, error: job.error };
      }

      // Claim the job in state before performing participant side effects
      job.worker = job.worker || {};
      job.worker.status = 'claimed';
      job.worker.pid = process.pid;
      if (this.herdr?.terminalId) {
        job.worker.address = this.herdr.terminalId;
      }
      saveJob();

      const isBorrowed = job.participant.ownership === 'borrowed';
      let targetAddress = job.participant.canonicalAddress || job.participant.address;

      if (isBorrowed) {
        // Acquire exclusive borrowed-address lock across sessions before any side effect
        const globalLocksDir = join(this.workspace.baseDir, '.locks');
        mkdirSync(globalLocksDir, { recursive: true });
        const safeName = sanitizeName(targetAddress);
        borrowLockPath = join(globalLocksDir, `borrow-${safeName}.lock`);
        try {
          writeFileSync(borrowLockPath, JSON.stringify({
            sessionId: job.sessionId,
            address: targetAddress,
            pid: process.pid,
            time: Date.now()
          }), { flag: 'wx' });
          acquiredBorrowLock = true;
        } catch (err) {
          job.state = 'failed';
          job.error = err.code === 'EEXIST'
            ? `Adopted terminal "${targetAddress}" is already claimed by another active session`
            : `Failed to acquire borrowed terminal lock: ${err.message}`;
          saveJob();
          return { success: false, error: job.error };
        }

        if (job.deliveryState === 'planned') {
          // Re-check deadline before side effect
          if (Date.now() >= deadlineMs) {
            job.state = 'failed';
            job.error = 'Job deadline expired before task delivery';
            saveJob();
            return { success: false, error: job.error };
          }

          // Check if claimed by another active session in the workspace
          const claimCheck = isAddressClaimedByOtherSession(
            this.workspace.baseDir,
            targetAddress,
            job.sessionId
          );
          if (claimCheck.claimed) {
            job.state = 'failed';
            job.error = `Adopted terminal "${targetAddress}" is already claimed by active Council session "${claimCheck.sessionId}"`;
            saveJob();
            return { success: false, error: job.error };
          }

          // Check terminal readiness and establish baseline turn
          let probe = this.herdr.get(targetAddress);
          if (!probe || !probe.success || !probe.details) {
            job.state = 'failed';
            job.error = probe?.error || `Borrowed terminal ${targetAddress} not found in Herdr`;
            saveJob();
            return { success: false, error: job.error };
          }

          let details = probe.details;
          if (details.reported === false || details.turn === 0) {
            // Unreported or turn 0: wait once to achieve startup readiness
            this.herdr.wait(targetAddress, { timeoutSec: 10 });
            probe = this.herdr.get(targetAddress);
            if (!probe || !probe.success || !probe.details) {
              job.state = 'failed';
              job.error = 'Borrowed terminal failed to report readiness after startup wait';
              saveJob();
              return { success: false, error: job.error };
            }
            details = probe.details;
          }

          const statusState = typeof details.status === 'object' && details.status !== null
            ? details.status.state
            : details.status;

          if (details.state !== 'live' || details.reported === false || statusState === 'working' || statusState === 'blocked' || statusState === 'error') {
            job.state = 'failed';
            job.error = `Borrowed terminal ${targetAddress} is not ready (state: ${details.state}, status: ${statusState}, reported: ${details.reported})`;
            saveJob();
            return { success: false, error: job.error };
          }

          const alignment = alignmentOf(details);
          if (alignment !== 'aligned') {
            job.state = 'failed';
            job.error = alignmentError(targetAddress, alignment);
            saveJob();
            return { success: false, error: job.error, alignment };
          }

          const baselineTurn = typeof details.turn === 'number' ? details.turn : 0;
          job.baselineTurn = baselineTurn;

          // Re-check deadline immediately before setting deliveryState or sending
          if (Date.now() >= deadlineMs) {
            job.state = 'failed';
            job.error = 'Job deadline expired before task delivery';
            saveJob();
            return { success: false, error: job.error };
          }

          // 1. Persist delivery intent before side effect
          job.deliveryState = 'attempting';
          saveJob();

          // Lifecycle hook: beforeAttempt (0 sends occurred)
          if (this.hooks.beforeAttempt) await this.hooks.beforeAttempt(job);
          if (this.hooks.beforeDelivery) await this.hooks.beforeDelivery(job);

          // Re-check deadline after hook immediately before send
          if (Date.now() >= deadlineMs) {
            job.state = 'failed';
            job.error = 'Job deadline expired before task delivery';
            saveJob();
            return { success: false, error: job.error };
          }

          // 2. Perform side effect: send task prompt
          const sendRes = this.herdr.send(targetAddress, job.task, { expectedTurn: baselineTurn, timeout: Math.max(1, deadlineMs - Date.now()) });

          // Lifecycle hook: afterAttempt (1 send occurred, before ACK is confirmed)
          if (this.hooks.afterAttempt) await this.hooks.afterAttempt(job, sendRes);

          if (sendRes?.alignment && sendRes.success === false) {
            job.deliveryState = 'failed';
            job.state = 'failed';
            job.error = sendRes.error;
            saveJob();
            return { success: false, error: job.error, alignment: sendRes.alignment };
          }

          // Parse and validate ACK payload
          let ack = null;
          if (sendRes && sendRes.success && sendRes.output) {
            try {
              ack = typeof sendRes.output === 'string' ? JSON.parse(sendRes.output) : sendRes.output;
            } catch {
              ack = null;
            }
          }

          // Strict ACK correlation:
          // started must be true, turn must be a number matching baselineTurn
          const isAckValid = ack &&
            typeof ack === 'object' &&
            ack.started === true &&
            typeof ack.turn === 'number' &&
            ack.turn === baselineTurn;

          if (!isAckValid) {
            job.deliveryState = 'uncertain';
            job.state = 'failed';
            job.error = `Ambiguous delivery acknowledgement: ${JSON.stringify(ack || sendRes?.error || sendRes?.output)}`;
            job.ackPayload = ack;
            saveJob();
            return { success: false, error: job.error };
          }

          // Acknowledged
          job.ackPayload = ack;
          job.deliveryState = 'acknowledged';
          job.state = 'deliberating';
          saveJob();
        }
      } else {
        // Owned participant
        if (job.deliveryState === 'planned') {
          if (Date.now() >= deadlineMs) {
            job.state = 'failed';
            job.error = 'Job deadline expired before task delivery';
            saveJob();
            return { success: false, error: job.error };
          }

          job.deliveryState = 'attempting';
          saveJob();

          if (this.hooks.beforeAttempt) await this.hooks.beforeAttempt(job);
          if (this.hooks.beforeDelivery) await this.hooks.beforeDelivery(job);

          if (Date.now() >= deadlineMs) {
            job.state = 'failed';
            job.error = 'Job deadline expired before task delivery';
            saveJob();
            return { success: false, error: job.error };
          }

          // Herdr terminal name <= 32 chars
          const hash = createHash('sha256').update(job.sessionId).digest('hex').slice(0, 8);
          const launchName = `c-${sanitizeName(job.sessionId).slice(0, 18)}-${hash}`;

          const launchRes = this.herdr.launchAgent({
            name: launchName,
            agent: job.participant.agent,
            permission: job.participant.permission,
            cwd: this.workspace.root,
            task: job.task,
            sessionDir: this.sessionDir,
            alignmentTimeoutSec: (deadlineMs - Date.now()) / 1000
          });

          if (this.hooks.afterAttempt) await this.hooks.afterAttempt(job, launchRes);

          if (!launchRes || !launchRes.success || !launchRes.address) {
            job.deliveryState = 'failed';
            job.state = 'failed';
            job.participant.address = launchRes?.address ?? job.participant.address;
            job.error = launchRes?.error || 'Failed to launch agent in Herdr';
            saveJob();
            return { success: false, error: job.error };
          }

          targetAddress = launchRes.address;
          job.participant.address = targetAddress;
          job.baselineTurn = launchRes.baselineTurn ?? 0;
          saveJob();

          // Verify that first message delivery succeeded; preserve address if unsent
          if (launchRes.details?.first_message && launchRes.details.first_message.sent === false) {
            job.deliveryState = 'failed';
            job.state = 'failed';
            job.error = 'First message failed to deliver to launched agent';
            saveJob();
            return { success: false, error: job.error };
          }

          job.deliveryState = 'acknowledged';
          job.state = 'deliberating';
          saveJob();
        }
      }

      // Lifecycle hook: beforeWait
      if (this.hooks.beforeWait) await this.hooks.beforeWait(job);

      // Verify deadline before waiting
      const expectedTurn = (job.baselineTurn ?? 0) + 1;
      let waitRes = null;
      let finalSuccess = false;

      if (isBorrowed) {
        // A Herdr message can wake the worker before the borrowed turn finishes.
        do {
          const remainingMs = deadlineMs - Date.now();
          if (remainingMs <= 0) {
            job.state = 'failed';
            job.error = 'Job deadline expired before waiting';
            job.failureKind = 'timed_out';
            saveJob();
            return { success: false, error: job.error };
          }
          const remainingSec = Math.ceil(remainingMs / 1000);
          waitRes = this.herdr.wait(targetAddress, { timeoutSec: remainingSec });
          if (this.hooks.afterWait) await this.hooks.afterWait(job, waitRes);
          job.waitDetails = waitRes?.details || waitRes;
        } while ((waitRes?.reason || waitRes?.details?.reason) === 'message');

        // Strict requirement: waitRes.success must be true; do not accept good-looking payload if wrapper failed
        if (!waitRes || !waitRes.success) {
          job.state = 'failed';
          job.error = waitRes?.error || `Wait failed on borrowed terminal ${targetAddress}`;
          saveJob();
          return { success: false, error: job.error };
        }

        const isEnded = waitRes.ended === true || waitRes.details?.ended === true;
        const term = waitRes.terminal || waitRes.target || waitRes.details?.terminal;
        const isTermMatch = term === targetAddress;
        const statusDone = waitRes.status === 'done' || waitRes.details?.status === 'done';
        const reasonStatus = (waitRes.reason || waitRes.details?.reason) === 'status';
        const turn = typeof waitRes.turn === 'number'
          ? waitRes.turn
          : (typeof waitRes.details?.turn === 'number' ? waitRes.details.turn : null);

        if (!isEnded || !isTermMatch || !statusDone || !reasonStatus || turn === null || turn < expectedTurn) {
          job.state = 'failed';
          job.error = `Borrowed terminal did not finish with verified status done (ended: ${isEnded}, termMatch: ${isTermMatch}, status: ${waitRes.status}, reason: ${waitRes.reason}, turn: ${turn}, expected: ${expectedTurn})`;
          saveJob();
          return { success: false, error: job.error };
        }
        finalSuccess = true;
      } else {
        // Owned terminal: traverse startup idle (turn 0) or intermediate message until done, error, blocked, or deadline
        while (Date.now() < deadlineMs) {
          const remainingMs = deadlineMs - Date.now();
          if (remainingMs <= 0) break;
          const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));

          waitRes = this.herdr.wait(targetAddress, { timeoutSec: remainingSec });
          if (this.hooks.afterWait) await this.hooks.afterWait(job, waitRes);
          job.waitDetails = waitRes?.details || waitRes;

          const reason = waitRes?.reason || waitRes?.details?.reason;
          // Intermediate message notifications continue waiting
          if (reason === 'message') {
            continue;
          }

          const turn = typeof waitRes?.turn === 'number' ? waitRes.turn : (typeof waitRes?.details?.turn === 'number' ? waitRes.details.turn : null);

          if (waitRes && waitRes.success) {
            if (turn !== null && turn >= expectedTurn) {
              finalSuccess = true;
              break;
            }
            // Premature process exit at turn 0 is not completion
            if (waitRes.ended) {
              break;
            }
          }

          if (!waitRes || waitRes.isBlocked || (waitRes.isError && waitRes.ended) || waitRes.isTimeout) {
            break;
          }

          if (turn === 0 || waitRes.status === 'idle') {
            continue;
          }
          break;
        }

        if (!finalSuccess) {
          job.state = 'failed';
          job.error = waitRes?.error || `Owned agent turn incomplete (status: ${waitRes?.status}, reason: ${waitRes?.reason})`;
          saveJob();
          return { success: false, error: job.error };
        }
      }

      // Check deadline before reading
      if (Date.now() >= deadlineMs) {
        job.state = 'failed';
        job.error = 'Job deadline expired during execution';
        job.failureKind = 'timed_out';
        saveJob();
        return { success: false, error: job.error };
      }

      // Collect screen output
      const readRes = this.herdr.read(targetAddress, 500);
      if (!readRes || !readRes.success || typeof readRes.content !== 'string') {
        job.state = 'failed';
        job.error = `Failed to read terminal output: ${readRes?.error || 'read failed'}`;
        saveJob();
        return { success: false, error: job.error };
      }

      // Check deadline after reading
      if (Date.now() >= deadlineMs) {
        job.state = 'failed';
        job.error = 'Job deadline expired during read';
        job.failureKind = 'timed_out';
        saveJob();
        return { success: false, error: job.error };
      }

      // Persist artifact
      const deliverablesDir = join(this.sessionDir, 'deliverables');
      mkdirSync(deliverablesDir, { recursive: true });
      const artifactPath = join(deliverablesDir, 'output.txt');
      writeFileSync(artifactPath, readRes.content, 'utf8');

      job.state = 'completed';
      job.result = {
        success: true,
        ready: true,
        output: readRes.content,
        artifactPath,
        completedAt: new Date().toISOString()
      };
      saveJob();

      // Cleanup: only clean up owned agents when keep is not requested; NEVER touch borrowed terminals
      if (!isBorrowed && !job.keepTerminals) {
        try {
          this.herdr.dismiss(targetAddress);
        } catch {}
      }

      return {
        success: true,
        ready: true,
        output: readRes.content,
        artifactPath
      };
    } catch (err) {
      return { success: false, error: `Worker execution exception: ${err.message}` };
    } finally {
      if (acquiredBorrowLock && borrowLockPath) {
        try { unlinkSync(borrowLockPath); } catch {}
      }
      if (acquiredWorkerLock && workerLockPath) {
        try { unlinkSync(workerLockPath); } catch {}
      }
    }
  }
}

// Standalone executable execution when invoked directly
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sessionDir = process.argv[2];
  if (!sessionDir) {
    console.error('Usage: node job-worker.js <sessionDir>');
    process.exit(1);
  }

  const worker = new JobWorker({ sessionDir });
  worker.execute().then(res => {
    process.exit(res.success ? 0 : 1);
  }).catch(err => {
    console.error(`Fatal worker execution error: ${err.message}`);
    process.exit(1);
  });
}
