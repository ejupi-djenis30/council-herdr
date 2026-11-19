import { desktopRequest } from './desktop.mjs';
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
    case undefined:
    case 'help':
    case '--help':
      result = runPollCommand([]);
      break;
    default:
      throw new Error('Use council.mjs poll help to list the available commands.');
  }
  console.log(typeof result === 'string' ? result : JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
