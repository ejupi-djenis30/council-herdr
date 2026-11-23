import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { button, cardHeading, field, iconTile, label, panel, statusPill } from './components.js';
import { taskAgents } from './task-launch.js';

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

export function taskEditor(t, form, actions) {
  const member = form.member;
  const choose = key => (cx, value) => { form[key] = value; cx.notify(); };
  return panel(t).child(cardHeading(t, member ? `Call ${member.role}` : 'Delegate task', 'delegations'))
    .child(label(form.project, 12, t.muted))
    .when(Boolean(member), node => node.child(label([member?.agent, member?.model,
      member?.permission === 'write' ? 'Write access' : 'Read only'].filter(Boolean).join(' · '), 12, t.foreground)))
    .when(!member, node => node
      .child(choices(t, 'Agent', taskAgents.map(agent => [agent, agent]), form.agent, choose('agent'), actions.saving))
      .child(choices(t, 'Project access', [['read', 'Read only'], ['write', 'Write']], form.permission, choose('permission'), actions.saving)))
    .child(field(t, 'Task', form.task))
    .child(field(t, 'Deadline (seconds)', form.timeout))
    .child(h_flex().gap(7)
      .child(button(t, 'start-task', member ? 'Call member' : 'Start delegation', (_e, cx) => actions.submit(cx), 'primary', actions.saving))
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
