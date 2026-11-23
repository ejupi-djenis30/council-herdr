import { closeDebate, createDebate, readDebate, readDebateRoom, replyToDebate } from './debate-room.mjs';
import { terminalIdentity } from './alignment.mjs';
import { desktopRequest } from './desktop.mjs';
import { publishWithInvitations, readInvitationDelivery, runHerdrCommand } from './invitations.mjs';
import { PollStore } from './polls.mjs';

export function listThreads(cwd) {
  const { debates, errors } = desktopRequest(cwd, 'debates', {});
  return { debates: debates.filter(room => room.interactive), errors };
}

export function inspectThread(cwd, id) {
  const thread = readDebate(cwd, id);
  return { ...thread, polls: new PollStore(cwd).list({ sourceDebateId: id }).polls,
    invitationDelivery: readInvitationDelivery(cwd, id, { closed: Boolean(thread.closedAt) }) };
}

export function inspectPoll(cwd, id) {
  const poll = new PollStore(cwd).show(id);
  return { ...poll, invitationDelivery: readInvitationDelivery(cwd, id, { closed: Boolean(poll.closedAt) }) };
}

async function postingIdentity(address) {
  if (!address || address !== process.env.HC_TERMINAL_ID || !/^t[0-9a-z]+$/.test(address)) return null;
  const { ok, details } = await runHerdrCommand(['get', '--json', address], 1000);
  if (!ok || details?.address !== address || !terminalIdentity(details) ||
      details.created_ms > Math.ceil(performance.timeOrigin)) return null;
  return { address, agent: details.status.app, pid: details.pid, createdMs: details.created_ms };
}

export async function openThread(cwd, { question, context, author, recipients }) {
  const createdBy = process.env.HC_TERMINAL_ID || author;
  const identity = await postingIdentity(createdBy);
  return publishWithInvitations(cwd, recipients, ({ beforePublish }) =>
    createDebate(cwd, { question, context, createdBy }, { beforePublish, identity }));
}

export async function replyToThread(cwd, id, { author, text }) {
  const address = process.env.HC_TERMINAL_ID || author;
  const identity = await postingIdentity(address);
  return replyToDebate(cwd, id, { author: address, body: text }, { identity });
}

export async function closeThread(cwd, id, { author, decision, owner, nextStep }) {
  const address = process.env.HC_TERMINAL_ID || author;
  const identity = await postingIdentity(address);
  return closeDebate(cwd, id, { decision, owner, nextStep }, { author: address, identity });
}

export function openPoll(cwd, { question, mode, options, context, recipients, sourceDebateId }) {
  if (sourceDebateId !== undefined) readDebateRoom(cwd, sourceDebateId);
  return publishWithInvitations(cwd, recipients, ({ participants, beforePublish }) =>
    new PollStore(cwd).create({ question, mode, options, context, participants, createdBy: process.env.HC_TERMINAL_ID },
      { sourceDebateId, beforePublish }));
}
