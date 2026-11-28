import { Editor, h_flex, v_flex, InputState, Textarea, TextareaState } from 'gpui-base';
import { button, cardHeading, field, input, label, panel, statusPill } from './components.js';
import { frozenCaptureMatches, lifecycleStates, workItemActionEnabled, workItemPriorities } from './work-item-actions.js';

const stateLabels = {
  draft: ['Draft', 'muted'], in_progress: ['In progress', 'working'],
  needs_attention: ['Needs attention', 'blocked'], result_ready: ['Result ready', 'done']
};
const lifecycleLabels = { open: 'Open', in_review: 'In review', closed: 'Closed', unavailable: 'Unavailable' };
const formalLabels = { operator: 'Operator acceptance', pending: 'Pending', provisional: 'Provisional', rejected: 'Rejected',
  approved: 'Approved', unverified: 'Unverified' };
const operationLabels = {
  triage: ['Edit triage', 'Save triage'], delegate: ['Delegate', 'Confirm delegation'], start: ['Start review', 'Freeze handoff'],
  note: ['Record a review note', 'Save note'], attach: ['Attach formal round', 'Attach round'],
  return: ['Return for changes', 'Confirm return for changes'], close: ['Accept and close', 'Confirm acceptance and close'],
  reopen: ['Reopen item', 'Confirm reopen']
};
const fieldLabels = {
  actor: 'Actor name', title: 'Title', reason: 'Decision reason', nextAction: 'Next action', text: 'Review note',
  formalSessionId: 'Formal review session ID', round: 'Formal review round'
};
const decisionOperations = ['close', 'return', 'reopen'];
const capitalize = value => value[0].toUpperCase() + value.slice(1);

export function makeWorkItemFields() {
  return { title: InputState.new(), criteria: TextareaState.new({ rows: 4 }) };
}

export function makeLifecycleFields(form) {
  const { operation, item } = form;
  const values = { actor: '' };
  if (operation === 'triage') {
    values.nextAction = item.lifecycle.nextAction ?? '';
    if (item.lifecycle.actions.editDefinition) values.title = item.title;
  }
  if (operation === 'note') values.text = '';
  if (operation === 'attach') Object.assign(values, { formalSessionId: '', round: '' });
  if (decisionOperations.includes(operation)) Object.assign(values, { reason: '', nextAction: '' });
  const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, InputState.new({ value })]));
  if ('title' in fields) fields.criteria = TextareaState.new({ rows: 4, value: item.criteria.join('\n') });
  return fields;
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

function toolbar(t, title, controls, stacked = false) {
  const heading = label(title, 19, t.foreground).font_semibold();
  const actions = h_flex().gap(8).flex_wrap().items_center();
  if (stacked) return v_flex().gap(7).child(heading).child(actions.children(controls));
  return actions.child(heading.flex_1()).children(controls);
}

function lifecycleBadge(t, lifecycle) {
  return statusPill(t, lifecycleLabels[lifecycle.state], lifecycle.state === 'closed' ? t.done : t.working, t.foreground);
}

function choices(t, group, options, change, focus = {}) {
  return v_flex().gap(5).child(label(group, 12, t.foreground).font_medium())
    .child(h_flex().gap(5).flex_wrap().role('group').accessibility_label(group).children(
      options.map(({ id, title, selected, disabled: optionDisabled }) =>
        button(t, `choice-${group}-${id}`, title, (_e, cx) => change(cx, id), selected ? 'active' : 'normal',
          optionDisabled).accessibility_label(`${group}: ${title}`)
          .when(Object.hasOwn(focus, id), control => control.track_focus(focus[id])))));
}

function option(id, title, selected) {
  return { id, title, selected: id === selected };
}

function queueFilters(t, screen, actions, focus) {
  const { filters, items = [], roles = [] } = screen;
  const roleChoices = new Map(roles.map(({ id, role }) => [id, role === id ? id : `${role} · ${id}`]));
  for (const { roleId } of items) if (!roleChoices.has(roleId)) roleChoices.set(roleId, roleId);
  if (filters.roleId && !roleChoices.has(filters.roleId)) roleChoices.set(filters.roleId, filters.roleId);
  return v_flex().gap(8)
    .child(choices(t, 'Responsible role', [option('', 'All roles', filters.roleId ?? ''),
      ...[...roleChoices].map(([id, name]) => option(id, name, filters.roleId))],
    (cx, roleId) => actions.filter(cx, { ...filters, roleId }), { '': focus.allRoles }))
    .child(choices(t, 'Lifecycle', [option('', 'All states', filters.state ?? ''),
      ...lifecycleStates.map(id => option(id, lifecycleLabels[id], filters.state))],
    (cx, state) => actions.filter(cx, { ...filters, state }), focus.states))
    .child(h_flex().gap(6).flex_wrap()
      .child(button(t, 'queue-attention', 'Needs attention', (_e, cx) =>
        actions.filter(cx, { ...filters, attention: !filters.attention }), filters.attention ? 'active' : 'normal')
        .track_focus(focus.attention))
      .child(button(t, 'queue-clear-filters', 'Clear filters', (_e, cx) => actions.filter(cx, {}), 'normal',
        !Object.values(filters).some(Boolean)).track_focus(focus.clearFilters)));
}

function listView(t, screen, actions, focus) {
  const list = v_flex().w_full().gap(9)
    .child(toolbar(t, 'Work items', [
      button(t, 'refresh-work-items', 'Refresh', actions.refresh, 'normal', screen.pending).track_focus(focus.refresh),
      button(t, 'new-work-item', 'New work item', actions.create, 'primary', false, 'add').track_focus(focus.queue)
    ]));
  if (screen.legacy) list.child(notice(t, 'Update Council on the project machine', screen.scope.project));
  if (screen.error) list.child(notice(t, 'Could not read work items', `${screen.scope.project} · ${screen.error}`));
  if (screen.rosterError) list.child(label(screen.rosterError, 12, t.muted).role('status'));
  if (!screen.legacy && (screen.items || screen.pending)) list.child(queueFilters(t, screen, actions, focus));
  if (screen.pending) list.child(label(screen.items ? 'Refreshing work items…' : 'Loading work items…', 12, t.muted).role('status'));
  if (!screen.pending && screen.items?.length === 0) {
    list.child(panel(t).child(cardHeading(t, 'No work items', 'plan'))
      .child(label(Object.values(screen.filters).some(Boolean) ? 'Clear filters to see the full queue.' :
        'This project has no work items yet.', 13, t.muted)));
  }
  list.children((screen.items ?? []).map(item =>
    panel(t).gap(7)
      .child(h_flex().gap(7).flex_wrap().items_center()
        .child(label(item.title, 15, t.foreground).font_semibold().flex_1())
        .child(item.lifecycle ? lifecycleBadge(t, item.lifecycle) : badge(t, item)))
      .child(label(item.lifecycle ? `${item.roleId} · ${capitalize(item.lifecycle.priority)} priority` :
        `Responsible role · ${item.roleId}`, 12, t.muted))
      .child(label(item.lifecycle?.nextAction ?? item.lifecycle?.guidance ?? item.nextAction, 13, t.foreground))
      .when(Boolean(item.lifecycle?.needsAttention || item.attention), card => card.child(label(
        item.attention?.message ?? 'Needs attention', 12, t.blocked)))
      .when(Boolean(item.lifecycle?.blockedBy.length), card => card.child(label(
        `Blockers · ${item.lifecycle.blockedBy.map(link => `${link.title ?? link.id} (${lifecycleLabels[link.state]})`).join(', ')}`, 12, t.muted)))
      .child(h_flex().child(button(t, `open-work-item-${item.id}`, 'Open work item', (_e, cx) => actions.open(cx, item.id), 'normal', false, 'right')
        .accessibility_label(`Open work item ${item.title}`)))));
  if (screen.errors?.length) {
    list.child(panel(t).child(cardHeading(t, 'Work item read issues', 'warning'))
      .children(screen.errors.map(error => v_flex().gap(3).child(label(error.id, 12, t.foreground).font_semibold())
        .child(label(error.message, 12, t.muted)))));
  }
  return list;
}

function criteriaEditor(t, state, active = false) {
  return v_flex().gap(4).key_context('CouncilWorkItemCriteria')
    .on_action('council-work-item-next-field', (_e, cx) => { window.focus_next(); cx.stop_propagation(); })
    .on_action('council-work-item-previous-field', (_e, cx) => { window.focus_prev(); cx.stop_propagation(); })
    .child(label('Acceptance criteria', 12, t.foreground).font_medium())
    .child(label('Enter one criterion per line, in review order.', 12, t.muted))
    .child(Textarea.new(state).w_full().min_w_0().h(100).px(8).py(6).text_size(13)
      .rounded(6).border_1().border_color(active ? t.accent : t.input).bg(t.background).text_color(t.foreground)
      .accessibility_label('Acceptance criteria, one criterion per line'));
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
      .child(criteriaEditor(t, fields.criteria))
      .child(v_flex().gap(5)
        .child(label('Responsible role', 12, t.foreground).font_medium())
        .child(h_flex().gap(5).flex_wrap().role('group').accessibility_label('Responsible role')
          .children(screen.roles.map(({ id, role }) => button(t, `work-item-role-${id}`, role === id ? id : `${role} · ${id}`,
            (_e, cx) => actions.role(cx, id), screen.roleId === id ? 'active' : 'normal')))))
      .child(h_flex().gap(7).flex_wrap()
        .child(button(t, 'save-work-item', 'Save work item', actions.save, 'primary', !screen.roleId, 'check'))
        .child(button(t, 'refresh-work-item-roles', 'Refresh roles', actions.refresh)));
  }
  return card.child(h_flex().child(button(t, 'back-work-items', 'Back to work items', actions.back, 'normal', false, 'back')
    .track_focus(backFocus)));
}

const sourceName = source => source === 'direct_artifact' ? 'Direct artifact' : 'Terminal screen capture';
const readable = (name, value) => value === null || value === undefined ? [] : [[name, value]];

export function workItemHandoff(screen, kind) {
  const { item, archived } = screen;
  const lifecycle = item?.lifecycle;
  if (kind === 'saved' && item?.result && !archived) {
    return { output: item.result.output, source: sourceName(item.result.source),
      nextAction: lifecycle?.nextAction ?? item.nextAction };
  }
  const review = archived ? archived.review : lifecycle?.review;
  if (kind !== 'frozen' || !frozenCaptureMatches(review?.capture)) return null;
  const decision = lifecycle?.decision;
  return { output: review.capture.output, source: sourceName(review.capture.source),
    nextAction: archived ? (decision?.reviewId === review.id ? decision.nextAction : null) :
      lifecycle?.nextAction ?? item.nextAction };
}

function handoffReader(t, reader, ui, actions) {
  const { kind, handoff, editor, focused } = reader;
  const { source, nextAction } = handoff;
  const title = kind === 'saved' ? 'Saved handoff' : 'Frozen output';
  const copyTitle = kind === 'saved' ? 'Copy saved handoff' : 'Copy frozen output';
  return panel(t)
    .child(toolbar(t, title, [
      button(t, 'back-from-handoff', 'Back to work item', actions.closeReader, 'normal', false, 'back'),
      button(t, 'copy-reader-handoff', copyTitle, actions.copyReader, 'normal', false, 'copy')
        .accessibility_label([copyTitle, `Source: ${source}`, nextAction && `Next action: ${nextAction}`].filter(Boolean).join('. '))
        .track_focus(ui.focus.readerCopy)
    ]))
    .child(metadata(t, 'Source', source))
    .when(Boolean(nextAction), card => card.child(metadata(t, 'Next action', nextAction)))
    .child(label('Tab to the output. Use Page Up or Page Down to scroll.', 12, t.muted))
    .child(v_flex().w_full().min_w_0()
      .child(Editor.new(editor).w_full().min_w_0().h(280).p(8).rounded(6).border_1().bg(t.background)
        .border_color(focused ? t.accent : t.input).text_color(t.foreground).accessibility_label(title)));
}

function reviewView(t, review, ui, actions, archived = false) {
  const { capture, formal, definition } = review;
  const captureVerified = frozenCaptureMatches(capture);
  const card = panel(t).child(h_flex().gap(8).flex_wrap().items_center()
    .child(cardHeading(t, archived ? 'Archived review' : 'Frozen review', 'reviews').flex_1())
    .when(Boolean(formal), row => row.child(statusPill(t, formalLabels[formal.state],
      formal.state === 'approved' ? t.done : formal.state === 'pending' ? t.working : t.blocked, t.foreground))))
    .child(label(definition.title, 15, t.foreground).font_semibold())
    .when(captureVerified, section => section.child(h_flex().gap(6).flex_wrap()
      .when(archived, row => row.child(button(t, 'frozen-output-toggle', 'Show frozen output', actions.readFrozen, 'normal', ui.screen.pending)
        .track_focus(ui.focus.output)))
      .child(button(t, 'frozen-output-copy', 'Copy frozen output', actions.copyFrozen))))
    .child(facts(t, [['Review ID', review.id], ['Cycle', review.cycle], ['Work revision', review.workRevision],
      ['Review owner', review.reviewOwnerRoleId], ['Responsible role', definition.roleId],
      ['Policy', review.policy === 'operator' ? 'Operator acceptance' : 'Formal Council review']]))
    .child(metadata(t, 'Snapshot SHA-256', review.snapshotSha256))
    .child(label('Frozen acceptance criteria', 13, t.foreground).font_semibold())
    .child(criteriaList(t, definition.criteria))
    .child(facts(t, [['Attempt session', capture.sessionId], ['Capture source', sourceName(capture.source)],
      ['Capture verification', captureVerified ? 'Verified' : 'Unverified'], ...readable('Capture scope', capture.captureScope),
      ...readable('Turn', capture.turn), ...readable('Completed', capture.completedAt), ['Bytes', capture.byteCount]]))
    .child(metadata(t, 'Capture SHA-256', capture.sha256));
  if (!captureVerified || !review.evidenceToken) card.child(label(
    capture.output === null ? 'The frozen output is unavailable.' :
      'Frozen evidence could not be verified. Refresh the review to check its saved evidence.', 13, t.blocked).role('status'));
  if (archived && capture.verified && ui.archiveExecution) {
    card.child(h_flex().child(button(t, 'archived-execution', 'Open archived delegation', actions.archiveExecution, 'normal', false, 'right')));
  }
  if (formal) {
    card.child(label('Formal Council evidence', 13, t.foreground).font_semibold())
      .child(facts(t, [['Formal status', formalLabels[formal.state]], ...readable('Verdict', formal.verdict),
        ...readable('Formal session', formal.sessionId), ...readable('Round', formal.round)]))
      .children([...readable('Proposal SHA-256', formal.proposalSha256), ...readable('Manifest SHA-256', formal.manifestSha256)]
        .map(([name, value]) => metadata(t, name, value)));
    if (formal.state === 'unverified') card.child(label('The current formal evidence could not be verified.', 13, t.blocked).role('status'));
    if (!archived) card.child(h_flex().gap(6).flex_wrap()
      .child(button(t, 'copy-review-binding', 'Copy formal binding line', actions.copyBinding))
      .when(Boolean(ui.formalLink), row => row.child(button(t, 'open-formal-review', 'Open formal review', actions.formal, 'normal', false, 'right'))));
    else if (ui.formalLink) card.child(h_flex().child(button(t, 'open-archived-formal-review', 'Open formal review',
      actions.formal, 'normal', false, 'right')));
    card.children(formal.dissent.map(({ voter, vote, rationale }) =>
      metadata(t, `Direct formal dissent · ${voter} · ${vote}`, rationale || 'No rationale recorded.')));
  }
  if (review.notes.length) card.child(label('Review notes', 13, t.foreground).font_semibold())
    .children(review.notes.map(note => metadata(t, `${capitalize(note.kind)} · ${note.actor} · ${note.at}`, note.text)));
  return card;
}

function decisionView(t, decision, current, actions) {
  return panel(t).child(cardHeading(t, current ? 'Current decision' : 'Previous decision', 'reviews'))
    .child(facts(t, [['Decision ID', decision.id], ['Disposition', decision.disposition === 'accepted' ? 'Accepted' : 'Changes requested'],
      ['Actor', decision.actor], ['Cycle', decision.cycle], ['Work revision', decision.workRevision],
      ['Review', decision.reviewId], ['Recorded', decision.at]]))
    .child(metadata(t, 'Reason', decision.reason))
    .child(metadata(t, 'Recorded next action', decision.nextAction))
    .when(Boolean(decision.formal), card => card.child(facts(t, [['Formal status at decision', formalLabels[decision.formal.state]],
      ...readable('Formal verdict at decision', decision.formal.verdict)])))
    .child(metadata(t, 'Snapshot SHA-256', decision.snapshotSha256))
    .child(h_flex().child(button(t, 'decision-archived-review', 'Open decision evidence',
      (_e, cx) => actions.archive(cx, decision.reviewId), 'normal', false, 'right')));
}

function editField(t, fields, name, ui) {
  const title = fieldLabels[name];
  return v_flex().gap(4).child(label(title, 12, t.foreground))
    .child(input(t, fields[name]).accessibility_label(title).border_color(ui.activeField === name ? t.accent : t.input));
}

function blockerChoices(t, form, actions) {
  const links = new Map(form.item.lifecycle.blockedBy.map(link => [link.id, link]));
  for (const candidate of form.blockerItems ?? []) {
    // Saved links retain their current resolution even if the queue is partial.
    if (!links.has(candidate.id)) links.set(candidate.id, { id: candidate.id, title: candidate.title, state: candidate.lifecycle.state });
  }
  const choicesByItem = [...links.values()].map(link => {
    const selected = form.blockedBy.includes(link.id);
    return { id: link.id, selected,
      title: `${link.title ?? link.id} · ${lifecycleLabels[link.state]}`,
      disabled: !selected && (link.state === 'unavailable' || form.blockedBy.length >= 20) };
  });
  return choicesByItem.length ? choices(t, 'Blocked by', choicesByItem, (cx, id) => actions.formOption(cx, 'blockedBy', id))
    : label('There are no other readable work items to link in this project.', 12, t.muted);
}

function mutationView(t, screen, ui, actions) {
  const { form } = screen;
  const { operation, item } = form;
  const fields = ui.formFields;
  const labelConfirm = operationLabels[operation][1];
  const body = panel(t).child(cardHeading(t, operationLabels[operation][0], 'plan'))
    .when(Boolean(screen.error && !form.stale), card => card.child(label(screen.error, 12, t.blocked)
      .role('status').accessibility_label(screen.error)))
    .child(facts(t, [['Project', screen.scope.project], ['Expected revision', item.lifecycle.revision]]));
  if (form.stale) return body.child(label('This draft refers to older item or review evidence. Review the latest detail and start a new confirmation.',
    13, t.blocked).role('status'))
    .when(Boolean(form.submitted), card => card.child(facts(t, [['Original request ID', form.submitted.requestId],
      ...readable('Original review', form.submitted.reviewId), ...readable('Original decision', form.submitted.decisionId)])))
    .child(h_flex().gap(6).flex_wrap()
    .when(!screen.staleRead && workItemActionEnabled(screen.item, operation), row => row.child(button(t, 'restart-lifecycle-form', 'Start a new confirmation',
      (_e, cx) => actions.mutate(cx, operation), 'primary')))
    .child(button(t, 'cancel-lifecycle-form', 'Discard stale draft', actions.cancelForm).track_focus(ui.focus.formBack)));
  if (!fields) return body;
  if (operation === 'delegate') {
    body.child(metadata(t, 'Responsible role', item.roleId))
      .child(label('This sends one assignment to the saved role for the current cycle.', 13, t.muted));
  }
  if (operation === 'start' && item.result) body.child(facts(t, [['Candidate source', sourceName(item.result.source)],
    ['Attempt session', item.job.sessionId], ['Work revision', item.lifecycle.workRevision], ['Cycle', item.lifecycle.cycle]]));
  if (['close', 'return'].includes(operation)) {
    const review = item.lifecycle.review;
    body.child(facts(t, [['Frozen review', review.id], ['Current responsible role', item.roleId],
      ['Review owner', review.reviewOwnerRoleId], ['Authority', formalLabels[item.lifecycle.reviewState] ?? 'Unverified']]))
      .child(metadata(t, 'Confirmed snapshot', review.snapshotSha256))
      .child(label('Frozen acceptance criteria', 12, t.foreground))
      .child(criteriaList(t, review.definition.criteria));
  }
  if (operation === 'reopen') {
    const decision = item.lifecycle.decision;
    body.child(facts(t, [['Previous decision', decision.id], ['Disposition', 'Accepted'], ['Previous role', item.roleId],
      ['Previous cycle', decision.cycle]]))
      .child(metadata(t, 'Prior acceptance reason', decision.reason))
      .child(metadata(t, 'Prior snapshot', decision.snapshotSha256))
      .child(label('Reopening creates a new cycle. The new attempt starts only when you delegate it.', 13, t.muted));
  }
  body.child(editField(t, fields, 'actor', ui));
  if (fields.title) {
    body.child(editField(t, fields, 'title', ui))
      .child(criteriaEditor(t, fields.criteria, ui.activeField === 'criteria'));
  }
  if (form.pending) body.child(label('Loading project choices…', 12, t.muted).role('status'));
  if (form.optionsError) body.child(label(form.optionsError, 12, t.blocked).role('status'))
    .child(h_flex().child(button(t, 'refresh-lifecycle-choices', 'Refresh project choices', actions.refreshOptions, 'normal', form.pending)));
  const roleNeeded = ['start', 'return', 'reopen'].includes(operation);
  if ((roleNeeded || fields.title) && form.roles?.length) {
    body.child(choices(t, operation === 'start' ? 'Review owner' : 'Responsible role',
      form.roles.map(({ id, role }) => option(id, id === role ? id : `${role} · ${id}`, form.roleId)),
      (cx, id) => actions.formOption(cx, 'roleId', id)));
  } else if (roleNeeded && !form.pending) body.child(label('No Team role is available in this project.', 12, t.blocked));
  if (operation === 'triage') {
    body.child(choices(t, 'Priority', workItemPriorities.map(id => option(id, capitalize(id), form.priority)),
      (cx, id) => actions.formOption(cx, 'priority', id)))
      .child(blockerChoices(t, form, actions));
    if (form.blockerErrors?.length) body.child(label('Some work items could not be read. Existing unresolved links are shown above.', 12, t.blocked));
  }
  if (operation === 'start') {
    const policies = form.formalRequired ? ['formal'] : ['operator', 'formal'];
    if (form.policyUnknown) body.child(label(
      'Refresh the item or update Council on the project machine to check whether operator acceptance is available.',
      12, t.foreground).role('status'));
    else if (form.formalRequired) body.child(label('This item requires a formal Council review.', 12, t.foreground));
    body.child(choices(t, 'Review policy', policies.map(id =>
      option(id, id === 'operator' ? 'Operator acceptance' : 'Formal Council review', form.policy)),
    (cx, id) => actions.formOption(cx, 'policy', id)));
  }
  if (operation === 'note') body.child(choices(t, 'Note type', ['finding', 'dissent'].map(id => option(id, capitalize(id), form.noteKind)),
    (cx, id) => actions.formOption(cx, 'noteKind', id)));
  const details = ['text', 'formalSessionId', 'round', 'reason', 'nextAction']
    .filter(key => fields[key]).map(key => editField(t, fields, key, ui));
  if (ui.wide && details.length === 2) {
    body.child(h_flex().gap(10).children(details.map(element => element.min_w_0().flex_1())));
  } else {
    body.children(details);
  }
  return body.child(h_flex().gap(7).flex_wrap()
    .child(button(t, 'confirm-lifecycle-action', labelConfirm, actions.confirm, 'primary',
      screen.pending || form.pending || (roleNeeded && !form.roleId), 'check').track_focus(ui.focus.confirm))
    .child(button(t, 'cancel-lifecycle-form', 'Cancel', actions.cancelForm, 'normal', false, 'back').track_focus(ui.focus.formBack)));
}

function mutationRecovery(t, attempt, actions) {
  const { phase, input, operation } = attempt;
  const busy = ['writing', 'checking'].includes(phase);
  const heading = phase === 'writing' ? 'Submitting request…' : phase === 'checking' ? 'Checking the request receipt…' : 'Confirm the saved request';
  return panel(t).role('status').child(cardHeading(t, heading, 'working'))
    .child(facts(t, [['Action', operationLabels[operation][0]], ['Request ID', input.requestId], ['Expected revision', input.ifRevision],
      ['Actor', input.actor], ...readable('Responsible role', input.roleId ?? input.reviewOwnerRoleId),
      ...readable('Reason', input.reason), ...readable('Next action', input.nextAction), ...readable('Review', input.reviewId),
      ...readable('Policy', input.policy), ...readable('Decision', input.decisionId), ...readable('Note', input.text),
      ...readable('Formal session', input.formalSessionId), ...readable('Round', input.round)]))
    .when(Boolean(input.patch), card => card.child(facts(t, [
      ...readable('Title', input.patch.title), ...readable('Role', input.patch.roleId), ...readable('Priority', input.patch.priority),
      ...readable('Blockers', input.patch.blockedBy?.join(', ') ?? (input.patch.blockedBy ? 'None' : null)),
      ...readable('Next action', input.patch.nextAction)
    ])).when(Boolean(input.patch.criteria), panel => panel.child(criteriaList(t, input.patch.criteria))))
    .when(Boolean(attempt.message), card => card.child(label(attempt.message, 13, t.foreground)))
    .when(!busy, card => card.child(h_flex().gap(7).flex_wrap()
      .child(button(t, 'reconcile-lifecycle-action', 'Refresh saved request', actions.refresh))
      .when(phase === 'missing', row => row.child(button(t, 'retry-lifecycle-action', 'Resend same request', actions.replay)))));
}

function historyView(t, history, actions) {
  const card = panel(t).child(cardHeading(t, 'Work item history', 'list'));
  if (history.error) card.child(label(history.error, 12, t.blocked).role('status'));
  if (history.integrity) card.child(label(history.integrity.message, 12, t.blocked).role('status'));
  if (history.pending) card.child(label('Loading history…', 12, t.muted).role('status'));
  if (!history.pending && !history.error && !history.events.length) card.child(label('No history was returned.', 12, t.muted));
  card.children(history.events.map(event => {
    const refs = event.references;
    const fields = [['Revision', event.revision], ['Cycle', event.cycle], ['Work revision', event.workRevision],
      ...readable('Actor', event.actor), ...readable('Recorded', event.at), ...readable('Decision', refs.decisionId),
      ...readable('Attempt session', refs.sessionId), ...readable('Snapshot SHA-256', refs.snapshotSha256)];
    return v_flex().gap(6).pt(6).border_t_1().border_color(t.border)
      .child(label(capitalize(event.type.replaceAll('_', ' ')), 13, t.foreground).font_medium())
      .child(facts(t, fields))
      .when(/^review-[1-9][0-9]*$/.test(refs.reviewId), row => row.child(h_flex().child(button(t, `history-review-${event.revision}`,
        `Open ${refs.reviewId}`, (_e, cx) => actions.archive(cx, refs.reviewId), 'normal', false, 'right'))));
  }));
  if (history.nextBeforeRevision) card.child(h_flex().child(button(t, 'work-item-history-more', 'Load older history', actions.moreHistory,
    'normal', history.pending)));
  return card;
}

function detailView(t, screen, ui, actions) {
  const item = screen.item;
  const mutation = ui.mutation;
  const busy = ['writing', 'checking'].includes(mutation?.phase);
  const inspecting = !screen.form || screen.form.stale;
  const saved = inspecting && !screen.archived && Boolean(item?.result);
  const frozen = inspecting && !screen.archived && frozenCaptureMatches(item?.lifecycle?.review?.capture);
  const controls = [
    button(t, 'back-work-items', 'Back to work items', actions.back, 'normal', false, 'back').track_focus(ui.focus.back),
    button(t, 'refresh-work-item', 'Refresh', actions.refresh, 'normal', screen.pending || busy).track_focus(ui.focus.refresh)
  ];
  if (saved) controls.push(
    button(t, 'read-work-item-output', 'Read saved handoff', actions.readOutput, 'normal', screen.pending, 'file')
      .track_focus(ui.focus.readOutput),
    button(t, 'copy-work-item-output', 'Copy saved handoff', actions.copyOutput,
      'normal', false, 'copy').track_focus(ui.focus.copyOutput));
  if (frozen) controls.push(button(t, 'frozen-output-toggle', 'Show frozen output', actions.readFrozen, 'normal', screen.pending)
    .track_focus(ui.focus.output));
  if (inspecting && item?.job?.linked && !screen.archived) controls.push(button(t, 'open-work-item-delegation', 'Open delegation',
    actions.delegation, 'normal', false, 'right').track_focus(ui.focus.openDelegation));
  if (item?.lifecycle) {
    controls.unshift(lifecycleBadge(t, item.lifecycle));
    if (inspecting) controls.push(button(t, 'work-item-open-history', screen.history ? 'Refresh history' : 'View history', actions.history,
      'normal', screen.history?.pending).track_focus(ui.focus.history));
  } else if (item) controls.unshift(badge(t, item));
  const body = v_flex().w_full().gap(9).child(toolbar(t, item?.title ?? 'Work item', controls, saved || frozen));
  if (screen.error && (inspecting || mutation)) body.child(notice(t, 'Work item request failed', `${screen.scope.project} · ${screen.error}`));
  if (screen.pending) body.child(label(item ? 'Refreshing work item…' : 'Loading work item…', 12, t.muted).role('status'));
  if (screen.archived) {
    body.child(h_flex().gap(6).flex_wrap()
      .child(button(t, 'close-archived-review', 'Back to history', actions.closeArchive, 'normal', false, 'back').track_focus(ui.focus.archive))
      .when(Boolean(screen.archived.error), row => row.child(button(t, 'retry-archived-review', 'Refresh archived review',
        (_e, cx) => actions.archive(cx, screen.archived.id)))));
    if (screen.archived.pending) body.child(label('Loading archived review…', 12, t.muted).role('status'));
    if (screen.archived.error) body.child(notice(t, 'Archived evidence could not be read', screen.archived.error));
    if (screen.archived.review) body.child(reviewView(t, screen.archived.review, ui, actions, true));
    return body;
  }
  if (mutation) body.child(mutationRecovery(t, mutation, actions));
  if (inspecting && screen.receipt) body.child(label(
    `Saved request ${screen.receipt.requestId} · revision ${screen.receipt.revision}`, 12, t.foreground).role('status'));
  if (inspecting && screen.history) body.child(historyView(t, screen.history, actions));
  if (!item) {
    if (screen.error && !screen.pending && screen.plane) body.child(planePanel(t, screen.plane));
    return body;
  }
  const lifecycle = item.lifecycle;
  if (!lifecycle) body.child(notice(t, 'Update Council on the project machine',
    'This engine can read the previous execution view. Update it to make lifecycle changes.'));
  if (lifecycle?.integrity) body.child(notice(t, 'Work item integrity issue', lifecycle.integrity.message));
  if (screen.form && !mutation) {
    body.child(mutationView(t, screen, ui, actions));
    if (!screen.form.stale) return body;
  }
  if (lifecycle && !mutation && !screen.form && !screen.staleRead) {
    const available = Object.keys(operationLabels).filter(operation => workItemActionEnabled(item, operation));
    if (available.length) body.child(h_flex().gap(7).flex_wrap().children(available.map(operation => button(t,
      `work-item-${operation}`, operationLabels[operation][0], (_e, cx) => actions.mutate(cx, operation),
      ['start', 'close'].includes(operation) ? 'primary' : 'normal', screen.pending)
      .when(operation === 'delegate', control => control.track_focus(ui.focus.delegate)))));
  }
  if (screen.plane) body.child(planePanel(t, screen.plane));
  if (lifecycle?.review) body.child(reviewView(t, lifecycle.review, ui, actions));
  body.child(panel(t).child(facts(t, [['Work item ID', item.id], ['Responsible role', item.roleId]]))
    .child(metadata(t, 'Project', screen.scope.project))
    .when(Boolean(lifecycle), card => card.child(facts(t, [['Revision', lifecycle.revision], ['Work revision', lifecycle.workRevision],
      ['Cycle', lifecycle.cycle], ['Priority', capitalize(lifecycle.priority)],
      ...(lifecycle.state === 'open' ? [['Execution', stateLabels[item.state][0]]] : [])]))
      .child(metadata(t, 'Guidance', lifecycle.guidance))
      .when(Boolean(lifecycle.needsAttention), node => node.child(label('Needs attention', 12, t.blocked))))
    .child(metadata(t, 'Next action', lifecycle?.nextAction ?? item.nextAction))
    .child(label('Acceptance criteria', 13, t.foreground).font_semibold())
    .child(criteriaList(t, item.criteria)));
  if (item.attention) body.child(notice(t, 'Needs attention', item.attention.message));
  if (lifecycle?.blockedBy.length) body.child(panel(t).child(cardHeading(t, 'Linked blockers', 'warning'))
    .children(lifecycle.blockedBy.map(link => h_flex().gap(8).flex_wrap().items_center()
      .child(metadata(t, link.title ?? link.id, lifecycleLabels[link.state]))
      .when(link.state !== 'unavailable', row => row.child(button(t, `open-blocker-${link.id}`, 'Open blocker',
        (_e, cx) => actions.open(cx, link.id), 'normal', false, 'right').accessibility_label(`Open blocker ${link.title ?? link.id}`))))));
  if (lifecycle?.decision) body.child(decisionView(t, lifecycle.decision, lifecycle.decision.cycle === lifecycle.cycle, actions));
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

const planeActions = { link: 'Link Plane item', prepare: 'Prepare Plane update', check: 'Check delivery' };
const planeStates = {
  prepared: 'Preview prepared. Confirm it in the operator console.',
  approved_unsent: 'Approval recorded. Update unsent. A fresh confirmation is required.',
  expired: 'Preview expired. Update unsent.',
  cancelled: 'Preview cancelled. Update unsent.',
  conflict: 'The preview conflicts with current evidence or target. Update unsent.',
  offline: 'The preview could not be verified offline. Update unsent.',
  delivery_uncertain: 'Delivery unverified. Check the original operation in the operator console.',
  published: 'Published'
};
const planeProblems = {
  unavailable: 'Plane status is unavailable. Refresh or update Council on the project machine.',
  installation_unverified: 'The Council installation identity is unavailable. Refresh or update Council to verify it.',
  invalid_input: 'This Council installation could not read the Plane selection. Refresh or update Council.',
  not_found: 'The selected Plane record could not be read.',
  plane_disabled: 'Plane publishing is disabled for this installation.',
  operator_required: 'The trusted operator console is unavailable for this selection.',
  offline: 'Council is offline for this Plane selection.',
  authorization_denied: 'The operator is not authorized for this Plane selection.',
  stale_preview: 'The selected preview is out of date. Verify it again in the operator console.',
  scope_conflict: 'The Plane target no longer matches the verified scope.',
  evidence_unverified: 'The evidence could not be verified.',
  storage_error: 'The local Plane projection could not be read.',
  integrity_error: 'The Plane evidence does not match the verified record.',
  receipt_not_proven: 'A matching receipt has not been verified.'
};
const handoffNotes = {
  link: 'Verify the Plane origin, workspace, project and item IDs in the console before confirming the link.',
  prepare: 'Enter the evidence URL and review the target, preview and INTERNAL visibility in the console before confirming publication.',
  check: 'Use Check delivery for the original operation in the console. This check only reads Plane.'
};

function planeStatus(plane) {
  if (!plane.checked || plane.pending) return 'Reading Plane status…';
  if (plane.issue) return planeProblems[plane.issue];
  if (plane.availability === 'disabled') return planeProblems.plane_disabled;
  if (plane.freshness === 'unavailable') return planeProblems.unavailable;
  if (plane.availability === 'read_only') return 'Plane metadata is read-only here.';
  if (plane.freshness === 'cached') return 'Showing cached Plane metadata.';
  return plane.link ? 'Current linked Plane item.' : 'No Plane item linked.';
}

function planeReceipt(t, plane, operation, previous = false) {
  const { receipt, status, evidenceUrl, itemRevision, operationId, visibility } = operation;
  const older = itemRevision < plane.screen.item?.lifecycle?.revision;
  const source = receipt.source === 'response' ? 'Verified response' : 'Read-only reconciliation';
  const title = previous ? 'Previously verified receipt' : 'Published';
  return v_flex().w_full().gap(5)
    .child(label(older ? `${title} · Older work item revision` : title, 13, t.foreground).font_semibold())
    .child(facts(t, [['Receipt', receipt.commentId], ['Operation', operationId], ['Work item revision', itemRevision],
      ['Status', lifecycleLabels[status]], ['Visibility', visibility], ['Verification source', source], ['Verified at', receipt.verifiedAt]]))
    .child(metadata(t, 'Evidence URL', evidenceUrl))
    .child(h_flex().child(button(t, `copy-plane-receipt-${operationId}`, 'Copy receipt ID', (_e, cx) => {
      if (plane.options.active() && plane.receipts.includes(operation)) cx.write_to_clipboard(receipt.commentId);
    }, 'normal', false, 'copy').accessibility_label(`Copy receipt ID ${receipt.commentId}. ${title}. Source: ${source}. Evidence: ${evidenceUrl}`)));
}

function planePanel(t, plane) {
  const { link, operation, handoff, action, freshness } = plane;
  const status = planeStatus(plane);
  const operationStatus = operation && planeStates[operation.state];
  const run = (cx, task) => cx.spawn(async cx => {
    const read = task();
    cx.notify();
    await read;
    if (plane.options.active() && plane.handoff && plane.refreshFocus?.is_focused()) plane.referenceFocus?.focus();
    cx.notify();
  });
  const card = panel(t).id(`work-item-plane-${plane.viewId}`)
    // Start the side read after the Work item is rendered so a slow Plane reader cannot hold up the detail.
    .on_size_change((_size, cx) => {
      if (plane.checked || !plane.options.active()) return;
      plane.refreshFocus = cx.focus_handle();
      plane.referenceFocus = cx.focus_handle();
      run(cx, () => plane.refresh());
    })
    .child(h_flex().gap(7).items_center().flex_wrap().child(cardHeading(t, 'Plane', 'project').flex_1())
      .child(button(t, 'refresh-plane', 'Refresh Plane status', (_e, cx) => run(cx, () => plane.refresh()))
        .accessibility_label([`Refresh Plane status. ${status}`, operationStatus].filter(Boolean).join(' '))
        .when(Boolean(plane.refreshFocus), node => node.track_focus(plane.refreshFocus)))
      .when(Boolean(action), row => row.child(button(t, 'open-plane-console', planeActions[action], (_e, cx) => {
        if (plane.action !== action) return;
        plane.refreshFocus?.focus();
        run(cx, () => plane.open(action));
      }))))
    .child(label(status, 12, plane.issue ? t.blocked : t.muted).role('status').accessibility_label(status));
  if (handoff) {
    const instruction = handoff.disposition === 'operator_console' ? 'Continue in the trusted Council operator console.' :
      'Open the installed Council operator console in the authenticated operator session.';
    card.child(label(`${instruction} ${handoffNotes[handoff.intent]}`, 13, t.foreground).role('status'))
      .child(metadata(t, 'Operator reference', handoff.localRef))
      .child(h_flex().child(button(t, 'copy-plane-reference', 'Copy operator reference', (_e, cx) => {
        if (plane.options.active() && plane.handoff === handoff) cx.write_to_clipboard(handoff.localRef);
      }, 'normal', false, 'copy')
        .accessibility_label(`Copy operator reference ${handoff.localRef}. ${instruction}`)
        .when(Boolean(plane.referenceFocus), node => node.track_focus(plane.referenceFocus))));
  }
  if (link) {
    const target = `Instance ${link.instanceLabel}, workspace ${link.workspaceSlug}, project ${link.projectKey}, item ${link.itemIdentifier}`;
    const idsTitle = plane.showIds ? 'Hide target UUIDs' : 'Show target UUIDs';
    card.child(facts(t, [['Instance', link.instanceLabel], ['Workspace', link.workspaceSlug], ['Project', link.projectKey],
      ['Plane item', link.itemIdentifier], ['Freshness', freshness === 'current' ? 'Current' : 'Cached']]))
      .child(h_flex().child(button(t, 'plane-target-ids', idsTitle, (_e, cx) => {
        if (!plane.options.active()) return;
        plane.showIds = !plane.showIds;
        cx.notify();
      }).accessibility_label(`${idsTitle}. ${target}${plane.showIds ?
        `. Instance UUID ${link.instanceId}, workspace UUID ${link.workspaceId}, project UUID ${link.projectId}, item UUID ${link.itemId}` : ''}`)));
    if (plane.showIds) card.child(facts(t, [['Instance UUID', link.instanceId], ['Workspace UUID', link.workspaceId],
      ['Project UUID', link.projectId], ['Item UUID', link.itemId]]));
  }
  if (operation?.receipt) card.child(planeReceipt(t, plane, operation));
  else if (operation) {
    card.child(label(planeStates[operation.state], 13, t.foreground).role('status'))
      .child(facts(t, [['Operation', operation.operationId], ['Work item revision', operation.itemRevision]]));
    if (operation.reason && planeProblems[operation.reason]) card.child(label(planeProblems[operation.reason], 12, t.muted));
  }
  card.children(plane.receipts.filter(value => value !== operation).map(value => planeReceipt(t, plane, value, true)));
  return card;
}

export function workItemView(t, screen, ui, actions) {
  if (!screen) {
    return panel(t).role('status').child(cardHeading(t, 'Loading work items…', 'plan'));
  }
  if (screen.kind === 'create') return createView(t, screen, ui.fields, ui.attempt, actions, ui.focus.back);
  if (ui.reader) return handoffReader(t, ui.reader, ui, actions);
  if (screen.kind === 'detail') return detailView(t, screen, ui, actions);
  return listView(t, screen, actions, ui.focus);
}
