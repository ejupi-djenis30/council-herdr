import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { button, cardHeading, columns, glyph, iconTile, input, label, panel, progress, reviewStatus, statusPill } from './components.js';
import { delegationStatus } from './delegation-view.js';
import { countLabel } from './poll-text.js';

const tabs = [['runs', 'Runs', 'delegations'], ['plan', 'Plan', 'reviews'], ['changes', 'Changes', 'activity']];
const groups = [['active', 'In flight', 'working'], ['attention', 'Needs attention', 'blocked'], ['ready', 'Results ready', 'done']];
const runPriority = { attention: 0, active: 1, ready: 2 };
const taskStates = {
  pending: ['Pending', 'muted'], working: ['Working', 'working'], blocked: ['Blocked', 'blocked'], done: ['Marked done', 'done']
};
const decisionKinds = { polls: 'Poll', debates: 'Discussion', reviews: 'Review' };

function leaf(path) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function empty(t, message) {
  return label(message, 12, t.muted).py(5);
}

function metric(t, id, title, value, color, click, selected) {
  return v_flex().id(`metric-${id}`).flex_1().min_w_0().gap(3).px(10).py(8).rounded(7).border_1()
    .border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.background).cursor_pointer()
    .hover(style => style.bg(t.raised)).on_click(click)
    .child(label(value, 21, color).font_semibold()).child(label(title, 11, t.muted));
}

function runCard(t, job, actions) {
  const state = job.power === 'unconfirmed' ? { title: 'Shutdown unconfirmed', color: t.blocked }
    : job.power === 'stopping' ? { title: 'Stopping process', color: t.working } : delegationStatus(t, job.status);
  return panel(t).p(11).gap(7)
    .child(h_flex().gap(7).flex_wrap()
      .child(statusPill(t, state.title, state.color))
      .when(Boolean(job.teamMember), row => row.child(label(job.teamMember, 11, t.accent).font_semibold()))
      .child(label(job.id, 11, t.dim)))
    .child(label(job.question, 14, t.foreground).font_semibold())
    .when(Boolean(job.note), card => card.child(v_flex().gap(3).p(8).rounded(6).bg(t.background)
      .child(label(['Reported', job.note.state, job.note.component].filter(Boolean).join(' · '), 11, t.accent))
      .child(label(job.note.text.slice(0, 220), 12, t.foreground))))
    .child(h_flex().gap(6).items_center().flex_wrap()
      .child(label([job.agent, job.address].filter(Boolean).join(' · '), 11, t.muted).flex_1())
      .when(Boolean(job.related?.parent), row => row.child(button(t, `caller-${job.id}`,
        `From ${job.related.parent.member || job.related.parent.id}`, (_e, cx) => actions.open(cx, 'delegations', job.related.parent.id))))
      .child(button(t, `run-${job.id}`, 'Inspect run', (_e, cx) => actions.open(cx, 'delegations', job.id), 'normal', false, 'right')));
}

function decisionDesk(t, data, actions) {
  const card = panel(t).child(cardHeading(t, 'Decision desk', 'polls'));
  if (!data.decisions.length) card.child(empty(t, 'No polls, discussions, or reviews awaiting action.'));
  for (const decision of data.decisions.slice(0, 5)) {
    card.child(v_flex().id(`decision-${decision.tab}-${decision.id}`).gap(5).pt(8)
      .border_t_1().border_color(t.border).cursor_pointer().hover(style => style.bg(t.raised))
      .on_click((_e, cx) => actions.open(cx, decision.tab, decision.id))
      .child(label(`${decisionKinds[decision.tab]} · ${reviewStatus(decision.state)}`, 11, t.accent))
      .child(h_flex().items_center().gap(6)
        .child(label(decision.question, 12, t.foreground).flex_1())
        .child(glyph('right', 13).text_color(t.dim))));
  }
  if (data.decisionCount > 5) card.child(label(`Showing the latest 5 of ${data.decisionCount} items.`, 11, t.muted));
  return card.child(h_flex().gap(6).flex_wrap()
    .child(button(t, 'desk-poll', 'New poll', (_e, cx) => actions.create(cx, 'polls'), 'normal', false, 'add'))
    .child(button(t, 'desk-discuss', 'New debate', (_e, cx) => actions.create(cx, 'debates'), 'normal', false, 'add')));
}

function terminalDesk(t, records, actions) {
  const card = panel(t).child(cardHeading(t, 'Live in Herdr', 'terminal'));
  if (!records.length) card.child(empty(t, 'No agents visible for this folder.'));
  for (const agent of records.slice(0, 8)) {
    const [title, color] = taskStates[agent.status] ?? (agent.status === 'error' ? ['Error', 'blocked'] : ['Idle', 'muted']);
    card.child(h_flex().id(`live-${agent.address}`).gap(6).items_center().pt(7)
      .border_t_1().border_color(t.border).cursor_pointer().hover(style => style.bg(t.raised))
      .on_click((_e, cx) => actions.focus(cx, agent.address))
      .child(v_flex().flex_1().min_w_0().child(label(agent.label, 12, t.foreground).truncate())
        .child(label(agent.address, 10, t.dim)))
      .child(statusPill(t, agent.status === 'done' ? 'Turn ended' : title, t[color])));
  }
  return card;
}

function runsView(t, data, ui, actions) {
  const query = ui.search.value().trim().toLowerCase();
  const records = data.runs.filter(job => (ui.group === 'all' || job.group === ui.group) &&
    [job.question, job.id, job.teamMember, job.agent, job.note?.text].some(value => value?.toLowerCase().includes(query)))
    .sort((a, b) => runPriority[a.group] - runPriority[b.group]);
  const list = v_flex().min_w_0().gap(8)
    .child(h_flex().items_center().gap(6)
      .child(div().flex_1().min_w_0().child(input(t, ui.search, 'search')))
      .child(button(t, 'all-workspace-runs', 'All runs', (_e, cx) => actions.showRuns(cx, 'all'), ui.group === 'all' ? 'active' : 'normal')))
    .children(records.slice(0, ui.limit).map(job => runCard(t, job, actions)));
  if (!records.length) list.child(panel(t).child(empty(t, query ? 'No matching runs.' :
    data.runs.length ? 'No runs in this state.' : 'Start a delegation or call a Team role to see a run here.')));
  if (records.length > ui.limit) list.child(button(t, 'more-workspace-runs', 'Show more runs', (_e, cx) => actions.more(cx)));
  if (Object.values(data.counts).some(count => count > 18)) {
    list.child(button(t, 'delegate-history', query ? 'Search full delegation history' : 'Full delegation history',
      (_e, cx) => actions.history(cx), 'normal', false, 'right'));
  }
  const desk = v_flex().min_w_0().gap(8).child(decisionDesk(t, data, actions)).child(terminalDesk(t, ui.live, actions));
  return columns(ui.wide, desk, list, 258);
}

function componentCard(t, item, ui, actions) {
  const done = item.tasks.filter(task => task.state === 'done').length;
  const state = item.tasks.some(task => task.state === 'blocked') ? 'blocked'
    : item.tasks.some(task => task.state === 'working') ? 'working'
    : item.tasks.length && done === item.tasks.length ? 'done' : 'pending';
  const [title, color] = taskStates[state];
  const isSelected = ui.component === item.id;
  return v_flex().id(`component-${item.id}`).gap(7).p(10).rounded(7).border_1().min_w_0()
    .border_color(isSelected ? t.accent : t.border).bg(isSelected ? t.selected : t.background)
    .cursor_pointer().hover(style => style.bg(t.raised)).on_click((_e, cx) => actions.component(cx, item.id))
    .child(label(item.title, 13, t.foreground).font_semibold())
    .child(h_flex().gap(5).flex_wrap()
      .when(item.tasks.length > 0, row => row.child(statusPill(t, title, t[color])))
      .when(Boolean(item.kind), row => row.child(label(item.kind === 'human' ? 'Human step' : 'Knowledge', 11, t.accent)))
      .when(item.changes.length > 0, row => row.child(label(countLabel(item.changes.length, 'changed path'), 11, t.accent))));
}

function relations(t, title, ids, plan, actions) {
  if (!ids.length) return null;
  return v_flex().gap(5).child(label(title, 11, t.muted))
    .child(h_flex().gap(5).flex_wrap().children(ids.map(id => {
      const neighbor = plan.components.find(item => item.id === id);
      return button(t, `${title}-${id}`, neighbor?.title || id, (_e, cx) => actions.component(cx, id), 'normal', !neighbor, 'right');
    })));
}

function gitFile(t, path, action) {
  return h_flex().id(`git-${path.path}`).gap(7).items_center().px(6).py(5).rounded(5).cursor_pointer()
    .hover(style => style.bg(t.raised)).on_click((_e, cx) => action(cx, path.path))
    .child(label(path.flag.trim(), 11, path.flag === '??' ? t.accent : t.working).w(24).flex_shrink_0())
    .child(label(path.previous ? `${path.previous} → ${path.path}` : path.path, 12, t.foreground).flex_1().truncate().tooltip(path.path))
    .child(glyph('copy', 12).text_color(t.dim));
}

function planView(t, data, ui, actions) {
  const plan = data.plan;
  if (!plan?.components.length) return panel(t).child(cardHeading(t, 'Project plan', 'reviews'))
    .child(empty(t, plan ? 'Add headings with stable component IDs to PLAN.md.' :
      'Add a PLAN.md with components and task lists to map the work. Git changes are available in Changes.'))
    .child(h_flex().gap(6).flex_wrap()
      .child(button(t, 'sample-plan', 'Copy sample plan', (_e, cx) => actions.sample(cx), 'normal', false, 'copy'))
      .child(button(t, 'plan-changes', 'Open changes', (_e, cx) => actions.view(cx, 'changes'), 'normal', false, 'right')));
  const byId = new Map(plan.components.map(component => [component.id, component]));
  const item = byId.get(ui.component) ?? byId.get(plan.layers[0].ids[0]);
  const visible = new Set(plan.layers.flatMap(layer => layer.ids).slice(0, ui.limit));
  visible.add(item.id);
  const list = panel(t).child(cardHeading(t, plan.title || 'Plan map', 'reviews'))
    .child(label('Declared dependencies · PLAN.md', 11, t.muted));
  const laneLabels = { independent: 'Independent', dependent: 'Depends on earlier components', unresolved: 'Unresolved dependencies' };
  for (const lane of plan.layers) {
    const ids = lane.ids.filter(id => visible.has(id));
    if (!ids.length) continue;
    const needs = [...new Set(ids.flatMap(id => byId.get(id).needs))];
    const laneTitle = lane.kind === 'dependent' && needs.length === 1
      ? `After ${byId.get(needs[0]).title}` : laneLabels[lane.kind];
    list.child(v_flex().gap(5)
      .child(h_flex().gap(6).items_center()
        .when(lane.kind !== 'independent', row => row.child(glyph('down', 12).text_color(t.muted)))
        .child(label(laneTitle, 11, lane.kind === 'unresolved' ? t.blocked : t.muted).truncate().tooltip(laneTitle)))
      .children(ids.map(id => componentCard(t, byId.get(id), { component: item.id }, actions))));
  }
  if (plan.components.length > visible.size) list.child(button(t, 'more-components', 'Show more components', (_e, cx) => actions.more(cx)));
  const dependents = plan.components.filter(component => component.needs.includes(item.id)).map(component => component.id);
  const details = panel(t).child(label(item.title, 18, t.foreground).font_semibold())
    .when(Boolean(item.tech), node => node.child(label(item.tech, 12, t.muted)))
    .children([
      relations(t, 'Depends on', item.needs, plan, actions),
      relations(t, 'Required by', dependents, plan, actions),
      relations(t, 'Related', item.links, plan, actions)
    ].filter(Boolean))
    .when(item.tasks.length > 0, node => node.child(progress(t, 'Tasks marked done', item.tasks.filter(task => task.state === 'done').length, item.tasks.length, t.done)))
    .children(item.tasks.slice(0, ui.limit).map((task, index) => {
      const [title, color] = taskStates[task.state];
      return v_flex().id(`plan-task-${index}`).gap(4).pt(6).border_t_1().border_color(t.border)
        .child(h_flex().gap(5).items_center().flex_wrap()
          .child(statusPill(t, title, t[color])).child(label(task.title, 12, t.foreground).flex_1()))
        .when(Boolean(task.by || task.from || task.evidence), row => row.child(label([
          task.by && `By ${task.by}`, task.from && `From ${task.from}`, task.evidence && `Evidence: ${task.evidence}`
        ].filter(Boolean).join(' · '), 11, t.muted)));
    }))
    .when(item.tasks.length > ui.limit, node => node.child(button(t, 'more-tasks', 'Show more tasks', (_e, cx) => actions.more(cx))))
    .when(item.reports.length > 0, node => node.child(label('Reported updates', 12, t.accent).font_semibold())
      .children(item.reports.map(note => v_flex().gap(4).p(7).rounded(5).bg(t.background)
        .child(label([note.member || note.id, note.state].join(' · '), 11, t.muted))
        .child(label(note.text.slice(0, 220), 12, t.foreground))
        .child(button(t, `plan-run-${note.id}`, 'Inspect run', (_e, cx) => actions.open(cx, 'delegations', note.id), 'normal', false, 'right')))))
    .when(item.changes.length > 0, node => node.child(label('Git changes matching component paths', 12, t.accent).font_semibold())
      .children(item.changes.map(change => gitFile(t, change, actions.copyPath))));
  const body = v_flex().gap(8).child(columns(ui.wide, list, details, 258));
  if (plan.issues.length || plan.clipped) body.child(panel(t).child(cardHeading(t, 'Plan checks', 'reviews'))
    .children(plan.issues.map(issue => label(issue, 12, t.blocked)))
    .when(plan.clipped, node => node.child(label('This plan exceeds the view’s component or task limit.', 12, t.muted))));
  if (plan.decisions.length) body.child(panel(t).child(cardHeading(t, 'Decisions recorded in PLAN.md', 'polls'))
    .children(plan.decisions.map(decision => label(decision, 12, t.foreground))));
  return body;
}

function changesView(t, git, ui, actions) {
  if (!git.available) return panel(t).child(cardHeading(t, 'Git changes', 'activity'))
    .child(empty(t, git.reason === 'git-missing' ? 'Git is unavailable on this machine.' :
      git.reason === 'no-repository' ? 'The selected folder is outside a Git repository.' : 'Git could not read this folder.'));
  const query = ui.search.value().trim().toLowerCase();
  const files = git.files.filter(file => file.path.toLowerCase().includes(query));
  const list = panel(t).child(cardHeading(t, 'Observed in Git', 'activity'))
    .child(label('Working-tree paths · author unknown', 11, t.muted))
    .child(input(t, ui.search, 'search'))
    .children(files.slice(0, ui.limit).map(file => gitFile(t, file, actions.copyPath)));
  if (!files.length) list.child(empty(t, !git.statusAvailable ? 'Git status is unavailable.' : query ? 'No matching paths.' : 'No working-tree changes.'));
  if (files.length > ui.limit) list.child(button(t, 'more-paths', 'Show more paths', (_e, cx) => actions.more(cx)));
  if (git.clipped) list.child(label(`Showing ${git.files.length} of ${git.total} changed paths.`, 11, t.muted));
  const context = v_flex().gap(8).child(panel(t).child(cardHeading(t, 'Worktrees', 'delegations'))
    .children(git.worktrees.map(tree => v_flex().gap(3).pt(5).border_t_1().border_color(t.border)
      .child(label(tree.branch || tree.revision || 'Detached', 12, t.foreground).font_semibold())
      .child(label(tree.folder, 11, t.muted).truncate().tooltip(tree.folder)))))
    .child(panel(t).child(cardHeading(t, 'Recent commits', 'reviews'))
      .when(!git.commits.length, node => node.child(empty(t, 'No commits in this folder.')))
      .children(git.commits.map(commit => v_flex().gap(3)
        .child(label(commit.revision, 11, t.accent)).child(label(commit.subject, 12, t.foreground)))));
  return columns(ui.wide, context, list, 258);
}

export function workspaceView(t, data, ui, actions) {
  const header = panel(t).gap(9)
    .child(h_flex().gap(9).items_center()
      .child(iconTile(t, 'activity', 38))
      .child(v_flex().gap(2).flex_1().min_w_0()
        .child(label(leaf(data.project), 19, t.foreground).font_semibold())
        .child(label([
          data.git.branch ? `Branch ${data.git.branch}` : 'Local folder',
          data.folder !== data.project ? `Following ${leaf(data.folder)}` : null
        ].filter(Boolean).join(' · '), 11, t.muted).truncate().tooltip(data.project)))
      .child(button(t, 'copy-workspace-path', '', (_e, cx) => actions.copyPath(cx, data.project), 'normal', false, 'copy').tooltip('Copy project path')))
    .when(ui.projects.length > 1, node => node.child(h_flex().gap(4).flex_wrap()
      .child(button(t, 'track-focus', 'Follow focus', (_e, cx) => actions.project(cx, null), ui.pinned ? 'normal' : 'active'))
      .children(ui.projects.slice(0, 12).map((path, index) =>
        button(t, `workspace-folder-${index}`, leaf(path), (_e, cx) => actions.project(cx, path),
          ui.pinned === path ? 'active' : 'normal').tooltip(path)))));
  const metrics = h_flex().gap(6).children(groups.map(([id, title, color]) =>
    metric(t, id, title, data.counts[id], t[color], (_e, cx) => actions.showRuns(cx, id), ui.view === 'runs' && ui.group === id)));
  const nav = h_flex().gap(6).children(tabs.map(([id, title, icon]) =>
    button(t, `workspace-${id}`, title, (_e, cx) => actions.view(cx, id), ui.view === id ? 'active' : 'normal', false, icon)))
    .when(data.errors.length > 0, row => row.child(button(t, 'workspace-diagnostics', `${data.errors.length} read issues`,
      (_e, cx) => actions.diagnostics(cx), ui.diagnostics ? 'active' : 'normal')));
  const view = ui.view === 'plan' ? planView(t, data, ui, actions)
    : ui.view === 'changes' ? changesView(t, data.git, ui, actions) : runsView(t, data, ui, actions);
  return v_flex().w_full().min_w_0().gap(9).child(header).child(metrics).child(nav)
    .when(ui.diagnostics && data.errors.length > 0, body => body.child(panel(t).child(cardHeading(t, 'Read issues', 'activity'))
      .children(data.errors.map(issue => v_flex().gap(3).child(label(issue.source, 11, t.blocked))
        .child(label(issue.detail, 12, t.foreground))))))
    .child(view);
}
