import { parseArgs } from 'node:util';
import { readDebate, replyToDebate } from './debate-room.mjs';

const help = `Usage:
  council debate show <debate-id>
  council debate reply <debate-id> --text "..." [--author <terminal-address>]

Run from the debate project. Replies use HC_TERMINAL_ID by default.`;

export function runDebateCommand(args, cwd = process.cwd()) {
  const [action = 'help', ...rest] = args;
  if (['help', '--help', '-h'].includes(action)) return help;
  if (!['show', 'reply'].includes(action)) throw new Error('Run council debate help for usage.');
  const options = action === 'reply' ? { text: { type: 'string' }, author: { type: 'string' } } : {};
  const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options });
  if (positionals.length !== 1) throw new Error('A debate ID is required.');
  const [id] = positionals;
  if (action === 'show') return readDebate(cwd, id);
  return replyToDebate(cwd, id, { author: values.author ?? process.env.HC_TERMINAL_ID, body: values.text });
}
