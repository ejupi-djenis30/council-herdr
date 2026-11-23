import { h_flex, v_flex } from 'gpui-base';
import { button, cardHeading, field, input, label, panel, statusPill } from './components.js';
import { projectLabels } from './poll-text.js';
import { prepareSchedule, submitSchedule } from './schedule-launch.js';
import { taskFormDefaults, taskFormValues, workflowModes } from './task-launch.js';
import { workflowFields } from './team-view.js';

const states = {
  scheduled: 'Scheduled', starting: 'Starting', dispatching: 'Dispatching run',
  worker_stopped: 'Scheduler stopped', dispatch_uncertain: 'Dispatch unconfirmed',
  cancelled: 'Cancelled', finished: 'Finished', failed: 'Scheduler failed'
};

function badge(t, item) {
  const state = item.state;
  const color = state === 'finished' ? t.done : ['worker_stopped', 'dispatch_uncertain', 'failed'].includes(state) ? t.blocked : t.muted;
  return statusPill(t, states[state] || state, color);
}

const modeName = mode => workflowModes.find(([id]) => id === mode)?.[1] || mode;
const cadence = item => item.everySec == null ? 'Once' :
  `Every ${item.everySec} s · ${item.count == null ? 'Until cancelled' : item.count + (item.count === 1 ? ' run' : ' runs')}`;

export function newSchedule(view, cx, project) {
  const { fields, extra } = taskFormDefaults();
  view.setForm('schedule', { ...fields, firstRun: '', interval: '86400', runs: '2' }, {
    ...extra, project, repeating: false, id: `schedule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  });
  cx.notify();
}

export function changeSchedule(view, cx, action, runCli) {
  if (view.saving || !['create', 'resume', 'cancel'].includes(action)) return;
  const form = view.form;
  let target = view.data?.schedule;
  let project = view.selected?.project;
  let draft;
  if (action === 'create') {
    if (form?.kind !== 'schedule') return;
    project = form.project;
    draft = { id: form.id, firstRun: form.firstRun.value().trim() || form.immediateAt || '',
      repeating: form.repeating, interval: form.interval.value(), runs: form.runs.value(), task: taskFormValues(form) };
  } else if (!target || target.id !== view.selected?.id ||
      (action === 'resume' && target.state !== 'worker_stopped') ||
      (action === 'cancel' && ['finished', 'cancelled'].includes(target.state))) return;
  if (!project) return;
  const engine = view.engine;
  view.saving = true;
  view.loading = false;
  view.error = '';
  const epoch = ++view.epoch;
  cx.notify();
  cx.spawn(async cx => {
    try {
      if (draft) {
        target = await prepareSchedule(draft, timing => view.request(project, 'schedule-timing', timing, engine));
        if (view.epoch !== epoch) return;
        // Pin the project and immediate start time before dispatch so retries use the same definition.
        if (!draft.firstRun) form.immediateAt = target.at;
        form.submitted = true;
      }
      await submitSchedule(action, target, args => runCli(project, args), id => view.request(project, 'schedules', { id }, engine));
      if (view.epoch === epoch) view.navigate(cx, 'schedules', { id: target.id, project }, { returnTo: view.workspaceReturn });
    } catch (error) {
      if (view.epoch === epoch) view.error = error.message;
    } finally {
      if (view.epoch === epoch) {
        view.saving = false;
        view.refresh(cx);
        cx.notify();
      }
    }
  });
}

function scheduleForm(t, view, act) {
  const { form, saving } = view;
  return panel(t).child(cardHeading(t, 'New schedule', 'schedules'))
    .child(label(form.project, 12, t.muted))
    .child(workflowFields(t, form, saving))
    .child(field(t, 'First run', form.firstRun))
    .child(label('Use YYYY-MM-DD HH:mm in the project machine’s time zone, or include an ISO offset. Leave blank to start immediately.', 11, t.muted))
    .child(h_flex().gap(5).flex_wrap().children([[false, 'Once'], [true, 'Repeat']].map(([repeat, title]) =>
      button(t, 'schedule-repeat-' + repeat, title, (_e, cx) => { form.repeating = repeat; cx.notify(); },
        form.repeating === repeat ? 'active' : 'normal', saving))))
    .when(form.repeating, node => node.child(field(t, 'Interval (seconds)', form.interval))
      .child(field(t, 'Number of runs (blank to repeat until cancelled)', form.runs)))
    .child(h_flex().gap(6).flex_wrap()
      .child(button(t, 'create-schedule', 'Create schedule', (_e, cx) => act(cx, 'create'), 'primary', saving))
      .child(button(t, 'dismiss-schedule', 'Cancel', (_e, cx) => view.cancelForm(cx), 'normal', saving)));
}

function scheduleDetail(t, view, act) {
  const item = view.data?.schedule;
  if (!item) return label('This schedule is unavailable in this project.', 12, t.muted);
  const { project } = view.selected;
  const terminal = item.workerAddress;
  const observation = item.workerObservation;
  const finished = ['finished', 'cancelled'].includes(item.state);
  const body = v_flex().gap(8);
  const detail = panel(t).child(cardHeading(t, item.job.task, 'schedules'))
    .child(h_flex().gap(6).items_center().flex_wrap().child(badge(t, item)).child(label(modeName(item.job.mode || 'delegate'), 12, t.muted)))
    .child(label(project, 12, t.muted)).child(label(item.id, 12, t.muted))
    .child(label(`${cadence(item)} · First run ${item.atLocal || item.at}`, 12, t.foreground))
    .when(!finished && Boolean(item.nextAt), node => node.child(label(`Scheduled slot ${item.index + 1} · ${item.nextAtLocal || item.nextAt}`, 12, t.foreground)))
    .when(Boolean(terminal || observation), node => node.child(label(['Scheduler', terminal, observation?.state,
      observation?.exitCode != null ? 'exit ' + observation.exitCode : null].filter(Boolean).join(' · '), 12, t.muted)))
    .when(Boolean(item.error), node => node.child(label(item.error, 12, t.blocked)))
    .when(Boolean(item.nextAction), node => node.child(label(item.nextAction, 12, t.foreground)));
  if (!finished) detail.child(h_flex().gap(6).flex_wrap()
    .when(item.state === 'worker_stopped', node => node.child(button(t, 'resume-schedule', 'Resume schedule', (_e, cx) => act(cx, 'resume'), 'primary', view.saving)))
    .child(button(t, 'cancel-schedule', 'Cancel future runs', (_e, cx) => act(cx, 'cancel'), 'normal', view.saving)));
  body.child(detail);
  const runs = panel(t).child(cardHeading(t, 'Occurrences', 'delegations'));
  if (item.lastJob?.error || item.lastJob?.nextAction) runs
    .child(label('Latest dispatch · ' + item.lastJob.sessionId, 12, t.muted))
    .when(Boolean(item.lastJob.error), node => node.child(label(item.lastJob.error, 12, t.blocked)))
    .when(Boolean(item.lastJob.nextAction), node => node.child(label(item.lastJob.nextAction, 12, t.foreground)));
  const limit = view.selected.occurrenceLimit || 12;
  if (!item.occurrences.length) runs.child(label('No occurrence has a saved run yet.', 12, t.muted));
  for (const run of item.occurrences.slice(0, limit)) {
    runs.child(h_flex().gap(6).items_center().flex_wrap()
      .child(button(t, 'occurrence-' + run.slot, 'Open run ' + run.slot, (_e, cx) =>
        view.openLinked(cx, 'delegations', { id: run.id, project })))
      .child(label(run.id, 11, t.muted)));
  }
  if (item.occurrences.length > limit) runs.child(h_flex().child(button(t, 'more-occurrences', 'Show more runs', (_e, cx) => {
    view.selected.occurrenceLimit = limit + 12;
    cx.notify();
  })));
  return body.child(runs);
}

export function renderSchedules(t, view, act) {
  if (view.form?.kind === 'schedule') return scheduleForm(t, view, act);
  if (view.selected) return scheduleDetail(t, view, act);
  const items = view.data?.schedules || [];
  const origins = projectLabels(items.map(item => item.project));
  const query = view.search.value().trim().toLowerCase();
  const visible = items.filter(item => [item.id, item.question, item.project, item.mode, states[item.state]].some(text => text?.toLowerCase().includes(query)));
  const body = v_flex().gap(8);
  if (view.listProject) body.child(label(view.listProject, 12, t.muted));
  else body.child(h_flex().gap(6).flex_wrap().children([[false, 'This space'], [true, view.engine?.machine ? 'All spaces on this machine' : 'All local spaces']].map(([all, title]) =>
    button(t, 'schedule-scope-' + all, title, (_e, cx) => {
      if (view.allSpaces === all) return;
      view.allSpaces = all;
      view.navigate(cx, 'schedules');
    }, view.allSpaces === all ? 'active' : 'normal'))));
  if (!items.length) return body.child(panel(t).child(cardHeading(t, 'No schedules yet', 'schedules')));
  body.child(input(t, view.search, 'search'));
  if (!visible.length) return body.child(label('No schedules match your search.', 12, t.muted));
  return body.children(visible.map(item => panel(t)
    .child(label(item.question, 14, t.foreground).font_semibold())
    .child(h_flex().gap(6).items_center().flex_wrap().child(badge(t, item)).child(label(modeName(item.mode), 12, t.muted)))
    .child(label([origins.get(item.project), cadence(item), item.nextAtLocal || item.nextAt].filter(Boolean).join(' · '), 12, t.muted).tooltip(item.project))
    .child(h_flex().child(button(t, item.project + '/' + item.id, 'Open schedule', (_e, cx) =>
      view.navigate(cx, 'schedules', { id: item.id, project: item.project }, { returnTo: view.workspaceReturn }))))));
}
