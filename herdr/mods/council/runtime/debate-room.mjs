import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectory, readText } from './store-files.mjs';

export const roomSchema = 'council.debate/v1';
const roomId = /^debate-[0-9a-f-]{36}$/;
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

export function createDebate(cwd, { question, context = '' }, { beforePublish } = {}) {
  const title = requiredText(question, 'Debate topic', 240);
  const brief = context ? requiredText(context, 'Opening message', 2000) : '';
  const root = join(cwd, '.agent_workspace');
  isDirectory(root, { create: true });
  const id = `debate-${randomUUID()}`;
  const dir = join(root, id);
  mkdirSync(dir);
  mkdirSync(join(dir, 'messages'));
  const room = {
    $schema: roomSchema, sessionId: id, mode: 'debate', question: title, context: brief,
    createdAt: new Date().toISOString(), createdBy: 'operator'
  };
  beforePublish?.(id);
  writeFileSync(join(dir, 'session.json'), JSON.stringify(room), { flag: 'wx' });
  return room;
}

export function roomMessages(dir, room) {
  const dirPath = join(dir, 'messages');
  const messages = room.context ? [{
    id: 'opening', kind: 'message', author: 'operator', timestamp: room.createdAt, body: room.context
  }] : [];
  if (!isDirectory(dirPath)) return messages;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile() || !messageFile.test(entry.name)) continue;
    try {
      const message = json(join(dirPath, entry.name));
      if (message?.id !== entry.name.slice(0, -5) || message.sessionId !== room.sessionId ||
          typeof message.author !== 'string' || !speakerId.test(message.author) ||
          typeof message.body !== 'string' || message.body.length > 2000 ||
          !(Date.parse(message.timestamp) >= Date.parse(room.createdAt))) continue;
      messages.push({ id: message.id, kind: 'message', author: message.author, body: message.body, timestamp: message.timestamp });
    } catch {
      // A malformed message does not hide other replies.
    }
  }
  return messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
    (a.id === 'opening' ? -1 : b.id === 'opening' ? 1 : a.id.localeCompare(b.id)));
}

export function readDebateRoom(cwd, id) {
  if (typeof id !== 'string' || !roomId.test(id)) throw new Error('Invalid debate ID.');
  const root = join(cwd, '.agent_workspace');
  const dir = join(root, id);
  if (!isDirectory(root) || !isDirectory(dir)) throw new Error('Debate was not found in this project.');
  const room = json(join(dir, 'session.json'));
  if (room?.$schema !== roomSchema || room.sessionId !== id || room.mode !== 'debate' ||
      typeof room.question !== 'string' || !Number.isFinite(Date.parse(room.createdAt))) throw new Error('Debate is unavailable.');
  return room;
}

export function readDebate(cwd, id) {
  const room = readDebateRoom(cwd, id);
  return { ...room, messages: roomMessages(join(cwd, '.agent_workspace', id), room) };
}

export function replyToDebate(cwd, id, { author, body }, { fromPanel = false } = {}) {
  const sender = requiredText(author, 'Your Herdr terminal address', 80).toLowerCase();
  if (!speakerId.test(sender) || (sender === 'operator' && !fromPanel)) throw new Error('Use your own Herdr terminal address.');
  const content = requiredText(body, 'Reply', 2000);
  readDebateRoom(cwd, id);
  const dir = join(cwd, '.agent_workspace', id, 'messages');
  isDirectory(dir, { create: true });
  const message = {
    id: randomUUID(), sessionId: id, author: sender, body: content, timestamp: new Date().toISOString()
  };
  const temporary = join(dir, `.${message.id}.tmp`);
  writeFileSync(temporary, JSON.stringify(message), { flag: 'wx' });
  renameSync(temporary, join(dir, `${message.id}.json`));
  return message;
}
