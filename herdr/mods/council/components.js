import { div, svg } from 'gpui-kit';
import { Button, h_flex, v_flex, Input } from 'gpui-base';

export function label(value, size = 13, color) {
  return div().min_w_0().text_size(size).whitespace_normal().child(String(value))
    .when(Boolean(color), node => node.text_color(color));
}

export function glyph(name, size = 15) {
  return svg(`mods/council/icons/${name === 'debates' || name === 'team' ? 'people' : name}.svg`).size(size).flex_shrink_0();
}

export function brandMark(size = 36) {
  return h_flex().size(size).rounded(8).items_center().justify_center().flex_shrink_0()
    .border_1().border_color('#705bb2').bg('#211945').text_color('#d2c6ff')
    .child(glyph('brand', Math.round(size * 0.64)));
}

export function iconTile(t, name, size = 34) {
  return h_flex().size(size).flex_shrink_0().rounded(8).bg(t.selected)
    .text_color(t.accent).items_center().justify_center().child(glyph(name, 17));
}

export function cardHeading(t, title, icon) {
  return h_flex().gap(7).items_center()
    .child(glyph(icon, 15).text_color(t.accent))
    .child(label(title, 14, t.foreground).font_semibold());
}

export function button(t, id, title, click, variant = 'normal', disabled = false, icon) {
  const primary = variant === 'primary';
  const active = variant === 'active';
  return Button.new(id).h(30).px(9).rounded(6).items_center().justify_center()
    .text_size(12).font_medium().border_1()
    .border_color(active ? t.accent : primary ? t.solid : t.border)
    .bg(primary ? t.solid : active ? t.selected : t.surface)
    .text_color(primary ? t.solid_foreground : t.foreground)
    .disabled(disabled).selected(active).tab_stop(!disabled)
    .accessibility_label(title || id).focus(s => s.border_color(primary ? t.solid_foreground : t.accent))
    .when(disabled, node => node.opacity(0.5))
    .when(!disabled, node => node.cursor_pointer().hover(s => s.bg(primary ? t.accent : t.raised))
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation()).on_click(click))
    .child(h_flex().gap(5).items_center()
      .when(Boolean(icon), node => node.child(glyph(icon, 14)))
      .when(Boolean(title), node => node.child(title)));
}

export function panel(t) {
  return v_flex().w_full().min_w_0().flex_shrink_0().gap(10).p(14).rounded(9)
    .border_1().border_color(t.border).bg(t.surface);
}

export function sectionTab(t, id, title, selected, click, disabled = false) {
  return Button.new(id).flex_1().min_w_0().h(34).items_center().justify_center().px(5).rounded(7)
    .disabled(disabled).selected(selected).tab_stop(!disabled).role('tab').accessibility_label(title)
    .border_1().border_color(t.background).focus(s => s.border_color(t.accent))
    .when(selected, node => node.bg(t.selected))
    .text_color(selected ? t.foreground : t.muted).text_size(12).font_semibold()
    .when(!disabled, node => node.cursor_pointer().hover(s => s.bg(t.raised))
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation()).on_click(click))
    .child(h_flex().gap(7).min_w_0().items_center()
      .child(glyph(id, 16).text_color(selected ? t.accent : t.muted))
      .child(div().min_w_0().truncate().child(title)));
}

export function columns(wide, primary, secondary, primaryWidth = 270) {
  if (!secondary) return primary;
  if (!wide) return v_flex().w_full().gap(10).child(primary).child(secondary);
  return h_flex().w_full().items_start().gap(10)
    .child(div().w(primaryWidth).min_w_0().flex_shrink_0().child(primary))
    .child(div().min_w_0().flex_1().child(secondary));
}

export function input(t, state, icon) {
  const control = Input.new(state).w_full().min_w_0().h(34).px(9).text_size(13).text_color(t.foreground).tab_stop(true);
  if (icon === 'search') control.accessibility_label('Search by title, project or ID');
  if (!icon) return control.rounded(6).border_1().border_color(t.input).bg(t.background);
  return h_flex().w_full().min_w_0().items_center().pl(10).rounded(6).border_1()
    .border_color(t.input).bg(t.background)
    .child(glyph(icon, 15).text_color(t.muted)).child(control.flex_1());
}

export function field(t, name, state) {
  return v_flex().w_full().min_w_0().gap(4)
    .child(label(name, 11, t.muted)).child(input(t, state).accessibility_label(name));
}

export function statusDot(color) {
  return div().w(6).h(6).rounded(3).bg(color).flex_shrink_0();
}

export function statusPill(t, title, color = t.muted) {
  return h_flex().gap(5).items_center().px(7).py(4).rounded(5).bg(t.raised).flex_shrink_0()
    .child(statusDot(color)).child(label(title, 11, color).font_medium());
}

export function progress(t, title, count, total, color = t.accent) {
  const percent = total > 0 ? Math.round(100 * count / total) : 0;
  const width = total > 0 ? Math.max(0, Math.min(100, 100 * count / total)) : 0;
  return v_flex().w_full().gap(5)
    .child(h_flex().w_full().gap(8).justify_between()
      .child(label(title, 12, t.foreground).flex_1())
      .child(label(`${count}  ·  ${percent}%`, 11, t.muted).flex_shrink_0()))
    .child(div().h(8).w_full().rounded(4).bg(t.raised).overflow_hidden()
      .when(width > 0, node => node.child(div().h_full().w(`${width}%`).rounded(4).bg(color))));
}

export function reviewStatus(status) {
  const names = {
    approved: 'Approved',
    archived: 'Archived',
    closed: 'Closed',
    open: 'Open',
    pending: 'Awaiting verdict',
    pending_result: 'Awaiting result',
    completed: 'Result ready',
    incomplete: 'Incomplete',
    provisional: 'Provisional',
    failed_quorum: 'Quorum failed',
    invalid_ballots: 'Invalid ballots',
    rejected: 'Rejected',
    unconfirmed: 'Approval unconfirmed'
  };
  return names[status] ?? String(status).replace(/_/g, ' ');
}
