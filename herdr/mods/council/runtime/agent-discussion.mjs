import { createDebate, readDebate, readDebateRoom } from './debate-room.mjs';
import { desktopRequest } from './desktop.mjs';
import { publishWithInvitations, readInvitationDelivery } from './invitations.mjs';
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

export function openThread(cwd, { question, context, author, recipients }) {
  const createdBy = process.env.HC_TERMINAL_ID || author;
  return publishWithInvitations(cwd, recipients, ({ beforePublish }) =>
    createDebate(cwd, { question, context, createdBy }, { beforePublish }));
}

export function openPoll(cwd, { question, mode, options, context, recipients, sourceDebateId }) {
  if (sourceDebateId !== undefined) readDebateRoom(cwd, sourceDebateId);
  return publishWithInvitations(cwd, recipients, ({ participants, beforePublish }) =>
    new PollStore(cwd).create({ question, mode, options, context, participants, createdBy: process.env.HC_TERMINAL_ID },
      { sourceDebateId, beforePublish }));
}
