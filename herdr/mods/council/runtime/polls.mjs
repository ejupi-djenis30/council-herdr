import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { debateIdPattern } from './debate-room.mjs';
import { appendEvent, eventFiles, isDirectory, readText } from './store-files.mjs';

const POLL_ID = /^poll-[0-9a-f-]{36}$/;
const VOTER_ID = /^[a-z0-9][a-z0-9_.:/-]{0,79}$/;
const MAX_PARTICIPANTS = 32;
const MODES = ['choice', 'mixed', 'open'];

function voterId(value, fromPanel = false) {
  const name = text(value, 'Voter', 80, true).toLowerCase();
  if (!VOTER_ID.test(name)) throw new Error('Use a terminal address or a voter ID such as reviewer-1.');
  if (name === 'operator' && !fromPanel) throw new Error('The operator ID is reserved for the desktop panel.');
  return name;
}
function text(value, label, max, required = false) {
  const result = value == null ? '' : typeof value === 'string' ? value.trim() : null;
  if (result === null || result.length > max || (required && !result)) {
    throw new Error(`${label} must contain ${required ? '1' : '0'}–${max} characters.`);
  }
  return result;
}

function nameKey(label) {
  return label.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function makeOption(label, options) {
  const name = text(label, 'Option', 120, true);
  if (options.length >= 20) throw new Error('A poll can have up to 20 options.');
  if (options.some(option => nameKey(option.label) === nameKey(name))) {
    throw new Error('That option already exists.');
  }
  return { id: `option-${options.length + 1}`, label: name };
}

function directoryEntries(dir) {
  return isDirectory(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
}

function applyEvent(poll, event) {
  if (!event || (event.type !== 'create' && (!poll || poll.closedAt))) {
    throw new Error('Unexpected event for the current poll state.');
  }
  switch (event.type) {
    case 'create':
      if (poll) throw new Error('Unexpected poll creation event.');
      return { ...event.poll, participants: event.poll.participants ?? [], responses: [], closedAt: null, outcome: '' };
    case 'track':
      poll.participants.push(event.participant);
      break;
    case 'untrack':
      poll.participants = poll.participants.filter(participant => participant.voter !== event.voter);
      break;
    case 'option':
      poll.options.push(event.option);
      break;
    case 'vote': {
      const index = poll.responses.findIndex(response => response.voter === event.response.voter);
      if (index === -1) poll.responses.push(event.response);
      else poll.responses[index] = event.response;
      break;
    }
    case 'close':
      poll.closedAt = event.at;
      poll.outcome = event.outcome;
      break;
    default:
      throw new Error('Unknown poll event.');
  }
  return poll;
}

function validSnapshot(poll, id) {
  return poll?.id === id && poll.schema === 'council.poll/v1' && MODES.includes(poll.mode) &&
    typeof poll.question === 'string' && typeof poll.createdAt === 'string' &&
    (poll.createdBy === undefined || (typeof poll.createdBy === 'string' && VOTER_ID.test(poll.createdBy))) &&
    (poll.sourceDebateId === undefined || (typeof poll.sourceDebateId === 'string' && debateIdPattern.test(poll.sourceDebateId))) &&
    Array.isArray(poll.options) && poll.options.every(option =>
      typeof option?.id === 'string' && typeof option.label === 'string') &&
    Array.isArray(poll.participants) && poll.participants.every(participant =>
      typeof participant?.voter === 'string' && VOTER_ID.test(participant.voter) && typeof participant.label === 'string') &&
    poll.responses.every(response =>
      typeof response?.voter === 'string' && VOTER_ID.test(response.voter) &&
      typeof response.optionId === 'string' && typeof response.answer === 'string' && typeof response.note === 'string');
}

function readPoll(base, id, sourceDebateId) {
  const dir = join(base, id);
  const events = eventFiles(dir);
  if (events.length === 0) return null;

  let poll;
  for (const [index, name] of events.entries()) {
    if (Number.parseInt(name, 10) !== index + 1) throw new Error(`Poll ${id} has a missing revision.`);
    const event = JSON.parse(readText(join(dir, name), 32 * 1024));
    if (index === 0 && sourceDebateId !== undefined && event?.poll?.sourceDebateId !== sourceDebateId) return null;
    poll = applyEvent(poll, event);
  }
  if (!validSnapshot(poll, id)) throw new Error(`Invalid poll record: ${id}.`);
  return { dir, poll, revision: events.length };
}

function summarize(poll) {
  const { id, question, mode, createdAt, createdBy, closedAt, responses, participants } = poll;
  const voters = new Set(responses.map(response => response.voter));
  return {
    id, question, mode, createdAt, closedAt, responseCount: responses.length,
    ...(typeof createdBy === 'string' && VOTER_ID.test(createdBy) ? { createdBy } : {}),
    ...(poll.sourceDebateId ? { sourceDebateId: poll.sourceDebateId } : {}),
    participation: {
      expected: participants.length,
      received: participants.filter(participant => voters.has(participant.voter)).length
    }
  };
}

function results(poll) {
  const counts = new Map();
  for (const response of poll.responses) {
    if (response.optionId) counts.set(response.optionId, (counts.get(response.optionId) ?? 0) + 1);
  }
  return {
    ...poll,
    ...summarize(poll),
    options: poll.options.map(option => ({ ...option, count: counts.get(option.id) ?? 0 })),
    freeCount: poll.responses.filter(response => response.answer).length
  };
}

export class PollStore {
  constructor(cwd) {
    this.workspace = join(cwd, '.agent_workspace');
    this.base = join(this.workspace, '.polls');
  }

  list({ sourceDebateId } = {}) {
    const polls = [];
    const errors = [];
    if (!isDirectory(this.workspace)) return { polls, errors };
    for (const entry of directoryEntries(this.base)) {
      if (!entry.isDirectory() || !POLL_ID.test(entry.name)) continue;
      try {
        const record = readPoll(this.base, entry.name, sourceDebateId);
        if (record) polls.push(summarize(record.poll));
      } catch (error) {
        errors.push({ id: entry.name, error: error.message });
      }
    }
    polls.sort((a, b) => Boolean(a.closedAt) - Boolean(b.closedAt) || b.createdAt.localeCompare(a.createdAt));
    return { polls, errors };
  }

  show(id) {
    const record = this.read(id);
    if (!record) throw new Error(`Poll ${id} was not found in this project.`);
    return results(record.poll);
  }

  create({ question, context, mode = 'choice', options = [], createdBy, participants }, { fromPanel = false, beforePublish, sourceDebateId } = {}) {
    if (sourceDebateId !== undefined && (typeof sourceDebateId !== 'string' || !debateIdPattern.test(sourceDebateId))) {
      throw new Error('Invalid source debate ID.');
    }
    if (!MODES.includes(mode)) throw new Error('Poll mode must be choice, mixed or open.');
    if (!Array.isArray(options)) throw new Error('Options must be an array.');
    if (mode === 'open' && options.length) throw new Error('A free-response poll takes no options.');
    if (mode !== 'open' && options.length < 2) throw new Error('Enter at least two options.');
    const poll = {
      schema: 'council.poll/v1',
      id: `poll-${randomUUID()}`,
      question: text(question, 'Question', 240, true),
      context: text(context, 'Context', 2000),
      mode,
      options: [],
      createdAt: new Date().toISOString(),
      ...(sourceDebateId ? { sourceDebateId } : {}),
      ...(createdBy ? { createdBy: voterId(createdBy, fromPanel) } : {})
    };
    for (const label of options) poll.options.push(makeOption(label, poll.options));
    if (fromPanel && Array.isArray(participants)) {
      if (beforePublish && participants.length > MAX_PARTICIPANTS) {
        throw new Error(`Select up to ${MAX_PARTICIPANTS} agents per poll.`);
      }
      const tracked = new Map();
      for (const { address: voter, label } of participants.slice(0, MAX_PARTICIPANTS)) {
        const name = voterId(voter);
        tracked.set(name, { voter: name, label: text(label, 'Participant label', 120) || name });
      }
      poll.participants = [...tracked.values()];
    }
    isDirectory(this.workspace, { create: true });
    isDirectory(this.base, { create: true });
    const dir = join(this.base, poll.id);
    mkdirSync(dir);
    const event = { type: 'create', poll };
    beforePublish?.(poll.id);
    appendEvent(dir, 1, event);
    return results(applyEvent(null, event));
  }

  update(id, nextEvent) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const record = this.read(id);
      if (!record) throw new Error(`Poll ${id} was not found in this project.`);
      if (record.poll.closedAt) throw new Error('This poll is closed.');
      const event = nextEvent(record.poll);
      if (!event) return results(record.poll);
      if (appendEvent(record.dir, record.revision + 1, event)) {
        return results(applyEvent(record.poll, event));
      }
    }
    throw new Error('The poll is being updated concurrently. Retry the operation.');
  }

  read(id) {
    if (typeof id !== 'string' || !POLL_ID.test(id)) throw new Error('Invalid poll ID.');
    if (!isDirectory(this.workspace) || !isDirectory(this.base)) return null;
    return readPoll(this.base, id);
  }

  track(id, { voter, label }) {
    const name = voterId(voter);
    const participant = { voter: name, label: text(label, 'Participant label', 120) || name };
    return this.update(id, poll => {
      if (poll.participants.some(item => item.voter === name)) return null;
      if (poll.participants.length >= MAX_PARTICIPANTS) throw new Error(`Track up to ${MAX_PARTICIPANTS} participants per poll.`);
      return { type: 'track', participant };
    });
  }

  untrack(id, voter) {
    const name = voterId(voter);
    return this.update(id, poll => poll.participants.some(item => item.voter === name)
      ? { type: 'untrack', voter: name }
      : null);
  }

  addOption(id, label) {
    return this.update(id, poll => {
      if (poll.mode === 'open') throw new Error('This poll accepts free responses only.');
      return { type: 'option', option: makeOption(label, poll.options) };
    });
  }

  vote(id, { voter, optionId, answer, note }, { fromPanel = false } = {}) {
    const name = voterId(voter, fromPanel);
    const option = text(optionId, 'Option ID', 20);
    const responseText = text(answer, 'Free response', 2000);
    const rationale = text(note, 'Rationale', 1000);
    if (Boolean(option) === Boolean(responseText)) throw new Error('Submit one option or one free response.');
    return this.update(id, poll => {
      if (option && !poll.options.some(item => item.id === option)) throw new Error('Unknown option ID.');
      if (responseText && poll.mode === 'choice') throw new Error('This poll accepts listed options only.');
      const previous = poll.responses.find(response => response.voter === name);
      if (previous?.optionId === option && previous?.answer === responseText && previous?.note === rationale) return null;
      return {
        type: 'vote',
        response: { voter: name, optionId: option, answer: responseText, note: rationale, submittedAt: new Date().toISOString() }
      };
    });
  }

  close(id, outcome) {
    const decision = text(outcome, 'Decision note', 2000);
    return this.update(id, () => ({ type: 'close', at: new Date().toISOString(), outcome: decision }));
  }
}
