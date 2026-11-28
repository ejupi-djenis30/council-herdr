import { div } from 'gpui-kit';
import { Button, h_flex, v_flex } from 'gpui-base';
import { button, cardHeading, columns, glyph, iconTile, input, label, panel, progress, reviewStatus, statusPill } from './components.js';
import { delegationStatus } from './delegation-view.js';
import { countLabel, discussionType } from './poll-text.js';
import { workItemView } from './work-item-view.js';

const tabs = [
  ['runs', 'Runs', 'delegations'], ['plan', 'Plan', 'plan'], ['changes', 'Changes', 'changes'],
  ['work-items', 'Work items', 'file']
];
const groups = [
  ['attention', 'Needs attention', 'warning', 'blocked'],
  ['active', 'In flight', 'working', 'working'],
  ['ready', 'Results ready', 'done', 'done']
];
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

function workspaceButton(t, id, title, click, selected = false) {
  return Button.new(id).min_w_0().p(7).rounded(6).border_1().tab_stop(true)
    .accessibility_label(title).selected(selected).cursor_pointer()
    .border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.surface)
    .focus(style => style.border_color(t.foreground))
    .hover(style => style.bg(t.raised)).on_click(click);
}

function runFilter(t, id, title, icon, count, color, click, selected) {
  return workspaceButton(t, `run-filter-${id}`, `${title}, ${count}`, click, selected)
    .child(h_flex().min_h(17).gap(5).items_center()
      .when(Boolean(icon), row => row.child(glyph(icon, 18).text_color(t[color])))
      .child(label(title, 12, t.foreground).font_medium())
      .child(label(count, 12, t.foreground).font_semibold()));
}

function runCard(t, job, actions) {
  const key = `${job.project}/${job.id}`;
  const state = job.power === 'unconfirmed' ? { title: 'Shutdown unconfirmed', color: t.blocked }
    : job.power === 'stopping' ? { title: 'Stopping process', color: t.working } : delegationStatus(t, job.status);
  return panel(t).p(11).gap(7)
    .child(h_flex().gap(7).flex_wrap()
      .child(statusPill(t, state.title, state.color, t.foreground))
      .child(label(job.outcome ? `${discussionType(job)} · ${reviewStatus(job.outcome)}` : discussionType(job), 11, t.muted))
      .when(Boolean(job.teamMember), row => row.child(label(job.teamMember, 11, t.accent).font_semibold()))
      .child(label(job.id, 11, t.muted)))
    .child(label(job.question, 14, t.foreground).font_semibold())
    .when(Boolean(job.note), card => card.child(v_flex().gap(3).p(8).rounded(6).bg(t.background)
      .child(label(['Reported', job.note.state, job.note.component].filter(Boolean).join(' · '), 11, t.accent))
      .child(label(job.note.text.slice(0, 220), 12, t.foreground))))
    .child(h_flex().gap(6).items_center().flex_wrap()
      .child(label([leaf(job.project), job.agent, job.address].filter(Boolean).join(' · '), 11, t.muted).flex_1())
      .when(Boolean(job.related?.parent), row => row.child(button(t, `caller-${key}`,
        `From ${job.related.parent.member || job.related.parent.id}`, (_e, cx) => actions.open(cx, 'delegations', job.related.parent.id, job.project))))
      .child(button(t, `run-${key}`, 'Inspect run', (_e, cx) => actions.open(cx, job.tab ?? 'delegations', job.id, job.project), 'normal', false, 'right')));
}

function decisionDesk(t, data, actions) {
  const card = panel(t).child(cardHeading(t, 'Decision desk', 'polls'));
  if (!data.decisions.length) card.child(empty(t, 'No polls, discussions, or reviews awaiting action.'));
  for (const decision of data.decisions.slice(0, 5)) {
    const details = [decisionKinds[decision.tab], reviewStatus(decision.state), leaf(decision.project)].filter(Boolean).join(' · ');
    card.child(workspaceButton(t, `decision-${decision.project}-${decision.tab}-${decision.id}`,
      `Open ${decision.question} · ${details}`, (_e, cx) => actions.open(cx, decision.tab, decision.id, decision.project))
      .w_full().child(v_flex().w_full().min_w_0().gap(3)
        .child(label(details, 11, t.muted))
        .child(h_flex().items_center().gap(6)
          .child(label(decision.question, 12, t.foreground).flex_1())
          .child(glyph('right', 13).text_color(t.muted)))));
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
    const status = agent.status === 'done' ? 'Turn ended' : title;
    card.child(workspaceButton(t, `live-${agent.address}`, `Open terminal ${agent.label}, ${agent.address}, ${status}`,
      (_e, cx) => actions.focus(cx, agent.address)).w_full()
      .child(h_flex().w_full().min_w_0().gap(6).items_center()
        .child(v_flex().flex_1().min_w_0().child(label(agent.label, 12, t.foreground).truncate())
          .child(label(agent.address, 11, t.muted)))
        .child(statusPill(t, status, t[color], t.foreground))));
  }
  return card;
}

function runsView(t, data, ui, actions) {
  const query = ui.search.value().trim().toLowerCase();
  const records = data.runs.filter(job => (ui.group === 'all' || job.group === ui.group) &&
    [job.question, job.id, job.project, job.teamMember, job.agent, job.note?.text].some(value => value?.toLowerCase().includes(query)))
    .sort((a, b) => runPriority[a.group] - runPriority[b.group]);
  const all = Object.values(data.counts).reduce((total, count) => total + count, 0);
  const filters = h_flex().gap(6).flex_wrap().role('group').accessibility_label('Run status filters')
    .child(runFilter(t, 'all', 'All runs', null, all, null, (_e, cx) => actions.showRuns(cx, 'all'), ui.group === 'all'))
    .children(groups.map(([id, title, icon, color]) =>
      runFilter(t, id, title, icon, data.counts[id], color, (_e, cx) => actions.showRuns(cx, id), ui.group === id)));
  const list = v_flex().w_full().min_w_0().gap(8)
    .child(filters)
    .child(input(t, ui.search, 'search', 'Search runs'))
    .children(records.slice(0, ui.limit).map(job => runCard(t, job, actions)));
  if (!records.length) {
    const title = query ? 'No matching runs' : ui.group === 'all' ? 'No runs yet' : 'No runs in this state';
    const detail = query ? 'Try a different title, run ID, or filter.' : ui.group === 'all'
      ? 'Workflows started here or in a linked project appear in this list.' : 'Choose All runs to see the other states.';
    list.child(panel(t).child(cardHeading(t, title, 'delegations')).child(empty(t, detail)));
  }
  if (records.length > ui.limit) list.child(button(t, 'more-workspace-runs', 'Show more runs', (_e, cx) => actions.more(cx)));
  if (Object.values(data.counts).some(count => count > 18)) {
    list.child(button(t, 'delegate-history', query ? 'Search full delegation history' : 'Full delegation history',
      (_e, cx) => actions.history(cx), 'normal', false, 'right'));
  }
  const desk = v_flex().min_w_0().gap(8).child(decisionDesk(t, data, actions)).child(terminalDesk(t, ui.live, actions));
  return ui.wide ? h_flex().w_full().items_start().gap(10)
    .child(div().flex_1().min_w_0().child(list))
    .child(div().w(240).flex_shrink_0().child(desk))
    : v_flex().w_full().gap(10).child(list).child(desk);
}

function componentCard(t, item, ui, actions) {
  const done = item.tasks.filter(task => task.state === 'done').length;
  const state = item.tasks.some(task => task.state === 'blocked') ? 'blocked'
    : item.tasks.some(task => task.state === 'working') ? 'working'
    : item.tasks.length && done === item.tasks.length ? 'done' : 'pending';
  const [title, color] = taskStates[state];
  const isSelected = ui.component === item.id;
  const kind = item.kind ? item.kind === 'human' ? 'Human step' : 'Knowledge' : '';
  const changes = item.changes.length ? countLabel(item.changes.length, 'changed path') : '';
  const name = [item.title, item.tasks.length ? title : '', kind, changes].filter(Boolean).join(' · ');
  return workspaceButton(t, `component-${item.id}`, name, (_e, cx) => actions.component(cx, item.id), isSelected)
    .w_full().child(v_flex().min_w_0().w_full().gap(5)
      .child(label(item.title, 13, t.foreground).font_semibold())
      .when(Boolean(item.tasks.length || kind || changes), card => card.child(h_flex().gap(5).flex_wrap()
        .when(item.tasks.length > 0, row => row.child(statusPill(t, title, t[color], t.foreground)))
        .when(Boolean(kind), row => row.child(label(kind, 11, t.muted)))
        .when(Boolean(changes), row => row.child(label(changes, 11, t.muted))))));
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
  const title = path.previous ? `${path.previous} → ${path.path}` : path.path;
  return workspaceButton(t, `git-${path.path}`, `Copy path ${path.path}, Git status ${path.flag.trim()}`,
    (_e, cx) => action(cx, path.path)).w_full().tooltip(path.path)
    .child(h_flex().w_full().min_w_0().gap(7).items_center()
      .child(glyph('file', 16).text_color(t.muted))
      .child(label(path.flag.trim(), 11, t.muted).w(20).flex_shrink_0())
      .child(label(title, 12, t.foreground).flex_1().truncate())
      .child(glyph('copy', 16).text_color(t.muted)));
}

function planChecks(t, plan) {
  return panel(t).child(cardHeading(t, 'Plan checks', 'warning'))
    .children(plan.issues.map(issue => label(issue, 12, t.foreground)))
    .when(plan.clipped, node => node.child(label('This plan exceeds the view’s component or task limit.', 12, t.muted)));
}

function planView(t, data, ui, actions) {
  const plan = data.plan;
  if (!plan?.components.length) {
    return v_flex().gap(8).child(panel(t).child(cardHeading(t, plan ? 'No components in PLAN.md' : 'No project plan', 'plan'))
      .child(empty(t, plan ? 'Add headings with stable component IDs to PLAN.md.' :
        'Add a PLAN.md with components and task lists to map the work.'))
      .child(h_flex().gap(6).flex_wrap()
        .child(button(t, 'sample-plan', 'Copy sample plan', (_e, cx) => actions.sample(cx), 'normal', false, 'copy'))
        .child(button(t, 'plan-changes', 'Open Changes', (_e, cx) => actions.view(cx, 'changes'), 'normal', false, 'right'))))
      .when(Boolean(plan?.issues.length || plan?.clipped), node => node.child(planChecks(t, plan)));
  }
  const byId = new Map(plan.components.map(component => [component.id, component]));
  const item = byId.get(ui.component) ?? byId.get(plan.layers[0].ids[0]);
  const visible = new Set(plan.layers.flatMap(layer => layer.ids).slice(0, ui.limit));
  visible.add(item.id);
  const list = panel(t).child(cardHeading(t, plan.title || 'Plan map', 'plan'))
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
        .child(label(laneTitle, 11, lane.kind === 'unresolved' ? t.foreground : t.muted).truncate().tooltip(laneTitle)))
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
          .child(statusPill(t, title, t[color], t.foreground)).child(label(task.title, 12, t.foreground).flex_1()))
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
  if (plan.issues.length || plan.clipped) body.child(planChecks(t, plan));
  if (plan.decisions.length) body.child(panel(t).child(cardHeading(t, 'Decisions recorded in PLAN.md', 'polls'))
    .children(plan.decisions.map(decision => label(decision, 12, t.foreground))));
  return body;
}

function changesView(t, git, ui, actions) {
  if (!git.available) return panel(t).child(cardHeading(t, 'Git changes unavailable', 'changes'))
    .child(empty(t, git.reason === 'git-missing' ? 'Git is unavailable on this machine.' :
      git.reason === 'no-repository' ? 'The selected folder is outside a Git repository.' : 'Git could not read this folder.'));
  const query = ui.search.value().trim().toLowerCase();
  const files = git.files.filter(file => file.path.toLowerCase().includes(query));
  const list = panel(t).child(cardHeading(t, 'Working tree', 'changes'))
    .when(git.statusAvailable, node => node.child(label('Git reports paths without attributing authorship.', 11, t.muted))
      .child(input(t, ui.search, 'search', 'Search changed paths')))
    .children(files.slice(0, ui.limit).map(file => gitFile(t, file, actions.copyPath)));
  if (!files.length) list.child(empty(t, !git.statusAvailable ? 'Git status is unavailable.' : query ? 'No matching paths.' : 'No working-tree changes.'));
  if (files.length > ui.limit) list.child(button(t, 'more-paths', 'Show more paths', (_e, cx) => actions.more(cx)));
  if (git.clipped) list.child(label(`Showing ${git.files.length} of ${git.total} changed paths.`, 11, t.muted));
  const context = v_flex().gap(8).child(panel(t).child(cardHeading(t, 'Worktrees', 'project'))
    .children(git.worktrees.map(tree => v_flex().gap(3).pt(5).border_t_1().border_color(t.border)
      .child(label(tree.branch || tree.revision || 'Detached', 12, t.foreground).font_semibold())
      .child(label(tree.folder, 11, t.muted).truncate().tooltip(tree.folder)))))
    .child(panel(t).child(cardHeading(t, 'Recent commits', 'plan'))
      .when(!git.commits.length, node => node.child(empty(t, 'No commits in this folder.')))
      .children(git.commits.map(commit => v_flex().gap(3)
        .child(label(commit.revision, 11, t.accent)).child(label(commit.subject, 12, t.foreground)))));
  return columns(ui.wide, context, list, 258);
}

export function workspaceView(t, data, ui, actions) {
  const header = panel(t).gap(9)
    .child(h_flex().gap(9).items_center()
      .child(iconTile(t, 'project', 38))
      .child(v_flex().gap(2).flex_1().min_w_0()
        .child(label(leaf(data.project) || data.project, 20, t.foreground).font_semibold())
        .child(label([
          data.git.branch ? `Branch ${data.git.branch}` : 'Project folder',
          data.folder !== data.project ? `Following ${leaf(data.folder)}` : null
        ].filter(Boolean).join(' · '), 11, t.muted).truncate().tooltip(data.project)))
      .child(button(t, 'copy-workspace-path', '', (_e, cx) => actions.copyPath(cx, data.project), 'normal', false, 'copy')
        .tooltip('Copy project path').accessibility_label('Copy project path')))
    .when(ui.projects.length > 1, node => node.child(h_flex().gap(4).flex_wrap()
      .child(button(t, 'track-focus', 'Follow active folder', (_e, cx) => actions.project(cx, null), ui.pinned ? 'normal' : 'active'))
      .children(ui.projects.slice(0, 12).map((path, index) =>
        button(t, `workspace-folder-${index}`, leaf(path), (_e, cx) => actions.project(cx, path),
          ui.pinned === path ? 'active' : 'normal').tooltip(path)))));
  const nav = h_flex().gap(6).flex_wrap().items_center()
    .child(h_flex().gap(6).flex_wrap().role('tab_list').accessibility_label('Workspace views')
      .children(tabs.map(([id, title, icon], position) => button(t, `workspace-${id}`, title,
        (_e, cx) => actions.view(cx, id), ui.view === id ? 'active' : 'normal', false, icon)
        .role('tab').set_position(position + 1, tabs.length).focus(style => style.border_color(t.foreground))
        .when(id === 'work-items', tab => tab.track_focus(ui.workItemsTab)))))
    .when(data.errors.length > 0, row => row.child(button(t, 'workspace-diagnostics',
      countLabel(data.errors.length, 'read issue'), (_e, cx) => actions.diagnostics(cx),
      ui.diagnostics ? 'active' : 'normal', false, 'warning')));
  const view = ui.view === 'plan' ? planView(t, data, ui, actions)
    : ui.view === 'changes' ? changesView(t, data.git, ui, actions)
      : ui.view === 'work-items' ? workItemView(t, ui.workItems?.screen, ui.workItems, ui.workItems?.actions)
        : runsView(t, data, ui, actions);
  if (ui.view === 'work-items' && ui.workItems?.screen?.form && !ui.workItems.screen.form.stale) return view;
  return v_flex().w_full().min_w_0().gap(10).child(header).child(nav)
    .when(ui.diagnostics && data.errors.length > 0, body => body.child(panel(t).child(cardHeading(t, 'Read issues', 'warning'))
      .children(data.errors.map(issue => v_flex().gap(3).child(label(issue.source, 12, t.foreground).font_semibold())
        .child(label(issue.detail, 12, t.muted))))))
    .child(view);
}
