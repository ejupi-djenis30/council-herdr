import { parseArgs } from 'node:util';
import { inspectThread, listThreads, openThread, replyToThread } from './agent-discussion.mjs';
import { closeDebate } from './debate-room.mjs';

const help = `Usage:
  council debate list
  council debate create --question "..." [--context "..."] [--author <terminal-address>] [--invite <address> ...]
  council debate show <debate-id>
  council debate reply <debate-id> --text "..." [--author <terminal-address>]
  council debate close <debate-id> --decision "..." --owner "..." --next-step "..." [--author <terminal-address>]

Run from the debate project. The creator and reply author use HC_TERMINAL_ID by default.`;

export function runDebateCommand(args, cwd = process.cwd()) {
  const [action = 'help', ...rest] = args;
  if (['help', '--help', '-h'].includes(action)) return help;
  if (action === 'list' && !rest.length) return listThreads(cwd);
  if (action === 'create') {
    const { values } = parseArgs({ args: rest, options: {
      question: { type: 'string' }, context: { type: 'string' }, author: { type: 'string' },
      invite: { type: 'string', multiple: true }
    } });
    return openThread(cwd, { ...values, recipients: values.invite });
  }
  if (!['show', 'reply', 'close'].includes(action)) throw new Error('Run council debate help for usage.');
  const string = { type: 'string' };
  const options = { show: {}, reply: { text: string, author: string },
    close: { decision: string, owner: string, 'next-step': string, author: string } }[action];
  const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options });
  if (positionals.length !== 1) throw new Error('A debate ID is required.');
  const [id] = positionals;
  if (action === 'show') return inspectThread(cwd, id);
  const author = process.env.HC_TERMINAL_ID || values.author;
  if (action === 'close') return closeDebate(cwd, id, { ...values, nextStep: values['next-step'] }, { author });
  return replyToThread(cwd, id, values);
}
