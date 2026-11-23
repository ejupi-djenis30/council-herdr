import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildHcRunArgs, normalizeAgentName } from './recipes.js';
import { watchBlockedTurn } from './herdr-approval.js';
import { alignmentChallenge, alignmentError, alignmentNotice, alignmentOf, terminalIdentity } from '../herdr/mods/council/runtime/alignment.mjs';

const waitAlignment = fileURLToPath(new URL('../herdr/mods/council/runtime/wait-alignment.mjs', import.meta.url));
const cliEntry = fileURLToPath(new URL('../bin/council.js', import.meta.url));
// Allow room for Windows argument escaping and the rest of the command line.
const maxInlinePromptBytes = 8192;

/**
 * Interface with Herdr Terminal Core (`hc`)
 */
export class HerdrClient {
  constructor(options = {}) {
    this.bin = options.bin || 'hc';
    this.cwd = options.cwd || process.cwd();
    this.terminalId = process.env.HC_TERMINAL_ID || null;
  }

  /**
   * Run raw `hc` command synchronously
   */
  exec(args, options = {}) {
    const opts = {
      cwd: options.cwd || this.cwd,
      encoding: 'utf8',
      env: { ...process.env, ...options.env },
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      ...options
    };

    const res = spawnSync(this.bin, args, opts);
    const stdout = res.stdout ? res.stdout.trim() : '';
    const stderr = res.stderr ? res.stderr.trim() : '';

    return {
      success: res.status === 0,
      code: res.status,
      stdout,
      stderr,
      error: res.error || null
    };
  }

  /**
   * Parse JSON output when hc is run in piped mode
   */
  parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Get version of hc
   */
  version() {
    const res = this.exec(['--version']);
    if (res.success && res.stdout) {
      return res.stdout;
    }
    return null;
  }

  /**
   * List live Herdr terminals (`hc ls`)
   */
  list() {
    const res = this.exec(['ls']);
    if (!res.success) {
      return { success: false, error: res.stderr || res.stdout || 'Failed to list terminals' };
    }
    const parsed = this.parseJson(res.stdout);
    return {
      success: true,
      terminals: parsed || res.stdout
    };
  }

  /**
   * Get state and details of a specific terminal (`hc get <target>`)
   */
  get(target, { timeout = 10000 } = {}) {
    const res = this.exec(['get', target], { timeout });
    if (!res.success) {
      return { success: false, isTimeout: res.error?.code === 'ETIMEDOUT', error: res.stderr || res.stdout || res.error?.message || `Failed to get terminal ${target}` };
    }
    const parsed = this.parseJson(res.stdout);
    return {
      success: true,
      details: parsed || res.stdout
    };
  }

  requestAlignment(target, { refresh = false } = {}) {
    const current = this.get(target);
    const terminal = current.details;
    const address = terminal?.address ?? target;
    const state = alignmentOf(terminal);
    const outcome = (status, error) => ({ address, state, request: error ? { status, error } : { status } });
    if (!current.success || terminal?.state !== 'live' || !terminal.reported || !terminal.status?.app) {
      return outcome('unavailable', current.error || `No live Herdr agent reported at ${address}.`);
    }
    if (state === 'aligned') return outcome('already_aligned');
    if (state === 'not_aligned' && !refresh) return outcome('not_requested');
    const status = terminal.status.state;
    if (!['idle', 'done'].includes(status)) return outcome('deferred_busy');
    const guard = status === 'idle' ? ['--if', 'idle'] : [];
    const challenge = alignmentChallenge(terminal);
    if (challenge.argument) {
      const tagged = this.exec(['label', '--json', address, challenge.argument], { timeout: 10000 });
      if (!tagged.success) return outcome('failed', 'Herdr did not confirm the alignment challenge. No notice was sent.');
    }
    const sent = this.exec(['send', '--json', ...guard, address, alignmentNotice(cliEntry, challenge)], { timeout: 12000 });
    const ack = this.parseJson(sent.stdout);
    if (sent.success && ack?.started === true && Number.isSafeInteger(ack.turn) && ack.turn === terminal.turn) return outcome('sent');
    const failure = (this.parseJson(sent.stderr) ?? ack)?.error;
    if (['blocked', 'status_mismatch'].includes(failure?.kind)) return outcome('deferred_busy');
    if (['finished', 'lost', 'not_found'].includes(failure?.kind)) return outcome('unavailable', failure.message);
    return outcome('uncertain', 'Herdr did not acknowledge the readiness notice. Inspect the terminal before sending another check.');
  }

  waitForAlignment(target, timeout) {
    const result = spawnSync(process.execPath, [waitAlignment, this.bin, target, String(timeout)], {
      cwd: this.cwd, windowsHide: true, encoding: 'utf8', timeout: timeout + 2000
    });
    return this.parseJson(result.stdout) ?? { state: 'unconfirmed' };
  }

  /**
   * Launch an agent inside a new background Herdr terminal.
   * If brief is multiline, writes it to a deterministic brief file (.agent_workspace/<session-id>/briefs/).
   */
  launchAgent({
    name,
    agent,
    permission = 'read',
    cwd = null,
    task = '',
    context = '',
    sessionDir = null,
    alignmentTimeoutSec = 90,
    model = '',
    managedTeam = false
  }) {
    const targetCwd = resolve(cwd || this.cwd);
    const start = Date.now();
    const limit = Math.max(1, Math.ceil(alignmentTimeoutSec * 1000));
    const challenge = alignmentChallenge();
    const hcArgs = buildHcRunArgs({ name, cwd: targetCwd, agent, permission, model, managedTeam, task: alignmentNotice(cliEntry, challenge) });
    hcArgs.splice(1, 0, '--json', '--label', challenge.argument);
    const res = this.exec(hcArgs, { cwd: targetCwd, timeout: limit });
    const data = this.parseJson(res.stdout);
    const address = data?.address || null;
    if (!res.success || !address) {
      const failure = data?.error ?? this.parseJson(res.stderr)?.error;
      return { success: false, name, address, errorKind: failure?.kind, error: failure?.message || res.stderr || res.stdout || `Failed to launch ${name} in Herdr` };
    }
    const state = this.waitForAlignment(address, Math.max(1, limit - (Date.now() - start)));
    if (state.state !== 'aligned' || !Number.isSafeInteger(state.turn)) {
      return { success: false, name, address, error: alignmentError(address, state.state), alignment: state.state };
    }
    if (typeof context === 'function') {
      try {
        context = context();
      } catch (error) {
        return { success: false, name, address, error: `Could not prepare the team handoff: ${error.message}` };
      }
    }
    let taskPrompt = task;

    // Check if task is long or multi-line: write to brief file to prevent CLI escaping issues
    if (task.includes('\n') || task.length > 250 || context || sessionDir) {
      const briefsDir = sessionDir
        ? join(sessionDir, 'briefs')
        : join(targetCwd, '.agent_workspace', 'default', 'briefs');

      if (!existsSync(briefsDir)) {
        mkdirSync(briefsDir, { recursive: true });
      }

      const briefFile = join(briefsDir, `${name}.md`);
      const fullBrief = [
        `# Council Task Brief: ${name}`,
        `Role: ${name} (${agent})`,
        `Permission: ${permission}`,
        `Target Workspace: ${targetCwd}`,
        '',
        '## Instructions',
        task,
        context ? `\n## Context\n${context}` : '',
        '',
        '## Completion',
        'When finished, output your complete answer clearly on stdout for coordinator collection.',
        managedTeam ? 'End this turn after your final handoff. Council will archive the result and shut down this process.' : this.terminalId
          ? `If \`hc\` is available on your PATH, you may notify the parent: hc send ${this.terminalId} "<summary>". If \`hc\` is unavailable or restricted in your sandbox, simply output your final answer on stdout without seeking external binaries.`
          : 'If `hc` is not available, simply output your final answer directly on stdout.'
      ].join('\n');

      writeFileSync(briefFile, fullBrief, 'utf8');
      taskPrompt = `Read and execute instructions in ${briefFile}. Report findings when done.`;
    }

    const remaining = limit - (Date.now() - start);
    const delivery = remaining > 0 ? this.send(address, taskPrompt, { expectedTurn: state.turn, timeout: remaining })
      : { success: false, error: 'Council reached the setup deadline before sending the task.' };
    const ack = this.parseJson(delivery.output);
    const sent = delivery.success && ack?.started === true && ack.turn === state.turn;

    return {
      success: sent,
      name,
      address,
      agent: normalizeAgentName(agent),
      permission,
      cwd: targetCwd,
      baselineTurn: state.turn,
      terminalIdentity: delivery.terminalIdentity,
      identity: { pid: state.pid, createdMs: state.createdMs },
      alignment: 'aligned',
      error: sent ? null : (delivery.error || `Task delivery to ${address} was not acknowledged.`),
      details: { ...data, first_message: { sent, ...(ack ?? {}) } },
      output: delivery.output
    };
  }

  waitForApproval(target, blockedTurn, options) {
    return watchBlockedTurn({ ...options, bin: this.bin, cwd: this.cwd, target, blockedTurn });
  }

  /**
   * Wait on a specific terminal until its turn finishes or it exits (`hc wait --json <target>`)
   */
  wait(target, options = {}) {
    const args = ['wait', '--json', target];
    if (options.timeoutSec) {
      args.push('--timeout', String(options.timeoutSec));
    }
    const res = this.exec(args, options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: 'SIGKILL' });
    const waitData = this.parseJson(res.stdout);

    if (!res.success || !waitData || typeof waitData !== 'object') {
      const isTimeout = res.error?.code === 'ETIMEDOUT';
      return {
        success: false,
        target,
        terminal: target,
        ended: null,
        exitCode: null,
        reason: isTimeout ? 'timeout' : null,
        status: null,
        turn: null,
        isTimeout,
        isBlocked: false,
        isError: !isTimeout,
        isDone: false,
        details: null,
        output: res.stdout,
        error: isTimeout ? `Turn timed out for ${target}` : res.stderr || res.stdout || 'Invalid or malformed wait response'
      };
    }

    const ended = waitData.ended ?? null;
    const exitCode = waitData.exit_code ?? null;
    const reason = waitData.reason ?? null;
    const status = waitData.status ?? null;
    const terminal = waitData.terminal ?? target;
    const turn = typeof waitData.turn === 'number' ? waitData.turn : null;

    const isTimeout = reason === 'timeout' || (status === 'working' && ended === false);
    const isBlocked = reason === 'blocked' || status === 'blocked';
    const isError = reason === 'error' || status === 'error' || (ended === true && exitCode !== null && exitCode !== 0);

    // Turn 0 is startup/stale; a genuine task turn must have advanced (turn >= 1) or process exited cleanly
    const isFreshTurn = turn !== null ? turn >= 1 : false;
    const isProcessExitZero = ended === true && exitCode === 0 && (reason === 'exit' || reason === null);
    const isAgentDone = (status === 'done' || reason === 'done') && isFreshTurn && ended !== false && reason !== 'message' && reason !== 'timeout';

    const isDone = isProcessExitZero || isAgentDone;
    const success = isDone && !isTimeout && !isBlocked && !isError;

    let errorMessage = null;
    if (isTimeout) {
      errorMessage = `Turn timed out for ${target}`;
    } else if (isBlocked) {
      errorMessage = `Terminal ${target} is blocked waiting for input`;
    } else if (isError) {
      errorMessage = `Terminal ${target} failed with exit code ${exitCode} / reason ${reason}`;
    } else if (!success) {
      errorMessage = `Turn incomplete for ${target} (status: ${status}, reason: ${reason}, turn: ${turn})`;
    }

    return {
      success,
      target,
      terminal,
      ended,
      exitCode,
      reason,
      status,
      turn,
      isTimeout,
      isBlocked,
      isError,
      isDone,
      details: waitData,
      output: res.stdout,
      error: errorMessage
    };
  }

  /**
   * Wait for all child terminals spawned by this session (`hc wait --json --children all`)
   */
  waitAllChildren(options = {}) {
    const args = ['wait', '--json', '--children', 'all'];
    if (options.timeoutSec) {
      args.push('--timeout', String(options.timeoutSec));
    }
    const res = this.exec(args);
    const waitData = this.parseJson(res.stdout);

    if (!res.success || !waitData || typeof waitData !== 'object') {
      return {
        success: false,
        ended: null,
        reason: null,
        status: null,
        details: waitData,
        output: res.stdout,
        error: res.stderr || res.stdout || 'Invalid wait response'
      };
    }

    const ended = waitData.ended ?? null;
    const reason = waitData.reason ?? null;
    const status = waitData.status ?? null;
    const isTimeout = reason === 'timeout' || (status === 'working' && ended === false);
    const isBlocked = reason === 'blocked' || status === 'blocked';
    const isError = reason === 'error' || status === 'error' || (ended === true && waitData.exit_code !== null && waitData.exit_code !== 0);

    const success = ended !== false && !isTimeout && !isBlocked && !isError && reason !== 'message';

    let error = null;
    if (isTimeout) error = 'Timed out waiting for children';
    else if (isBlocked) error = 'A child terminal is blocked waiting for input';
    else if (isError) error = `Wait failed with error / reason ${reason}`;
    else if (!success) error = `Children wait incomplete (reason: ${reason}, status: ${status})`;

    return {
      success,
      ended,
      reason,
      status,
      isTimeout,
      isBlocked,
      isError,
      details: waitData,
      output: res.stdout,
      error
    };
  }

  /**
   * Read screen output and history from a terminal (`hc read --lines <n> <target>`)
   */
  read(target, lines = 100, { timeout, snapshot = false } = {}) {
    const args = ['read', ...(snapshot ? ['--json'] : []), '--lines', String(lines), target];
    const res = this.exec(args, timeout === undefined ? {} : { timeout, killSignal: 'SIGKILL' });
    const data = snapshot ? this.parseJson(res.stdout) : null;
    const success = res.success && (!snapshot || typeof data?.text === 'string');
    return {
      success,
      target,
      content: snapshot ? data?.text : res.stdout,
      ...(snapshot ? { complete: data?.complete === true } : {}),
      isTimeout: res.error?.code === 'ETIMEDOUT',
      error: success ? null : (res.stderr || res.error?.message || (!snapshot && res.stdout) || 'Invalid terminal output')
    };
  }

  /** Capture the completed turn within the job's deadline and preserve a visible-screen fallback. */
  async captureTurn(target, expectedTurn, { deadlineMs, lines = 100, quietMs = 2000, identity = null }) {
    const timeout = () => ({ success: false, isTimeout: true, error: 'Job deadline expired during terminal capture.' });
    const remaining = () => deadlineMs - Date.now();
    let observedIdentity = identity;
    const checkTurn = () => {
      const budget = remaining();
      if (budget <= 0) return timeout();
      const probe = this.get(target, { timeout: Math.min(10000, budget) });
      if (remaining() <= 0 || probe.isTimeout) return timeout();
      const terminal = probe.details;
      const currentIdentity = terminalIdentity(terminal);
      if (!probe.success || terminal?.address !== target || !currentIdentity ||
          terminal.turn !== expectedTurn || !['done', 'idle'].includes(terminal.status?.state)) {
        return { success: false, error: `Terminal ${target} changed or could not verify Council turn ${expectedTurn} during capture.` };
      }
      if (observedIdentity && observedIdentity !== currentIdentity) return { success: false, error: `Terminal ${target} changed process before Council could save the capture.` };
      observedIdentity = currentIdentity;
      return null;
    };
    const readScreen = numberOfLines => {
      const budget = remaining();
      if (budget <= 0) return timeout();
      const read = this.read(target, numberOfLines, { timeout: budget, snapshot: true });
      if (remaining() <= 0 || read.isTimeout) return timeout();
      return checkTurn() ?? read;
    };

    const initialError = checkTurn();
    if (initialError) return initialError;
    let previous;
    let unchangedSince = Date.now();
    while (remaining() > 0) {
      const screen = readScreen(0);
      if (!screen.success) return screen;
      if (screen.content !== previous || !screen.complete) {
        previous = screen.content;
        unchangedSince = Date.now();
      }
      if (screen.complete && screen.content.trim() && Date.now() - unchangedSince >= quietMs) {
        if (lines === 0) return { ...screen, captureScope: 'screen' };
        const history = readScreen(lines);
        if (!history.success) return history;
        const current = readScreen(0);
        if (!current.success) return current;
        if (current.complete && current.content === screen.content) {
          return history.complete && history.content.trim()
            ? { ...history, captureScope: 'history' } : { ...current, captureScope: 'screen' };
        }
        previous = current.content;
        unchangedSince = Date.now();
      }
      const budget = remaining();
      if (budget > 0) await delay(Math.min(200, Math.max(1, quietMs), budget));
    }
    return timeout();
  }

  /**
   * Send text to a terminal, using Herdr's stdio API for large prompts.
   */
  send(target, message, options = {}) {
    const started = Date.now();
    const terminal = this.get(target, { timeout: Math.min(10000, options.timeout ?? 10000) });
    if (!terminal.success) return { success: false, attempted: false, target, error: terminal.error };
    const state = alignmentOf(terminal.details);
    if (state !== 'aligned') return { success: false, attempted: false, target, alignment: state, error: alignmentError(target, state) };
    const status = terminal.details.status?.state;
    if (options.expectedTurn != null) {
      if (terminal.details.turn !== options.expectedTurn || !['idle', 'done'].includes(status)) {
        return { success: false, attempted: false, target, error: `Terminal ${target} changed turns or became busy before delivery.` };
      }
    }

    const address = terminal.details.address;
    const requireIdle = options.expectedTurn != null && status === 'idle';
    const wait = Boolean(options.wait);
    const args = ['send', '--json', ...(requireIdle ? ['--if', 'idle'] : []), ...(wait ? ['--wait'] : []), '--', address];

    const timeout = (options.timeout ?? 90000) - (Date.now() - started);
    if (timeout <= 0) return { success: false, attempted: false, target, error: `The delivery deadline expired before Council sent to ${target}.` };
    const res = Buffer.byteLength(message) > maxInlinePromptBytes
      ? this.#sendThroughStdin({ terminal: address, text: message, caller: this.terminalId, if: requireIdle ? 'idle' : null, wait }, timeout)
      : this.exec([...args, message], { timeout });
    return {
      success: res.success,
      target,
      terminalIdentity: terminalIdentity(terminal.details),
      output: res.stdout,
      error: res.success ? null : (res.stderr || res.stdout || res.error?.message || `Herdr could not send to ${target}.`)
    };
  }

  #sendThroughStdin(params, timeout) {
    const request = { jsonrpc: '2.0', id: 1, method: 'terminal.send', params };
    const result = this.exec(['connect', '--json'], { input: JSON.stringify(request) + '\n', timeout });
    if (!result.success) return result;

    const reply = this.parseJson(result.stdout);
    const acknowledgement = reply?.result;
    if (reply?.jsonrpc !== '2.0' || reply.id !== request.id || !acknowledgement ||
        typeof acknowledgement !== 'object' || Array.isArray(acknowledgement) || reply.error) {
      return { success: false, stderr: reply?.error?.message || 'Herdr did not return a valid send reply.' };
    }
    return { success: true, stdout: JSON.stringify(acknowledgement) };
  }

  /**
   * Interrupt the current turn of a terminal without killing it (`hc interrupt <target>`)
   */
  interrupt(target) {
    const res = this.exec(['interrupt', target]);
    return {
      success: res.success,
      target,
      output: res.stdout,
      error: res.success ? null : (res.stderr || res.stdout)
    };
  }

  /**
   * Terminate and remove a terminal (`hc kill <target>` then `hc rm <target>`)
   */
  dismiss(target, { identity, turn } = {}) {
    if (identity) {
      const current = this.get(target).details;
      if (current?.address !== target || terminalIdentity(current) !== identity || current.turn !== turn ||
          !['done', 'idle'].includes(current.status.state) ||
          Object.values(current.records ?? {}).some(record => ['working', 'blocked'].includes(record.state))) {
        return { success: false, target, error: 'The terminal changed or still has active work.' };
      }
    }
    const killRes = this.exec(['kill', target]);
    const rmRes = this.exec(['rm', target]);
    return {
      success: killRes.success || rmRes.success,
      target,
      killOutput: killRes.stdout || killRes.stderr,
      rmOutput: rmRes.stdout || rmRes.stderr
    };
  }

  /** Stop an owned, completed team turn and confirm the program actually exited. */
  stopCompletedTeamTurn(target, { name, turn, identity }) {
    const current = this.get(target).details;
    const matches = details => Number.isFinite(identity?.createdMs) && Number.isSafeInteger(identity?.pid) &&
      details?.address === target && details.name === name && details.turn === turn &&
      details.created_ms === identity.createdMs && details.pid === identity.pid;
    const finished = details => matches(details) && details.state === 'finished' && Number.isFinite(details.finished_ms);
    if (finished(current)) {
      this.exec(['rm', target], { timeout: 10000 });
      return { success: true };
    }
    if (!matches(current) || current.state !== 'live' || current.status?.state !== 'done') {
      return { success: false, error: 'Herdr could not confirm the terminal still holds the completed turn.' };
    }
    if (Object.values(current.records ?? {}).some(record => ['working', 'blocked'].includes(record.state))) {
      return { success: false, error: 'The model still has active work inside its process.' };
    }
    const response = this.exec(['kill', '--json', target], { timeout: 10000 });
    const stopped = this.parseJson(response.stdout);
    if (!response.success || !finished(stopped)) {
      return { success: false, error: response.stderr || 'Herdr did not confirm that the model process stopped.' };
    }
    this.exec(['rm', target], { timeout: 10000 });
    return { success: true };
  }

  /**
   * Check environment health: hc CLI, Herdr daemon, and agent CLIs on PATH
   */
  doctor() {
    const report = {
      herdrInstalled: false,
      hcVersion: null,
      inHerdr: Boolean(this.terminalId),
      terminalId: this.terminalId,
      agents: {}
    };

    // Check hc CLI
    const v = this.version();
    if (v) {
      report.herdrInstalled = true;
      report.hcVersion = v;
    }

    // Check agent binaries on system
    const checks = [
      { name: 'claude', cmd: 'claude' },
      { name: 'codex', cmd: 'codex' },
      { name: 'antigravity', cmd: 'agy' },
      { name: 'junie', cmd: 'junie' }
    ];

    for (const item of checks) {
      const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [item.cmd], {
        encoding: 'utf8',
        windowsHide: true
      });
      report.agents[item.name] = {
        command: item.cmd,
        available: probe.status === 0,
        path: probe.status === 0 && probe.stdout ? probe.stdout.trim().split(/\r?\n/)[0] : null
      };
    }

    return report;
  }
}
