import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { terminalIdentity } from '../herdr/mods/council/runtime/alignment.mjs';

export async function followBlockedTurn(lines, { target, blockedTurn, identity, onProgress }) {
  const failed = reason => ({ success: false, error: `Could not verify approval continuation on ${target}. ${reason}` });
  let turn = blockedTurn;
  let status;
  let app;
  let pending;

  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { return failed('Herdr returned an invalid event.'); }
    if (app === undefined) {
      const terminal = event?.terminals?.find?.(entry => entry.address === target);
      status = terminal?.status?.state;
      if (!identity || terminalIdentity(terminal) !== identity || terminal.turn !== turn || status !== 'blocked') {
        return failed('The terminal or turn changed before Council could observe it.');
      }
      app = terminal.status.app;
      onProgress({ status, turn });
      continue;
    }
    if (Array.isArray(event?.terminals)) return failed('The event stream restarted before completion.');

    const update = event?.params;
    if (event?.method !== 'event' || update?.terminal !== target) continue;
    if (['finished', 'lost', 'removed', 'restarted'].includes(update.type)) {
      return failed('The terminal exited or restarted.');
    }
    if (update.type === 'status') {
      const next = update.data?.status;
      if (update.data?.reported !== true || next?.app !== app || !['working', 'blocked', 'done'].includes(next.state)) {
        return failed('The agent stopped or changed before finishing.');
      }
      if (next.state === pending || (!pending && next.state === status)) continue;
      if (pending || (next.state !== 'working' && status !== 'working')) {
        return failed('The recorded status skipped a required transition.');
      }
      if (next.state === 'working') {
        status = 'working';
        onProgress({ status, turn });
      } else {
        pending = next.state;
      }
    }
    if (update.type === 'turn') {
      if (!pending || update.data?.state !== pending || update.data?.turn !== turn + 1) {
        return failed('The recorded turn did not follow the paused assignment.');
      }
      turn = update.data.turn;
      status = pending;
      pending = null;
      if (status === 'done') return { success: true, turn, status };
      onProgress({ status, turn });
    }
  }
  return failed('The Herdr event stream closed before completion.');
}

export async function watchBlockedTurn({ bin, cwd, deadlineMs, ...options }) {
  const expired = () => ({ success: false, isTimeout: true, error: 'Job deadline expired while following the paused turn.' });
  if (Date.now() >= deadlineMs) return expired();

  const feed = spawn(bin, ['events', '--json', '--terminal', options.target], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
  });
  const lines = createInterface({ input: feed.stdout });
  let spawnError;
  feed.on('error', error => { spawnError = error; lines.close(); });
  const timer = setTimeout(() => lines.close(), Math.min(deadlineMs - Date.now(), 2 ** 31 - 1));
  try {
    const result = await followBlockedTurn(lines, options);
    if (Date.now() >= deadlineMs) return expired();
    if (spawnError) return { success: false, error: `Could not watch Herdr events for ${options.target}. ${spawnError.message}` };
    return result;
  } finally {
    clearTimeout(timer);
    lines.close();
    feed.kill();
  }
}
