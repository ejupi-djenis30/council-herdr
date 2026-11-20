import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { reportAlignment } from './alignment.mjs';
import { runDebateCommand } from './debate-command.mjs';
import { desktopRequest } from './desktop.mjs';
import { sendInvitations } from './invitations.mjs';
import { runPollCommand } from './poll-command.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  let result;
  switch (command) {
    case 'desktop': {
      const [action, payload] = args;
      result = desktopRequest(process.cwd(), action, JSON.parse(payload ?? '{}'));
      break;
    }
    case 'poll':
      result = runPollCommand(args);
      break;
    case 'debate':
      result = runDebateCommand(args);
      break;
    case 'invite':
      const request = args[0]?.startsWith('{') ? JSON.parse(args[0]) : { id: args[0] };
      await sendInvitations(process.cwd(), fileURLToPath(import.meta.url), request);
      result = { success: true };
      break;
    case 'alignment': {
      if (args[0] !== 'decline') throw new Error('Use alignment decline to report missing setup.');
      const exec = (argv, options) => {
        const call = spawnSync('hc', argv, { encoding: 'utf8', windowsHide: true, timeout: options?.timeout ?? 10000 });
        return { success: call.status === 0, stdout: call.stdout, stderr: call.stderr };
      };
      const get = address => {
        const call = exec(['get', '--json', address]);
        return { success: call.success, details: call.success ? JSON.parse(call.stdout) : null };
      };
      result = reportAlignment({ terminalId: process.env.HC_TERMINAL_ID, get, exec }, { state: 'not_aligned' });
      break;
    }
    case undefined:
    case 'help':
    case '--help':
      result = runPollCommand([]);
      break;
    default:
      throw new Error('Use council.mjs poll help or debate help.');
  }
  console.log(typeof result === 'string' ? result : JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
