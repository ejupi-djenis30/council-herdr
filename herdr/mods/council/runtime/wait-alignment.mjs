import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { alignmentOf } from './alignment.mjs';

const [bin, address, milliseconds] = process.argv.slice(2);
const deadline = Date.now() + Number(milliseconds);
const feed = spawn(bin, ['events', '--json', '--terminal', address], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
const lines = createInterface({ input: feed.stdout });
const stop = () => { lines.close(); feed.kill(); };
feed.on('error', stop);
const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
let outcome = { state: 'unconfirmed' };

try {
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const relevant = Array.isArray(event.terminals) || ['status', 'labels', 'turn', 'finished', 'lost'].includes(event.params?.type);
    if (!relevant || Date.now() >= deadline) continue;
    const probe = spawnSync(bin, ['get', '--json', address], { encoding: 'utf8', windowsHide: true, timeout: Math.max(1, Math.min(10000, deadline - Date.now())) });
    if (probe.status !== 0) break;
    let terminal;
    try { terminal = JSON.parse(probe.stdout); } catch { break; }
    const state = alignmentOf(terminal);
    const status = terminal?.status?.state;
    if (state === 'aligned' && ['idle', 'done'].includes(status)) {
      outcome = { state, turn: terminal.turn, pid: terminal.pid, createdMs: terminal.created_ms };
      break;
    }
    if (state === 'not_aligned' || terminal.state !== 'live' || ['blocked', 'error'].includes(status) ||
        (status === 'done' && terminal.turn > 0 && state !== 'aligned')) {
      outcome = { state: state === 'not_aligned' ? state : 'unconfirmed', terminalStatus: status };
      break;
    }
  }
} finally {
  clearTimeout(timer);
  stop();
}
console.log(JSON.stringify(outcome));
