import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';

const fileLimit = 180;
const pathLimit = 480;
const slash = value => value.replaceAll('\\', '/');

function git(cwd, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  return spawnSync('git', ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd, windowsHide: true, encoding: 'utf8', timeout: 1800, maxBuffer: 1024 * 1024,
    env
  });
}

function position(path) {
  return path.length <= pathLimit && !path.split('/').some(part => part === '..' || part === '.agent_workspace') &&
    !/[\u0000-\u001f\u007f]/.test(path) ? path : null;
}

export function parseGitStatus(output, prefix = '') {
  const rows = output.split('\0');
  const branch = rows[0]?.startsWith('## ') ? rows.shift().slice(3).split('...')[0] : null;
  const files = [];
  let total = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || row[2] !== ' ') continue;
    const flag = row.slice(0, 2);
    const path = row.slice(3);
    const old = /[RC]/.test(flag) ? rows[++index] : null;
    if (prefix && !path.startsWith(prefix)) continue;
    const local = position(path.slice(prefix.length));
    if (!local) continue;
    total++;
    if (files.length >= fileLimit) continue;
    files.push({ path: local, flag, previous: old && old.startsWith(prefix) ? position(old.slice(prefix.length)) : null });
  }
  return { branch, files, total, clipped: total > files.length };
}

function worktrees(output) {
  const trees = [];
  for (const row of output.split('\0')) {
    if (row.startsWith('worktree ')) {
      if (trees.length >= 12) break;
      trees.push({ folder: row.slice(9), branch: null, revision: null });
    } else if (trees.length && row.startsWith('branch refs/heads/')) trees.at(-1).branch = row.slice(18);
    else if (trees.length && row.startsWith('HEAD ')) trees.at(-1).revision = row.slice(5, 13);
  }
  return trees;
}

export function inspectGitRoot(cwd) {
  const head = git(cwd, ['rev-parse', '--show-toplevel']);
  if (head.status !== 0) {
    return { root: null, reason: head.error?.code === 'ENOENT' ? 'git-missing'
      : head.error || !head.stderr.includes('not a git repository') ? 'unavailable' : 'no-repository' };
  }
  return { root: head.stdout.replace(/\r?\n$/, '') };
}

export function readGitActivity(cwd, probe = inspectGitRoot(cwd)) {
  const { root, reason } = probe;
  if (!root) return { available: false, reason, files: [], total: 0 };
  const subpath = slash(relative(root, cwd));
  const prefix = subpath ? `${subpath}/` : '';
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--no-ahead-behind',
    '--ignore-submodules=all', '--untracked-files=normal', '--', '.']);
  const list = git(cwd, ['worktree', 'list', '--porcelain', '-z']);
  const log = git(cwd, ['log', '-5', '--no-show-signature', '--format=%h%x00%ct%x00%s', '--', '.']);
  const commits = log.status === 0 ? log.stdout.trimEnd().split(/\r?\n/).filter(Boolean).map(row => {
    const [revision, time, subject] = row.split('\0');
    return { revision, time: Number(time) * 1000, subject: subject?.slice(0, 240) ?? '' };
  }) : [];
  return {
    available: true, root, statusAvailable: status.status === 0,
    statusIssue: status.status === 0 ? null : status.error?.code === 'ETIMEDOUT' ? 'Git status exceeded its time limit.'
      : status.error?.code === 'ENOBUFS' ? 'Git status exceeded the overview size limit.' : 'Git status did not return a result.',
    ...parseGitStatus(status.status === 0 ? status.stdout : '', prefix),
    worktrees: list.status === 0 ? worktrees(list.stdout) : [], commits
  };
}
