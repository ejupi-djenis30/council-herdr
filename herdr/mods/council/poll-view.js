import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { button, columns, label, panel, progress, statusDot, statusPill } from './components.js';
import { countLabel, responseValue } from './poll-text.js';

const liveStatuses = { working: 'Working', blocked: 'Needs you', done: 'Done', idle: 'Idle' };

function agentLabel(agent) {
  return agent.tab_name && !/^\d+$/.test(agent.tab_name) ? agent.tab_name
    : agent.program?.name || agent.app || agent.address;
}

function participantHeading(t, name, id, live) {
  const status = liveStatuses[live?.status] ?? 'Terminal unavailable';
  return v_flex().flex_1().min_w_0().gap(3)
    .child(label(name, 13, t.foreground).font_medium())
    .child(h_flex().gap(5).items_center()
      .child(statusDot(t[live?.status] ?? t.dim))
      .child(label(`${id} · ${status}`, 11, t.muted)));
}

export function pollParticipants(t, poll, liveAgents, saving, actions, wide) {
  const { participants, participation, responses } = poll;
  const agentsById = new Map(liveAgents.map(agent => [agent.address, agent]));
  const trackedIds = new Set(participants.map(participant => participant.voter));
  const voters = new Set(responses.map(response => response.voter));
  const available = liveAgents.filter(agent => !trackedIds.has(agent.address));
  const showCandidates = !poll.closedAt && (available.length > 0 || participants.length === 0);
  const inlineActions = wide && !showCandidates;
  const tracked = panel(t)
    .child(h_flex().items_center().justify_between().gap(8)
      .child(label('Tracked agents', 14, t.foreground).font_semibold())
      .when(participation.expected > 0, node => node.child(
        statusPill(t, `${participation.received}/${participation.expected} responded`, t.accent))));

  if (participants.length === 0) {
    tracked.child(label(poll.closedAt ? 'This poll had no tracked agents.' : 'Track agents in this space to see whose response is pending.', 12, t.muted));
  }
  for (const participant of participants) {
    const live = agentsById.get(participant.voter);
    const responded = voters.has(participant.voter);
    const status = statusPill(t, responded ? 'Responded' : poll.closedAt ? 'No response' : 'Pending',
      responded ? t.done : poll.closedAt ? t.muted : t.working);
    const controls = h_flex().gap(5).flex_wrap()
      .when(Boolean(live), row => row.child(button(t, `focus-${participant.voter}`, 'Open terminal',
        (_e, cx) => actions.focus(cx, participant.voter))))
      .when(!poll.closedAt, row => row
        .child(button(t, `invite-${participant.voter}`, 'Copy invite', (_e, cx) => actions.invite(cx, participant)))
        .child(button(t, `untrack-${participant.voter}`, 'Untrack',
          (_e, cx) => actions.untrack(cx, participant.voter), 'normal', saving)));
    const heading = h_flex().items_center().gap(9).min_w_0().flex_1()
      .child(participantHeading(t, participant.label, participant.voter, live)).child(status);
    const row = inlineActions ? h_flex().items_center() : v_flex();
    tracked.child(row.w_full().gap(9).pt(9).border_t_1().border_color(t.border)
      .child(heading).when(Boolean(live || !poll.closedAt), node => node.child(controls)));
  }
  if (!showCandidates) return tracked;

  const candidates = panel(t).child(label('Agents in this space', 14, t.foreground).font_semibold());
  if (!available.length) candidates.child(label('Agents with a Herdr status appear here when they are running in this space.', 12, t.muted));
  for (const agent of available) {
    const name = agentLabel(agent);
    candidates.child(h_flex().w_full().items_center().gap(8).pt(8).border_t_1().border_color(t.border)
      .child(participantHeading(t, name, agent.address, agent))
      .child(button(t, `track-${agent.address}`, '+ Track', (_e, cx) => actions.track(cx, {
        voter: agent.address, label: name.slice(0, 120)
      }), 'normal', saving)));
  }
  return wide ? columns(true, candidates, tracked, 252) : columns(false, tracked, candidates);
}

export function pollResults(t, poll, wide) {
  let tally;
  if (poll.options.length) {
    tally = panel(t).gap(12).child(label('Vote breakdown', 14, t.foreground).font_semibold());
    for (const option of poll.options) tally.child(progress(t, option.label, option.count, poll.responseCount));
    if (poll.mode === 'mixed') tally.child(progress(t, 'Free responses', poll.freeCount, poll.responseCount, t.ansi5));
  }
  const responses = panel(t)
    .child(h_flex().justify_between().items_center().gap(8)
      .child(label('Responses', 14, t.foreground).font_semibold())
      .child(label(countLabel(poll.responseCount, 'response'), 11, t.muted)));
  const participants = new Map(poll.participants.map(participant => [participant.voter, participant.label]));
  if (!poll.responses.length) responses.child(label(poll.closedAt
    ? 'No responses were recorded.' : 'Responses appear here after someone votes.', 12, t.muted));
  for (const response of poll.responses) {
    const name = response.voter === 'operator' ? 'Panel operator' : participants.get(response.voter);
    responses.child(v_flex().w_full().gap(4).pt(8).border_t_1().border_color(t.border)
      .child(h_flex().items_center().gap(6)
        .child(div().w(3).h(12).bg(response.answer ? t.ansi5 : t.accent).rounded(2).flex_shrink_0())
        .child(label(name ?? response.voter, 12, t.accent).font_semibold())
        .when(Boolean(name && name !== response.voter && response.voter !== 'operator'),
          row => row.child(label(response.voter, 11, t.muted))))
      .child(label(responseValue(poll, response), 13, t.foreground))
      .when(Boolean(response.note), node => node.child(label(response.note, 12, t.muted))));
  }
  return tally ? columns(wide, tally, responses) : responses;
}
