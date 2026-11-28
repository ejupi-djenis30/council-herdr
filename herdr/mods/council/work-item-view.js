import { h_flex, v_flex, InputState, Textarea, TextareaState } from 'gpui-base';
import { button, cardHeading, field, label, panel, statusPill } from './components.js';

const stateLabels = {
  draft: ['Draft', 'muted'], in_progress: ['In progress', 'working'],
  needs_attention: ['Needs attention', 'blocked'], result_ready: ['Result ready', 'done']
};

export function makeWorkItemFields() {
  return { title: InputState.new(), criteria: TextareaState.new({ rows: 4 }) };
}

function badge(t, item) {
  const [title, color] = stateLabels[item.state];
  return statusPill(t, title, t[color], t.foreground);
}

function notice(t, heading, detail) {
  return panel(t).role('status').child(cardHeading(t, heading, 'warning')).child(label(detail, 12, t.foreground));
}

function metadata(t, name, value) {
  return v_flex().min_w_0().gap(2).child(label(name, 11, t.muted)).child(label(value, 13, t.foreground));
}

function facts(t, fields) {
  return h_flex().gap(16).flex_wrap().children(fields.map(([name, value]) => metadata(t, name, value)));
}

function criteriaList(t, criteria) {
  return v_flex().gap(5).role('list').accessibility_label('Acceptance criteria')
    .children(criteria.map((line, position) => label(`${position + 1}. ${line}`, 13, t.foreground)
      .role('list_item').set_position(position + 1, criteria.length)));
}

function toolbar(t, title, controls) {
  return h_flex().gap(8).flex_wrap().items_center()
    .child(label(title, 19, t.foreground).font_semibold().flex_1()).children(controls);
}

function listView(t, screen, actions, focus) {
  const list = v_flex().w_full().gap(9)
    .child(toolbar(t, 'Work items', [
      button(t, 'refresh-work-items', 'Refresh', actions.refresh, 'normal', screen.pending).track_focus(focus.refresh),
      button(t, 'new-work-item', 'New work item', actions.create, 'primary', false, 'add').track_focus(focus.create)
    ]));
  if (screen.error) list.child(notice(t, 'Could not read work items', screen.error));
  if (screen.pending) list.child(label(screen.items ? 'Refreshing work items…' : 'Loading work items…', 12, t.muted).role('status'));
  if (!screen.pending && screen.items?.length === 0) {
    list.child(panel(t).child(cardHeading(t, 'No work items', 'plan'))
      .child(label('This project has no work items yet.', 13, t.muted)));
  }
  list.children((screen.items ?? []).map(item =>
    panel(t).gap(7)
      .child(h_flex().gap(7).flex_wrap().items_center()
        .child(label(item.title, 15, t.foreground).font_semibold().flex_1())
        .child(badge(t, item)))
      .child(label(`Responsible role · ${item.roleId}`, 12, t.muted))
      .child(label(item.nextAction, 13, t.foreground))
      .child(h_flex().child(button(t, `open-work-item-${item.id}`, 'Open work item', (_e, cx) => actions.open(cx, item.id), 'normal', false, 'right')
        .accessibility_label(`Open work item ${item.title}`)))));
  if (screen.errors?.length) {
    list.child(panel(t).child(cardHeading(t, 'Work item read issues', 'warning'))
      .children(screen.errors.map(error => v_flex().gap(3).child(label(error.id, 12, t.foreground).font_semibold())
        .child(label(error.message, 12, t.muted)))));
  }
  return list;
}

function createView(t, screen, fields, attempt, actions, backFocus) {
  const card = panel(t).child(cardHeading(t, 'New work item', 'plan')).child(label(screen.scope.project, 12, t.muted));
  if (screen.error) card.child(notice(t, 'Could not save or load the form', screen.error));
  if (attempt) {
    const busy = ['writing', 'checking'].includes(attempt.phase);
    card.child(metadata(t, 'Title', attempt.input.title))
      .child(facts(t, [['Responsible role', attempt.input.roleId], ['Work item ID', attempt.input.id]]))
      .child(criteriaList(t, attempt.input.criteria));
    if (busy) card.child(label(attempt.phase === 'writing' ? 'Saving work item…' : 'Checking for the saved item…', 12, t.muted).role('status'));
    else card.child(notice(t, attempt.phase === 'conflict' ? 'Work item conflict' : 'Save recovery', attempt.message));
    return card.child(h_flex().gap(7).flex_wrap()
      .when(attempt.phase === 'missing', row => row.child(button(t, 'retry-work-item-save', 'Retry save', actions.save, 'primary')))
      .when(!busy && attempt.phase !== 'conflict', row => row.child(button(t, 'reconcile-work-item-save', 'Refresh saved item', actions.refresh)))
      .when(attempt.phase === 'conflict', row => row.child(button(t, 'discard-work-item', 'Discard draft', actions.discard)))
      .child(button(t, 'back-work-items', 'Back to work items', actions.back, 'normal', false, 'back').track_focus(backFocus)));
  }
  if (screen.pending) card.child(label('Loading roles from Team…', 12, t.muted).role('status'));
  else if (!screen.roles) card.child(button(t, 'refresh-work-item-roles', 'Refresh roles', actions.refresh));
  else if (!screen.roles.length) {
    card.child(label('Add a Team role in this project before creating a work item.', 13, t.foreground))
      .child(button(t, 'open-work-item-team', 'Open Team', actions.team, 'normal', false, 'team'));
  } else if (fields) {
    card.child(field(t, 'Title', fields.title))
      .child(v_flex().gap(4)
        .key_context('CouncilWorkItemCriteria')
        .on_action('council-work-item-next-field', (_e, cx) => { window.focus_next(); cx.stop_propagation(); })
        .on_action('council-work-item-previous-field', (_e, cx) => { window.focus_prev(); cx.stop_propagation(); })
        .child(label('Acceptance criteria', 12, t.foreground).font_medium())
        .child(label('Enter one criterion per line, in review order.', 12, t.muted))
        .child(Textarea.new(fields.criteria).w_full().min_w_0().h(100).px(8).py(6).text_size(13)
          .rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground)
          .accessibility_label('Acceptance criteria, one criterion per line')))
      .child(v_flex().gap(5)
        .child(label('Responsible role', 12, t.foreground).font_medium())
        .child(h_flex().gap(5).flex_wrap().role('group').accessibility_label('Responsible role')
          .children(screen.roles.map(({ id, role }) => button(t, `work-item-role-${id}`, role === id ? id : `${role} · ${id}`,
            (_e, cx) => actions.role(cx, id), screen.roleId === id ? 'active' : 'normal')))))
      .child(h_flex().gap(7).flex_wrap()
        .child(button(t, 'save-work-item', 'Save work item', actions.save, 'primary', !screen.roleId, 'check'))
        .child(button(t, 'refresh-work-item-roles', 'Refresh roles', actions.refresh)));
  }
  return card.child(h_flex().child(button(t, 'back-work-items', 'Back to work items', actions.back, 'normal', false, 'back').track_focus(backFocus)));
}

function resultView(t, item) {
  const result = item.result;
  const provenance = result.source === 'direct_artifact' ? 'Direct artifact' : 'Terminal screen capture';
  return panel(t).child(cardHeading(t, 'Saved handoff', 'file'))
    .child(label(provenance, 12, t.foreground).font_semibold())
    .child(label('Scroll to read the full handoff.', 12, t.muted))
    .child(v_flex().id(`work-item-output-${item.id}`).role('region').accessibility_label('Saved handoff output')
      .w_full().max_h(220).min_h(44).p(9).rounded(6).bg(t.background).overflow_y_scrollbar()
      .child(label(result.output, 13, t.foreground)));
}

function detailView(t, screen, delegation, actions, focus) {
  const item = screen.item;
  const controls = [
    button(t, 'back-work-items', 'Back to work items', actions.back, 'normal', false, 'back').track_focus(focus.back),
    button(t, 'refresh-work-item', 'Refresh', actions.refresh, 'normal', screen.pending || delegation === 'writing').track_focus(focus.refresh)
  ];
  if (item?.result) controls.push(button(t, 'copy-work-item-output', 'Copy saved handoff', actions.copyOutput, 'normal', false, 'copy')
    .track_focus(focus.copyOutput));
  if (item?.job?.linked) controls.push(button(t, 'open-work-item-delegation', 'Open delegation', actions.delegation, 'normal', false, 'right')
    .track_focus(focus.openDelegation));
  if (item) controls.unshift(badge(t, item));
  const body = v_flex().w_full().gap(9).child(toolbar(t, item?.title ?? 'Work item', controls));
  if (screen.error) body.child(notice(t, 'Work item request failed', screen.error));
  if (screen.pending) body.child(label(item ? 'Refreshing work item…' : 'Loading work item…', 12, t.muted).role('status'));
  if (!item) return body;
  body.child(panel(t).child(facts(t, [['Work item ID', item.id], ['Responsible role', item.roleId]]))
    .child(metadata(t, 'Project', screen.scope.project))
    .child(metadata(t, 'Next action', item.nextAction))
    .child(label('Acceptance criteria', 13, t.foreground).font_semibold())
    .child(criteriaList(t, item.criteria))
    .when(item.canDelegate && delegation !== 'unresolved', card =>
      card.child(h_flex().child(button(t, 'delegate-work-item', delegation === 'writing' ? 'Delegating…' : 'Delegate', actions.delegate,
        'primary', screen.pending || delegation === 'writing', 'delegations').track_focus(focus.delegate)))));
  if (delegation === 'unresolved') {
    body.child(notice(t, 'Delegation unconfirmed', 'Refresh this work item to reconcile the previous submission.'));
  }
  if (item.attention) body.child(notice(t, 'Needs attention', item.attention.message));
  if (item.result) body.child(resultView(t, item));
  if (item.job) {
    const job = item.job;
    const fields = [['Session ID', job.sessionId], ['Outcome', job.outcome]];
    if (job.deliveryState) fields.push(['Delivery', job.deliveryState]);
    if (job.deadlineAt) fields.push(['Deadline', job.deadlineAt]);
    if (job.address && job.linked) fields.push(['Terminal', job.address]);
    body.child(panel(t).child(cardHeading(t, job.linked ? 'Linked delegation' : 'Reserved delegation', 'delegations'))
      .child(facts(t, fields)));
  }
  return body;
}

export function workItemView(t, screen, ui, actions) {
  if (!screen) {
    return panel(t).role('status').child(cardHeading(t, 'Loading work items…', 'plan'));
  }
  if (screen.kind === 'create') return createView(t, screen, ui.fields, ui.attempt, actions, ui.focus.back);
  if (screen.kind === 'detail') return detailView(t, screen, ui.delegation, actions, ui.focus);
  return listView(t, screen, actions, ui.focus);
}
