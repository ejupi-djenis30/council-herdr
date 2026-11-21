import { h_flex, v_flex } from 'gpui-base';
import { button, cardHeading, label, panel, reviewStatus, statusPill } from './components.js';

function timeText(timestamp) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

export function ballotBody(t, ballot) {
  const color = ballot.vote === 'approve' ? t.done : ballot.vote === 'reject' ? t.blocked : t.working;
  const [match, matchColor] = {
    match: ['Matches proposal', t.done],
    mismatch: ['Different proposal digest', t.blocked],
    missing: ['Proposal digest missing', t.working],
    invalid: ['Invalid proposal digest', t.blocked]
  }[ballot.proposalMatch] ?? ['Proposal match unavailable', t.muted];
  return v_flex().gap(5).w_full()
    .child(h_flex().gap(6).items_center().flex_wrap()
      .child(statusPill(t, `${ballot.vote} · ${ballot.score}/10`, color))
      .when(Boolean(ballot.round), row => row.child(label(`Round ${ballot.round}`, 11, t.muted)))
      .when(ballot.assigned === false, row => row.child(label('Unassigned voter', 11, t.muted)))
      .child(statusPill(t, match, matchColor)))
    .when(Boolean(ballot.rationale), col => col.child(label(ballot.rationale, 13, t.foreground)))
    .children((ballot.amendments ?? []).map(amendment => label(`• ${amendment}`, 13, t.foreground)));
}

const postTitles = {
  proposal: 'Proposal', reply: 'Reply', ballot: 'Ballot submitted'
};
const sources = { terminal: 'Terminal capture', draft: 'Unverified draft' };
const agentNames = new Map([['claude', 'Claude Code'], ['codex', 'Codex'], ['antigravity', 'Antigravity'], ['junie', 'Junie']]);

function post(t, message, copy) {
  const speaker = message.author === 'operator' ? 'You' : agentNames.get(message.agent) ?? (message.agent || message.author);
  const color = message.kind === 'proposal' ? t.accent : message.kind === 'ballot' ? t.working : t.done;
  const heading = h_flex().w_full().min_w_0().gap(6).items_center().flex_wrap()
    .child(label(speaker, 13, t.foreground).font_semibold())
    .when(Boolean(message.role), row => row.child(label(message.role, 11, t.muted)))
    .when(message.kind === 'message' && message.author !== 'operator' && speaker !== message.author,
      row => row.child(label(message.author, 11, t.muted)))
    .child(label(timeText(message.timestamp), 11, t.muted));
  const bubble = v_flex().gap(7).w_full().px(11).py(9).rounded(8).border_1().border_color(t.border)
    .bg(message.kind === 'proposal' ? t.selected : t.surface)
    .when(message.kind !== 'message', node => node.child(h_flex().gap(6).items_center().flex_wrap()
      .child(label(postTitles[message.kind], 11, color).font_semibold())
      .when(Boolean(sources[message.source]), row => row.child(label(sources[message.source], 11, t.muted)))))
    .child(message.ballot ? ballotBody(t, message.ballot) : label(message.body, 13, t.foreground))
    .when(message.truncated, col => col.child(h_flex().gap(6).items_center().flex_wrap()
      .child(label('Showing an excerpt.', 11, t.muted))
      .child(button(t, `copy-${message.id}`, 'Copy full text path', (_e, cx) => copy(cx, message.path)))));
  return h_flex().id(message.id).w_full().min_w_0().gap(9).items_start()
    .child(h_flex().size(31).flex_shrink_0().rounded(15).bg(t.selected).items_center().justify_center()
      .child(label(speaker.slice(0, 1).toUpperCase(), 13, color).font_semibold()))
    .child(v_flex().flex_1().min_w_0().gap(5).child(heading).child(bubble));
}

export function discussionView(t, debate, {
  project, openReview, copy, delivery, composer, startPoll, startClose, openPoll, copyDecision, closing, saving
}) {
  const header = panel(t)
    .child(h_flex().w_full().gap(8).items_center().justify_between()
      .child(statusPill(t, reviewStatus(debate.status), ['approved', 'open'].includes(debate.status) ? t.done : t.muted))
      .when(debate.mode !== 'debate', row => row.child(button(t, 'open-linked-review', 'View review', openReview, 'normal', false, 'reviews'))))
    .child(label(debate.task, 18, t.foreground).font_semibold())
    .child(label(project, 11, t.muted))
    .when(Boolean(delivery), node => node.child(delivery));
  if (debate.interactive) {
    header.child(h_flex().gap(6).flex_wrap()
      .child(button(t, 'start-linked-poll', 'Create poll', startPoll, 'normal', saving || Boolean(closing), 'polls'))
      .when(!debate.closedAt, row => row.child(
        button(t, 'start-debate-close', 'Close with decision', startClose, 'normal', saving || Boolean(closing), 'check'))));
  }
  const body = v_flex().w_full().gap(12).child(header);
  if (closing) body.child(closing);
  if (debate.decision) {
    const { decision, owner, nextStep } = debate.decision;
    const fields = [['Decision', decision], ['Owner', owner], ['Next step', nextStep]];
    body.child(panel(t)
      .child(h_flex().gap(6).justify_between().items_center().flex_wrap()
        .child(cardHeading(t, 'Recorded decision', 'check'))
        .child(button(t, 'copy-debate-decision', 'Copy decision', (_e, cx) => copyDecision(cx, [
          debate.task, `Debate ID: ${debate.id}`, ...fields.map(([title, value]) => `${title}: ${value}`)
        ].join('\n')), 'normal', false, 'copy')))
      .children(fields.map(([title, value]) => v_flex().gap(3)
        .child(label(title, 11, t.muted)).child(label(value, 13, t.foreground)))));
  }
  if (debate.polls?.length) body.child(panel(t)
    .child(cardHeading(t, 'Linked polls', 'polls'))
    .children(debate.polls.map(poll => h_flex().gap(8).items_center()
      .child(label(poll.question, 13, t.foreground).flex_1())
      .child(statusPill(t, poll.closedAt ? 'Closed' : 'Open', poll.closedAt ? t.muted : t.done))
      .child(button(t, `open-${poll.id}`, 'View poll', (_e, cx) => openPoll(cx, poll.id), 'normal', saving)))));
  if (!debate.messages.length) body.child(panel(t).child(label(debate.closedAt ? 'No replies were recorded.' : 'Waiting for replies.', 13, t.muted)));
  else body.children(debate.messages.map(message => post(t, message, copy)));
  if (composer) body.child(composer);
  return body;
}
