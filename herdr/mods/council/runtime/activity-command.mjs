import { parseArgs } from 'node:util';
import { reportProgress } from './activity.mjs';
import { desktopRequest } from './desktop.mjs';

const help = `Usage:
  council activity
  council activity --session <id>
  council activity report --session <id> --text "..." [--state working|blocked|handoff] [--component <id>] [--request-id <id>]

Run from the project directory. Activity reads local Council records, PLAN.md, and Git.
Reports are saved as notes and do not change the session's recorded outcome.`;

export function runActivityCommand(args, cwd = process.cwd()) {
  if (['help', '--help', '-h'].includes(args[0])) return help;
  const report = args[0] === 'report';
  const { values } = parseArgs({ args: report ? args.slice(1) : args, options: {
    session: { type: 'string' },
    ...(report ? { text: { type: 'string' }, state: { type: 'string' }, component: { type: 'string' },
      'request-id': { type: 'string' } } : {})
  } });
  if (report) return reportProgress(cwd, { ...values, sessionId: values.session, requestId: values['request-id'] }, process.env.HC_TERMINAL_ID);
  const result = desktopRequest(cwd, 'activity', { id: values.session });
  if (values.session && !result.delegation) throw new Error('Delegation not found in this project.');
  return result;
}
