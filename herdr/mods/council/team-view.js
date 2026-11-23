import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState } from 'gpui-base';
import { button, cardHeading, field, iconTile, label, panel, statusPill } from './components.js';
import { taskAgents, workflowModes, workflowRoles } from './task-launch.js';

const states = { off: 'Off', running: 'Running', starting: 'Starting', stopping: 'Stopping', attention: 'Needs attention' };

function choices(t, title, options, value, pick, disabled) {
  return v_flex().gap(5)
    .child(label(title, 11, t.muted))
    .child(h_flex().gap(5).flex_wrap().children(options.map(([id, text]) =>
      button(t, `${title}-${id}`, text, (_e, cx) => pick(cx, id), id === value ? 'active' : 'normal', disabled))));
}

export function teamEditor(t, roster, form, actions) {
  const choose = key => (cx, value) => {
    form[key] = value;
    cx.notify();
  };
  const managers = roster.members.filter(member => member.id !== form.memberId);
  const supportsModel = roster.modelAgents.includes(form.agent);
  return panel(t).child(cardHeading(t, form.memberId ? `Edit ${form.memberId}` : 'Add team member', 'team'))
    .when(!form.memberId, node => node.child(field(t, 'Member ID', form.id)))
    .child(field(t, 'Role', form.role))
    .child(choices(t, 'Agent', roster.agents.map(id => [id, id]), form.agent, choose('agent'), actions.saving))
    .when(supportsModel, node => node.child(field(t, 'Model ID (optional)', form.model)))
    .child(choices(t, 'Reports to', [['', 'No manager'], ...managers.map(person => [person.id, person.id])],
      form.reportsTo, choose('reportsTo'), actions.saving))
    .child(choices(t, 'Project access', [['read', 'Read only'], ['write', 'Write']],
      form.permission, choose('permission'), actions.saving))
    .child(field(t, 'Responsibilities (optional)', form.instructions))
    .child(h_flex().gap(7).child(button(t, 'save-team', 'Save member', (_e, cx) => actions.save(cx, {
      id: form.memberId || form.id.value(), role: form.role.value(), agent: form.agent,
      model: supportsModel ? form.model.value() : '', permission: form.permission,
      reportsTo: form.reportsTo, instructions: form.instructions.value()
    }), 'primary', actions.saving)).child(button(t, 'cancel-team', 'Cancel', (_e, cx) => actions.cancel(cx), 'normal', actions.saving)));
}

const agentChoices = taskAgents.map(id => [id, id]);

function chooseValue(object, key) {
  return (cx, value) => { object[key] = value; cx.notify(); };
}

function assignmentFields(t, form, saving) {
  const pipeline = form.mode === 'pipeline';
  const rows = pipeline ? form.stages : form.assignments;
  const noun = pipeline ? 'stage' : 'assignment';
  const keys = id => pipeline ? ['stageName' + id, 'stageTask' + id] : ['assignment' + id];
  const move = (index, offset, cx) => {
    const [row] = rows.splice(index, 1);
    rows.splice(index + offset, 0, row);
    cx.notify();
  };
  const cards = rows.map((row, index) => {
    const title = (pipeline ? 'Stage ' : 'Assignment ') + (index + 1);
    const [primary, secondary] = keys(row.id);
    return v_flex().w_full().gap(7).p(10).rounded(6).border_1().border_color(t.border)
      .child(field(t, pipeline ? title + ' name' : title, form[primary]))
      .when(pipeline, box => box.child(field(t, title + ' instructions (optional)', form[secondary])))
      .child(choices(t, title + ' agent', agentChoices, row.agent, chooseValue(row, 'agent'), saving))
      .when(pipeline, box => box.child(choices(t, title + ' role', [['author', 'Author'], ['reviewer', 'Reviewer']],
        row.role, chooseValue(row, 'role'), saving)))
      .child(h_flex().gap(5).flex_wrap()
        .when(pipeline, bar => bar.child(button(t, 'up-' + row.id, 'Move up', (_e, cx) => move(index, -1, cx), 'normal', saving || index === 0))
          .child(button(t, 'down-' + row.id, 'Move down', (_e, cx) => move(index, 1, cx), 'normal', saving || index === rows.length - 1)))
        .child(button(t, 'remove-' + noun + row.id, 'Remove ' + noun, (_e, cx) => {
          rows.splice(index, 1);
          for (const key of keys(row.id)) {
            form.inputs = form.inputs.filter(input => input !== form[key]);
            form[key].release();
            delete form[key];
          }
          cx.notify();
        }, 'normal', saving || rows.length === 1)));
  });
  return v_flex().gap(7).children(cards).child(button(t, 'add-' + noun, 'Add ' + noun, (_e, cx) => {
    const id = form.nextRowId++;
    rows.push({ id, agent: taskAgents[rows.length % taskAgents.length], ...(pipeline ? { role: 'author' } : {}) });
    const names = keys(id);
    for (const key of names) {
      form[key] = InputState.new();
      form.inputs.push(form[key]);
    }
    form[names[0]].focus();
    cx.notify();
  }, 'normal', saving, 'add'));
}

export function workflowFields(t, form, saving) {
  const { member, mode } = form;
  const roles = workflowRoles[mode];
  const canAdopt = !member && mode === 'delegate' && form.kind === 'task';
  const usingExisting = canAdopt && form.target === 'existing';
  return v_flex().w_full().gap(10)
    .when(!member, node => node.child(choices(t, 'Workflow', workflowModes, mode, chooseValue(form, 'mode'), saving)))
    .child(field(t, 'Task', form.task))
    .when(Boolean(member), node => node.child(label([member.agent, member.model,
      member.permission === 'write' ? 'Write access' : 'Read only'].filter(Boolean).join(' · '), 12, t.foreground)))
    .when(canAdopt, node => node.child(choices(t, 'Target', [['new', 'New agent'], ['existing', 'Existing terminal']],
      form.target, chooseValue(form, 'target'), saving)))
    .when(usingExisting, node => node.child(field(t, 'Terminal ID on this host (e.g. t123)', form.adoptAddress))
      .child(label('The terminal keeps its current project access and stays open after the task.', 12, t.muted)))
    .when(!member && mode === 'delegate' && !usingExisting, node => node.child(choices(t, 'Agent', agentChoices, form.agent, chooseValue(form, 'agent'), saving)))
    .when(!member && Boolean(roles), node => node.children(roles.map((role, index) =>
      choices(t, role, agentChoices, form.roleAgents[index], chooseValue(form.roleAgents, index), saving))))
    .when(mode === 'council' || mode === 'review', node => node.child(choices(t, 'Representative',
      [['', mode === 'council' ? 'Elected' : 'Default reviewer'], ...roles.map(role => [mode + '-' + role.toLowerCase(), role])],
      form.representatives[mode], chooseValue(form.representatives, mode), saving)))
    .when(mode === 'parallel' || mode === 'pipeline', node => node.child(assignmentFields(t, form, saving)))
    .when(mode !== 'delegate', node => node.child(field(t, 'Context (optional)', form.context))
      .child(field(t, 'Decision criteria (optional)', form.criteria)))
    .when(!member && !usingExisting, node => node.child(choices(t, 'Project access', [['read', 'Read only'], ['write', 'Write']],
      form.permission, chooseValue(form, 'permission'), saving))
      .child(choices(t, 'Completed terminals', [[false, 'Close'], [true, 'Keep open']],
        form.keepTerminals, chooseValue(form, 'keepTerminals'), saving)))
    .child(field(t, 'Deadline (seconds)', form.timeout));
}

export function taskEditor(t, form, actions) {
  const member = form.member;
  return panel(t).child(cardHeading(t, member ? `Call ${member.role}` : 'Start workflow', 'delegations'))
    .child(label(form.project, 12, t.muted))
    .child(workflowFields(t, form, actions.saving))
    .child(h_flex().gap(7)
      .child(button(t, 'start-task', member ? 'Call member' : 'Start workflow', (_e, cx) => actions.submit(cx), 'primary', actions.saving))
      .child(button(t, 'cancel-task', 'Cancel', (_e, cx) => actions.cancel(cx), 'normal', actions.saving)));
}

export function teamView(t, roster, actions) {
  const colors = { off: t.muted, running: t.accent, attention: t.blocked };
  const cards = roster.members.map(member => panel(t)
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(iconTile(t, 'team', 30))
        .child(v_flex().flex_1().min_w_0().gap(2)
          .child(label(member.role, 14, t.foreground).font_semibold())
          .child(label([member.id, member.agent, member.model].filter(Boolean).join(' · '), 12, t.muted)))
        .child(statusPill(t, states[member.state], colors[member.state]))
        .child(button(t, `edit-${member.id}`, 'Edit', (_e, cx) => actions.edit(cx, member))))
      .when(Boolean(member.instructions), node => node.child(label(member.instructions, 12, t.foreground)))
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(label(member.reportsTo ? `Reports to ${member.reportsTo}` : 'No manager', 12, t.muted))
        .child(div().flex_1())
        .child(button(t, `call-${member.id}`, 'Call member', (_e, cx) => actions.call(cx, member)))
        .when(Boolean(member.sessionId), node => node.child(button(t, `turn-${member.id}`, 'Latest turn',
          (_e, cx) => actions.open(cx, member.sessionId))))));
  return v_flex().gap(8)
    .when(!cards.length, body => body.child(panel(t).child(cardHeading(t, 'No team members', 'team'))))
    .children(cards);
}
