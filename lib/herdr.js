import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
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
   * If brief is multiline, writes it to a file first as recommended by Herdr rules.
   */
  launchAgent({ name, agent, permission = 'read', cwd = null, task = '', context = '' }) {
    const targetCwd = resolve(cwd || this.cwd);
    let taskPrompt = task;

    // Check if task is long or multi-line: write to brief file to prevent CLI escaping issues
    if (task.includes('\n') || task.length > 250 || context) {
      const councilDir = join(targetCwd, '.council', 'briefs');
      if (!existsSync(councilDir)) {
        mkdirSync(councilDir, { recursive: true });
      }
      const briefFile = join(councilDir, `brief-${name}.md`);
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
        this.terminalId
          ? `When done or blocked, report your summary using: hc send ${this.terminalId} "<summary>"`
          : 'When done, provide a clear, concise conclusion.'
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

    const res = this.exec(hcArgs, { cwd: targetCwd });
    if (!res.success) {
      return {
        success: false,
        name,
        error: res.stderr || res.stdout || `Failed to launch ${name} in Herdr`
      };
    }

    return {
      success: true,
      name,
      agent: normalizeAgentName(agent),
      permission,
      cwd: targetCwd,
      output: res.stdout
    };
  }

  /**
   * Wait on a specific terminal until its turn finishes or it exits (`hc wait <target>`)
   */
  wait(target, options = {}) {
    const args = ['wait', target];
    if (options.timeoutSec) {
      args.push('--timeout', String(options.timeoutSec));
    }
    const res = this.exec(args);
    return {
      success: res.success,
      target,
      output: res.stdout,
      error: res.success ? null : (res.stderr || res.stdout)
    };
  }

  /**
   * Wait for all child terminals spawned by this session (`hc wait --children all`)
   */
  waitAllChildren(options = {}) {
    const args = ['wait', '--children', 'all'];
    if (options.timeoutSec) {
      args.push('--timeout', String(options.timeoutSec));
    }
    const res = this.exec(args);
    return {
      success: res.success,
      output: res.stdout,
      error: res.success ? null : (res.stderr || res.stdout)
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
