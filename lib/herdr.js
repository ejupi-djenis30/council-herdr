import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { buildHcRunArgs, normalizeAgentName } from './recipes.js';

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
  get(target) {
    const res = this.exec(['get', target]);
    if (!res.success) {
      return { success: false, error: res.stderr || res.stdout || `Failed to get terminal ${target}` };
    }
    const parsed = this.parseJson(res.stdout);
    return {
      success: true,
      details: parsed || res.stdout
    };
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
    sessionDir = null
  }) {
    const targetCwd = resolve(cwd || this.cwd);
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

    const hcArgs = buildHcRunArgs({
      name,
      cwd: targetCwd,
      agent,
      permission,
      task: taskPrompt
    });

    // Ensure --json and --outlive-parent are passed to hc run
    if (!hcArgs.includes('--json')) {
      const runIdx = hcArgs.indexOf('run');
      if (runIdx !== -1) {
        hcArgs.splice(runIdx + 1, 0, '--json');
      }
    }
    if (!hcArgs.includes('--outlive-parent')) {
      const runIdx = hcArgs.indexOf('run');
      if (runIdx !== -1) {
        hcArgs.splice(runIdx + 1, 0, '--outlive-parent');
      }
    }

    const res = this.exec(hcArgs, { cwd: targetCwd });
    if (!res.success) {
      return {
        success: false,
        name,
        address: null,
        error: res.stderr || res.stdout || `Failed to launch ${name} in Herdr`
      };
    }

    const data = this.parseJson(res.stdout);
    const address = data?.address || null;

    return {
      success: true,
      name,
      address,
      agent: normalizeAgentName(agent),
      permission,
      cwd: targetCwd,
      details: data,
      output: res.stdout
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
    const args = ['send'];
    if (options.wait) args.push('--wait');
    args.push(target, message);

    const res = this.exec(args);
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
