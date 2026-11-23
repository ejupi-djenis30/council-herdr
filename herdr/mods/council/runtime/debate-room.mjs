import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, eventFiles, isDirectory, readText } from './store-files.mjs';

export const roomSchema = 'council.debate/v1';
export const debateIdPattern = /^debate-[0-9a-f-]{36}$/;
const messageFile = /^[0-9a-f-]{36}\.json$/;
const speakerId = /^[a-z0-9][a-z0-9_.:/-]{0,79}$/;

function requiredText(value, name, limit) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > limit) throw new Error(`${name} must contain 1–${limit} characters.`);
  return result;
}

function json(path) {
  const value = readText(path, 32 * 1024);
  return value === null ? null : JSON.parse(value);
}

function recordedIdentity(address, identity) {
  if (identity?.address !== address || !address || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
      !Number.isSafeInteger(identity.createdMs) || identity.createdMs <= 0 || typeof identity.agent !== 'string') return null;
  const agent = identity.agent.trim();
  if (!agent || agent.length > 80 || /[\u0000-\u001f\u007f]/.test(agent)) return null;
  return { address, agent, pid: identity.pid, createdMs: identity.createdMs };
}

export function createDebate(cwd, { question, context = '', createdBy }, { beforePublish, fromPanel = false, identity } = {}) {
  const title = requiredText(question, 'Debate topic', 240);
  const brief = context ? requiredText(context, 'Opening message', 2000) : '';
  const creator = fromPanel ? 'operator' : createdBy == null ? null : speaker(createdBy);
  const root = join(cwd, '.agent_workspace');
  isDirectory(root, { create: true });
  const id = `debate-${randomUUID()}`;
  const dir = join(root, id);
  mkdirSync(dir);
  mkdirSync(join(dir, 'messages'));
  const room = {
    $schema: roomSchema, sessionId: id, mode: 'debate', question: title, context: brief,
    createdAt: new Date().toISOString(), ...(creator ? { createdBy: creator, creatorIdentity: recordedIdentity(creator, identity) } : {})
  };
  beforePublish?.(id);
  writeFileSync(join(dir, 'session.json'), JSON.stringify(room), { flag: 'wx' });
  return { ...room, project: cwd };
}

function roomSnapshot(cwd, id) {
  if (typeof id !== 'string' || !debateIdPattern.test(id)) throw new Error('Invalid debate ID.');
  const root = join(cwd, '.agent_workspace');
  const dir = join(root, id);
  if (!isDirectory(root) || !isDirectory(dir)) throw new Error('Debate was not found in this project.');
  const room = json(join(dir, 'session.json'));
  if (room?.$schema !== roomSchema || room.sessionId !== id || room.mode !== 'debate' ||
      typeof room.question !== 'string' || !Number.isFinite(Date.parse(room.createdAt)) ||
      (room.createdBy !== undefined && (typeof room.createdBy !== 'string' || !speakerId.test(room.createdBy)))) {
    throw new Error('Debate is unavailable.');
  }
  if (Object.hasOwn(room, 'creatorIdentity')) room.creatorIdentity = recordedIdentity(room.createdBy, room.creatorIdentity);
  const events = join(dir, 'events');
  const revisions = eventFiles(events);
  if (revisions.some((name, index) => Number.parseInt(name, 10) !== index + 1)) {
    throw new Error('The debate has a missing revision.');
  }
  const last = revisions.length ? json(join(events, revisions.at(-1))) : null;
  if (revisions.length && !['reply', 'close'].includes(last?.type)) throw new Error('Invalid debate event.');
  const decision = last?.type === 'close' ? last.decision : null;
  if (last?.type === 'close' && (!decision || !['decision', 'owner', 'nextStep'].every(
    key => typeof decision[key] === 'string' && decision[key].trim()) ||
    !(Date.parse(decision.closedAt) >= Date.parse(room.createdAt)))) {
    throw new Error('Invalid debate decision.');
  }
  if (decision && Object.hasOwn(decision, 'closedByIdentity')) {
    decision.closedByIdentity = recordedIdentity(decision.closedBy, decision.closedByIdentity);
  }
  return { dir, events, revisions, room: { ...room, decision, closedAt: decision?.closedAt ?? null } };
}

export function readDebateRoom(cwd, id) {
  return roomSnapshot(cwd, id).room;
}

export function readDebate(cwd, id) {
  const { dir, events, revisions, room } = roomSnapshot(cwd, id);
  const messages = room.context ? [{
    id: 'opening', kind: 'message', author: room.createdBy || 'agent', timestamp: room.createdAt, body: room.context,
    ...(Object.hasOwn(room, 'creatorIdentity') ? { authorIdentity: room.creatorIdentity, agent: room.creatorIdentity?.agent } : {})
  }] : [];
  function add(message) {
    if (message?.sessionId === id && typeof message.id === 'string' && messageFile.test(`${message.id}.json`) &&
        typeof message.author === 'string' && speakerId.test(message.author) &&
        typeof message.body === 'string' && message.body.length <= 2000 &&
        Date.parse(message.timestamp) >= Date.parse(room.createdAt)) {
      const { author, body, timestamp } = message;
      const identity = recordedIdentity(author, message.authorIdentity);
      messages.push({ id: message.id, kind: 'message', author, body, timestamp,
        ...(Object.hasOwn(message, 'authorIdentity') ? { authorIdentity: identity, agent: identity?.agent } : {}) });
    }
  }
  for (const revision of revisions) {
    const event = json(join(events, revision));
    if (event?.type === 'reply') add(event.message);
  }
  const legacy = join(dir, 'messages');
  if (isDirectory(legacy)) {
    for (const entry of readdirSync(legacy, { withFileTypes: true })) {
      if (!entry.isFile() || !messageFile.test(entry.name)) continue;
      try {
        const message = json(join(legacy, entry.name));
        if (message?.id !== entry.name.slice(0, -5) ||
            (room.closedAt && !(Date.parse(message.timestamp) <= Date.parse(room.closedAt)))) continue;
        add(message);
      } catch {
        // Keep the rest of the discussion readable when a legacy reply is malformed.
      }
    }
  }
  messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
    (a.id === 'opening' ? -1 : b.id === 'opening' ? 1 : a.id.localeCompare(b.id)));
  return { ...room, messages };
}

function updateRoom(cwd, id, next) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const { room, events, revisions } = roomSnapshot(cwd, id);
    const event = next(room);
    if (!event) return room.decision;
    isDirectory(events, { create: true });
    if (appendEvent(events, revisions.length + 1, event)) return event.message ?? event.decision;
  }
  throw new Error('The debate is being updated concurrently. Retry the operation.');
}

function speaker(author, fromPanel = false) {
  const sender = requiredText(author, 'Your Herdr terminal address', 80).toLowerCase();
  if (!speakerId.test(sender) || (sender === 'operator' && !fromPanel)) throw new Error('Use your own Herdr terminal address.');
  return sender;
}

export function replyToDebate(cwd, id, { author, body }, { fromPanel = false, identity } = {}) {
  const sender = speaker(author, fromPanel);
  const content = requiredText(body, 'Reply', 2000);
  return updateRoom(cwd, id, room => {
    if (room.closedAt) throw new Error('This debate is closed.');
    return { type: 'reply', message: {
      id: randomUUID(), sessionId: id, author: sender, authorIdentity: recordedIdentity(sender, identity), body: content,
      timestamp: new Date(Math.max(Date.now(), Date.parse(room.createdAt))).toISOString()
    } };
  });
}

export function closeDebate(cwd, id, { decision, owner, nextStep }, { author, fromPanel = false, identity } = {}) {
  const closedBy = speaker(fromPanel ? 'operator' : author, fromPanel);
  const outcome = {
    decision: requiredText(decision, 'Decision', 2000),
    owner: requiredText(owner, 'Owner', 120),
    nextStep: requiredText(nextStep, 'Next step', 2000)
  };
  return updateRoom(cwd, id, room => {
    if (room.decision) {
      if (Object.keys(outcome).every(key => outcome[key] === room.decision[key])) return null;
      throw new Error('This debate already has a recorded decision.');
    }
    return { type: 'close', decision: {
      ...outcome, closedAt: new Date(Math.max(Date.now(), Date.parse(room.createdAt))).toISOString(),
      closedBy, closedByIdentity: recordedIdentity(closedBy, identity)
    } };
  });
}
