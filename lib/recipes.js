/**
 * Council Agent Recipes for Herdr
 * Safe launch configurations tested and optimized for Windows & Herdr terminal core (`hc`).
 */

export const SUPPORTED_AGENTS = ['claude', 'codex', 'antigravity', 'agy', 'junie'];

export const AGENT_ALIASES = {
  'claude': 'claude',
  'claude-code': 'claude',
  'codex': 'codex',
  'openai-codex': 'codex',
  'antigravity': 'antigravity',
  'agy': 'antigravity',
  'junie': 'junie'
};

/**
 * Normalize an agent alias to canonical name ('claude', 'codex', 'antigravity', 'junie')
 */
export function normalizeAgentName(name) {
  if (!name || typeof name !== 'string') return 'claude';
  const clean = name.trim().toLowerCase();
  return AGENT_ALIASES[clean] || clean;
}

/**
 * Builds the exact command and arguments array for an agent under Herdr.
 * Note: Under Herdr, all agent commands are passed after `--` to prevent hc from parsing agent flags:
 * `hc run --bg --name <n> --cwd <dir> -- <agent-command-elements>`
 *
 * @param {string} agent - Canonical or alias agent name
 * @param {string} permission - 'read' (plan / review / read-only) or 'write' (acceptEdits / edit)
 * @param {string} task - Brief instruction or pointer to brief file
 * @returns {string[]} Array of command arguments to pass after `--`
 */
export function buildAgentLaunchArgs(agent, permission = 'read', task = '', model = '') {
  const norm = normalizeAgentName(agent);
  const isWrite = permission === 'write';

  switch (norm) {
    case 'claude':
      // Claude Code Windows recipe
      return [
        'claude',
        '--permission-mode',
        isWrite ? 'acceptEdits' : 'plan',
        ...(model ? ['--model', model] : []),
        task
      ];

    case 'codex':
      // Codex must always have --no-daemon under Herdr so commands run inside hc
      return [
        'codex',
        '--no-daemon',
        '-s',
        isWrite ? 'workspace-write' : 'read-only',
        '-a',
        'never',
        ...(model ? ['--model', model] : []),
        task
      ];

    case 'antigravity':
      // Antigravity CLI takes task as the value of -i right before task
      return [
        'agy',
        '--mode',
        isWrite ? 'accept-edits' : 'plan',
        '-i',
        task
      ];

    case 'junie':
      // Bare junie text runs non-interactively and exits. Use --prompt= to stay interactive.
      if (isWrite) {
        return ['junie', `--prompt=${task}`];
      }
      return ['junie', '--plan', `--prompt=${task}`];

    default:
      // Fallback for custom or unrecognized agents
      return [norm, task];
  }
}

/**
 * Formats full `hc run` arguments array for spawning an agent in Herdr.
 *
 * @param {Object} options
 * @param {string} options.name - Terminal name (e.g. 'council-author')
 * @param {string} options.cwd - Working directory
 * @param {string} options.agent - Agent name
 * @param {string} options.permission - 'read' or 'write'
 * @param {string} options.task - Initial task string (or pointer to brief)
 * @returns {string[]} Arguments array for `hc`
 */
export function buildHcRunArgs({ name, cwd, agent, permission = 'read', task = '', outliveParent = true, model = '', managedTeam = false }) {
  const agentArgs = buildAgentLaunchArgs(agent, permission, task, model);
  return [
    'run',
    '--bg',
    ...(outliveParent ? ['--outlive-parent'] : []),
    ...(managedTeam ? ['--no-notify'] : []),
    '--name',
    name,
    '--cwd',
    cwd,
    '--',
    ...agentArgs
  ];
}
