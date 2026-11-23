import { h_flex, v_flex } from 'gpui-base';
import { button, cardHeading, columns, label, panel, statusDot, statusPill } from './components.js';

const statuses = {
  starting: ['Starting', 'working', 'active'],
  attempting: ['Sending task', 'working', 'active'],
  deliberating: ['In progress', 'working', 'active'],
  awaiting_input: ['Waiting for input', 'blocked', 'attention'],
  worker_stopped: ['Worker stopped', 'blocked', 'attention'],
  completed: ['Result ready', 'done', 'ready'],
  uncertain: ['Delivery uncertain', 'blocked', 'attention'],
  timed_out: ['Deadline expired', 'blocked', 'attention'],
  blocked: ['Agent blocked', 'blocked', 'attention'],
  dispatch_failed: ['Dispatch failed', 'blocked', 'attention'],
  failed: ['Failed', 'blocked', 'attention'],
  invalid: ['Record incomplete', 'blocked', 'attention']
};

const deliveries = {
  planned: 'Planned',
  attempting: 'Attempting',
  acknowledged: 'Acknowledged',
  uncertain: 'Uncertain',
  failed: 'Failed'
};

export function delegationStatus(t, state) {
  const [title, color, group] = statuses[state] ?? statuses.invalid;
  return { title, color: t[color], group };
}

function detail(t, title, value) {
  return v_flex().w_full().gap(3).pt(8).border_t_1().border_color(t.border)
    .child(label(title, 11, t.muted)).child(label(value, 13, t.foreground));
}

function duration(seconds) {
  if (seconds < 60) return `${seconds}s remaining`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s remaining`;
}

function evidence(t, job, actions) {
  const card = panel(t).child(cardHeading(t, 'Terminal capture', 'terminal'));
  if (job.output === null) {
    const recovery = {
      dispatch_failed: 'The worker did not claim this job. Inspect the recorded dispatch error.',
      failed: 'Use the recorded error and the terminal to diagnose this attempt.',
      invalid: 'Check the session record with the Council CLI before relying on this result.'
    }[job.status];
    return card.child(label(job.nextAction ?? recovery ?? 'The terminal capture appears here when Council saves the result.', 13, t.muted));
  }

  const controls = h_flex().gap(6).flex_wrap()
    .when(Boolean(job.output), row => row.child(button(t, 'delegate-copy-output',
      job.outputTruncated ? 'Copy excerpt' : 'Copy capture',
      (_event, cx) => actions.copy(cx, job.output, 'Terminal capture copied.'), 'normal', false, 'copy')))
    .when(Boolean(job.outputPath), row => row.child(button(t, 'delegate-copy-path', 'Copy file path',
      (_event, cx) => actions.copy(cx, job.outputPath, 'Capture path copied.'), 'normal', false, 'copy')));
  return card.child(controls)
    .child(label(job.output || 'The saved terminal capture is empty.', 12, job.output ? t.foreground : t.muted)
      .p(10).rounded(6).border_1().border_color(t.border).bg(t.background))
    .when(job.outputTruncated, node => node.child(label('Showing an excerpt. The full capture is available via Council result.', 12, t.muted)));
}

const milestones = {
  scheduled: ['Call saved', 'muted'], claimed: ['Worker claimed job', 'accent'],
  dispatched: ['Delivery attempt began', 'working'], terminal: ['Terminal recorded', 'accent'],
  delivered: ['Delivery acknowledged', 'working'], captured: ['Result archived', 'done'],
  stopping: ['Stopping model process', 'working'], off: ['Process confirmed off', 'done'],
  unconfirmed: ['Shutdown unconfirmed', 'blocked'], dispatch_failed: ['Worker dispatch failed', 'blocked'],
  blocked: ['Agent blocked', 'blocked'], failed: ['Run failed', 'blocked'], uncertain: ['Delivery uncertain', 'blocked'],
  invalid: ['Record incomplete', 'blocked'], timed_out: ['Deadline elapsed', 'blocked'],
  wait_timed_out: ['Wait timed out', 'blocked']
};

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function stamp(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = part => String(part).padStart(2, '0');
  return `${date.getDate()} ${months[date.getMonth()]} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function runTrail(t, job) {
  const card = panel(t).child(cardHeading(t, 'Run timeline', 'activity'));
  if (job.timeline.history === 'summary') card.child(label('Summary from the saved job record', 11, t.muted));
  for (const item of job.timeline.entries) {
    const [title, color] = milestones[item.kind];
    card.child(h_flex().gap(8).items_center().px(7).py(5).rounded(5).bg(t.background)
      .child(statusDot(t[color]))
      .child(label([title, item.text].filter(Boolean).join(' · '), 12, t.foreground).flex_1())
      .when(Boolean(item.at), row => row.child(label(stamp(item.at), 11, t.muted))));
  }
  return card;
}

function handoffTrail(t, related, open) {
  const edge = (kind, item) => button(t, `run-link-${kind}-${item.id}`, item.member ? `${item.member} · ${item.id}` : item.id,
    (_e, cx) => open(cx, item.id), 'normal', false, 'right').tooltip(delegationStatus(t, item.status).title);
  return panel(t).child(cardHeading(t, 'Team handoffs', 'team'))
    .when(Boolean(related.parent), node => node.child(h_flex().gap(7).items_center().flex_wrap()
      .child(label('Called by', 11, t.muted)).child(edge('parent', related.parent))))
    .when(related.children.length > 0, node => node.child(v_flex().gap(5)
      .child(label('Calls made from this run', 11, t.muted))
      .child(h_flex().gap(6).flex_wrap().children(related.children.map(item => edge('child', item))))));
}

function reports(t, job, actions) {
  const { count, notes, unreadable } = job.progress;
  return panel(t).child(h_flex().gap(7).items_center().justify_between().flex_wrap()
    .child(cardHeading(t, 'Reported updates', 'activity'))
    .when(!actions.composer, row => row.child(button(t, 'new-progress-note', 'Add update', actions.addNote, 'normal', false, 'add'))))
    .when(Boolean(actions.composer), node => node.child(actions.composer))
    .when(notes.length === 0, node => node.child(label('No progress updates recorded.', 12, t.muted)))
    .when(unreadable > 0, node => node.child(label('Some progress notes could not be read.', 12, t.blocked)))
    .when(count > notes.length + unreadable, node => node.child(label(`Showing the most recent ${notes.length} of ${count} updates.`, 11, t.muted)))
    .children([...notes].reverse().map((note, index) => v_flex().id(`reported-update-${index}`).gap(4).pt(7)
      .border_t_1().border_color(t.border)
      .child(label([note.state, note.component, note.reporter, stamp(note.at)].filter(Boolean).join(' · '), 11, t.accent))
      .child(label(note.text, 12, t.foreground))));
}

export function delegationView(t, job, { wide, terminal, focus, open, copy, addNote, composer }) {
  const status = delegationStatus(t, job.status);
  const header = panel(t)
    .child(h_flex().justify_between().items_center().gap(8)
      .child(statusPill(t, status.title, status.color))
      .child(label(job.id, 11, t.muted).truncate()))
    .child(label(job.task, 19, t.foreground).font_semibold())
    .when(Boolean(job.error), node => node.child(label(job.error, 13, t.blocked)))
    .when(Boolean(job.team?.error), node => node.child(label(job.team.error, 13, t.blocked)))
    .child(h_flex().gap(6).flex_wrap()
      .when(Boolean(terminal), row => row.child(button(t, 'delegate-terminal', 'Open terminal',
        (_event, cx) => focus(cx, job.address), 'primary', false, 'terminal')))
      .child(button(t, 'delegate-copy-id', 'Copy session ID', (_event, cx) => copy(cx, job.id, 'Session ID copied.'), 'normal', false, 'copy')));

  const wait = [job.wait.reason, job.wait.status, job.wait.turn === null ? null : `Turn ${job.wait.turn}`].filter(Boolean);
  const ownership = job.ownership === 'borrowed' ? 'Existing terminal' : job.ownership === 'owned' ? 'Council terminal' : null;
  const program = terminal?.program?.name || terminal?.app || job.agent;
  const route = [program, job.address, ownership].filter(Boolean).join(' · ');
  const workerState = { live: 'Running', stopped: 'Stopped', unknown: 'Status unavailable' }[job.workerObservation?.state];
  const worker = [job.workerAddress, workerState, job.workerObservation?.retainedClaim ? 'Session claim retained' : null]
    .filter(Boolean).join(' · ');
  const delivery = panel(t).child(cardHeading(t, 'Delivery record', 'delegations'))
    .child(detail(t, 'Participant', route || 'Awaiting a terminal'))
    .when(Boolean(job.team?.role), node => node.child(detail(t, 'Team role', job.team.role)))
    .when(Boolean(job.team?.power), node => node.child(detail(t, 'Model process', {
      starting: 'Starting', on: 'Started', stopping: 'Stopping', off: 'Off', unconfirmed: 'Needs attention'
    }[job.team.power] ?? 'Unknown')))
    .child(detail(t, 'Task delivery', deliveries[job.deliveryState] ?? 'Unavailable'))
    .when(job.remainingSec !== null, node => node.child(detail(t, 'Deadline', duration(job.remainingSec))))
    .when(job.expired && ['uncertain', 'worker_stopped'].includes(job.status), node => node.child(detail(t, 'Deadline', 'Elapsed')))
    .when(Boolean(worker), node => node.child(detail(t, 'Worker', worker)))
    .when(wait.length > 0, node => node.child(detail(t, 'Last wait event', wait.join(' · '))));
  const context = v_flex().gap(8).child(runTrail(t, job)).child(delivery);
  const results = v_flex().gap(8)
    .when(Boolean(job.related?.parent || job.related?.children.length), node => node.child(handoffTrail(t, job.related, open)))
    .child(reports(t, job, { addNote, composer })).child(evidence(t, job, { copy }));
  return v_flex().w_full().gap(10).child(header).child(columns(wide, context, results));
}
