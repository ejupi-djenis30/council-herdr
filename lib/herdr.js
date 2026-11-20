import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHcRunArgs, normalizeAgentName } from './recipes.js';
import { alignmentChallenge, alignmentError, alignmentNotice, alignmentOf } from '../herdr/mods/council/runtime/alignment.mjs';

const waitAlignment = fileURLToPath(new URL('../herdr/mods/council/runtime/wait-alignment.mjs', import.meta.url));
const cliEntry = fileURLToPath(new URL('../bin/council.js', import.meta.url));

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
      return { success: false, error: res.stderr || res.stdout || `Failed to get terminal ${target}` };
    }
    const parsed = this.parseJson(res.stdout);
    return {
      success: true,
      details: parsed || res.stdout
    };
  }

  requestAlignment(target, { refresh = false } = {}) {
    const current = this.get(target);
    if (!current.success) return;
    const alignment = alignmentOf(current.details);
    if (alignment === 'aligned' || (alignment === 'not_aligned' && !refresh)) return;
    const status = current.details?.status?.state;
    if (!['idle', 'done'].includes(status)) return;
    const guard = status === 'idle' ? ['--if', 'idle'] : [];
    const address = current.details.address;
    const challenge = alignmentChallenge(current.details);
    if (challenge.argument && !this.exec(['label', address, challenge.argument], { timeout: 10000 }).success) return;
    this.exec(['send', '--json', ...guard, address, alignmentNotice(cliEntry, challenge)], { timeout: 12000 });
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
    alignmentTimeoutSec = 90
  }) {
    const targetCwd = resolve(cwd || this.cwd);
    const start = Date.now();
    const limit = Math.max(1, Math.ceil(alignmentTimeoutSec * 1000));
    const challenge = alignmentChallenge();
    const hcArgs = buildHcRunArgs({ name, cwd: targetCwd, agent, permission, task: alignmentNotice(cliEntry, challenge) });
    hcArgs.splice(1, 0, '--json', '--label', challenge.argument);
    const res = this.exec(hcArgs, { cwd: targetCwd, timeout: limit });
    const data = this.parseJson(res.stdout);
    const address = data?.address || null;
    if (!res.success || !address) {
      return { success: false, name, address, error: res.stderr || res.stdout || `Failed to launch ${name} in Herdr` };
    }
    const state = this.waitForAlignment(address, Math.max(1, limit - (Date.now() - start)));
    if (state.state !== 'aligned' || !Number.isSafeInteger(state.turn)) {
      return { success: false, name, address, error: alignmentError(address, state.state), alignment: state.state };
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
        this.terminalId
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
      alignment: 'aligned',
      error: sent ? null : (delivery.error || `Task delivery to ${address} was not acknowledged.`),
      details: { ...data, first_message: { sent, ...(ack ?? {}) } },
      output: delivery.output
    };
  }

  /**
   * Wait on a specific terminal until its turn finishes or it exits (`hc wait --json <target>`)
   */
  wait(target, options = {}) {
    const args = ['wait', '--json', target];
    if (options.timeoutSec) {
      args.push('--timeout', String(options.timeoutSec));
    }
    const res = this.exec(args);
    const waitData = this.parseJson(res.stdout);

    if (!res.success || !waitData || typeof waitData !== 'object') {
      return {
        success: false,
        target,
        terminal: target,
        ended: null,
        exitCode: null,
        reason: null,
        status: null,
        turn: null,
        isTimeout: false,
        isBlocked: false,
        isError: true,
        isDone: false,
        details: null,
        output: res.stdout,
        error: res.stderr || res.stdout || 'Invalid or malformed wait response'
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
  read(target, lines = 100) {
    const res = this.exec(['read', '--lines', String(lines), target]);
    return {
      success: res.success,
      target,
      content: res.stdout,
      error: res.success ? null : (res.stderr || res.stdout)
    };
  }

  /**
   * Send text / prompt to a terminal (`hc send <target> "<message>"`)
   */
  send(target, message, options = {}) {
    const started = Date.now();
    const terminal = this.get(target, { timeout: Math.min(10000, options.timeout ?? 10000) });
    const state = alignmentOf(terminal.details);
    if (state !== 'aligned') return { success: false, target, alignment: state, error: alignmentError(target, state) };
    const args = ['send', '--json'];
    if (options.expectedTurn != null) {
      const status = terminal.details.status?.state;
      if (terminal.details.turn !== options.expectedTurn || !['idle', 'done'].includes(status)) {
        return { success: false, target, error: `Terminal ${target} changed turns or became busy before delivery.` };
      }
      if (status === 'idle') args.push('--if', 'idle');
    }
    if (options.wait) args.push('--wait');
    args.push(terminal.details.address, message);

    const timeout = (options.timeout ?? 90000) - (Date.now() - started);
    if (timeout <= 0) return { success: false, target, error: `The delivery deadline expired before Council sent to ${target}.` };
    const res = this.exec(args, { timeout });
    return {
      success: res.success,
      target,
      output: res.stdout,
      error: res.success ? null : (res.stderr || res.stdout)
    };
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
  dismiss(target) {
    const killRes = this.exec(['kill', target]);
    const rmRes = this.exec(['rm', target]);
    return {
      success: killRes.success || rmRes.success,
      target,
      killOutput: killRes.stdout || killRes.stderr,
      rmOutput: rmRes.stdout || rmRes.stderr
    };
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
