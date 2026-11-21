import { h_flex, v_flex } from 'gpui-base';
import { button, cardHeading, columns, label, panel, statusPill } from './components.js';

const statuses = {
  starting: ['Starting', 'working', 'active'],
  attempting: ['Sending task', 'working', 'active'],
  deliberating: ['In progress', 'working', 'active'],
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

export function delegationView(t, job, { wide, terminal, focus, copy }) {
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
  const delivery = panel(t).child(cardHeading(t, 'Delivery record', 'delegations'))
    .child(detail(t, 'Participant', route || 'Awaiting a terminal'))
    .when(Boolean(job.team?.role), node => node.child(detail(t, 'Team role', job.team.role)))
    .when(Boolean(job.team?.power), node => node.child(detail(t, 'Model process', {
      starting: 'Starting', on: 'Started', stopping: 'Stopping', off: 'Off', unconfirmed: 'Needs attention'
    }[job.team.power] ?? 'Unknown')))
    .child(detail(t, 'Task delivery', deliveries[job.deliveryState] ?? 'Unavailable'))
    .when(job.remainingSec !== null, node => node.child(detail(t, 'Deadline', duration(job.remainingSec))))
    .when(job.expired && job.status === 'uncertain', node => node.child(detail(t, 'Deadline', 'Elapsed')))
    .when(Boolean(job.workerAddress), node => node.child(detail(t, 'Worker', job.workerAddress)))
    .when(wait.length > 0, node => node.child(detail(t, 'Last wait event', wait.join(' · '))));
  return v_flex().w_full().gap(10).child(header).child(columns(wide, delivery, evidence(t, job, { copy })));
}
