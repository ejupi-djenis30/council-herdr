import { parseArgs } from 'node:util';
import { PollStore } from './polls.mjs';

const HELP = `Usage:
  council poll list
  council poll show <poll-id>
  council poll create --question "..." [--context "..."] [--mode choice|mixed|open] [--option "..." --option "..."]
  council poll add-option <poll-id> --label "..."
  council poll track <poll-id> --voter <id> [--label "..."]
  council poll untrack <poll-id> --voter <id>
  council poll vote <poll-id> [--voter <id>] (--option <option-id> | --answer "...") [--note "..."]
  council poll close <poll-id> [--outcome "..."]

Run from the same project directory. Voting defaults to HC_TERMINAL_ID when available.
Polls collect advisory responses and decisions.`;

const flags = {
  create: { question: { type: 'string' }, context: { type: 'string' }, mode: { type: 'string' }, option: { type: 'string', multiple: true } },
  'add-option': { label: { type: 'string' } },
  track: { voter: { type: 'string' }, label: { type: 'string' } },
  untrack: { voter: { type: 'string' } },
  vote: { voter: { type: 'string' }, option: { type: 'string' }, answer: { type: 'string' }, note: { type: 'string' } },
  close: { outcome: { type: 'string' } },
  list: {},
  show: {}
};

export function runPollCommand(args, cwd = process.cwd()) {
  const [action = 'help', ...rest] = args;
  if (['help', '--help', '-h'].includes(action)) return HELP;
  if (!Object.hasOwn(flags, action)) throw new Error(`Unknown poll command: ${action}. Run council poll help.`);
  const { values, positionals } = parseArgs({ args: rest, options: flags[action], allowPositionals: true });
  const needsId = !['list', 'create'].includes(action);
  if (positionals.length !== Number(needsId)) throw new Error(`Run council poll help for ${action} usage.`);
  const [id] = positionals;
  const store = new PollStore(cwd);

  switch (action) {
    case 'list': return store.list();
    case 'show': return store.show(id);
    case 'create': return store.create({ ...values, options: values.option });
    case 'add-option': return store.addOption(id, values.label);
    case 'track': return store.track(id, values);
    case 'untrack': return store.untrack(id, values.voter);
    case 'vote': return store.vote(id, { ...values, optionId: values.option, voter: values.voter ?? process.env.HC_TERMINAL_ID });
    case 'close': return store.close(id, values.outcome);
  }
}
