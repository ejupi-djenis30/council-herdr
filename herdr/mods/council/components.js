import { div } from 'gpui-kit';
import { h_flex, v_flex, Input } from 'gpui-base';

export function label(value, size = 13, color) {
  return div().min_w_0().text_size(size).whitespace_normal().child(String(value))
    .when(Boolean(color), node => node.text_color(color));
}

export function button(t, id, title, click, variant = 'normal', disabled = false) {
  const primary = variant === 'primary';
  const active = variant === 'active';
  return h_flex().id(id).h(30).px(9).rounded(6).items_center().justify_center()
    .text_size(12).font_medium().border_1()
    .border_color(active ? t.accent : primary ? t.solid : t.border)
    .bg(primary ? t.solid : active ? t.selected : t.surface)
    .text_color(primary ? t.solid_foreground : t.foreground)
    .when(disabled, node => node.opacity(0.5))
    .when(!disabled, node => node.cursor_pointer().hover(s => s.bg(primary ? t.accent : t.raised))
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation()).on_click(click))
    .child(title);
}

export function panel(t) {
  return v_flex().w_full().min_w_0().flex_shrink_0().gap(10).p(14).rounded(9)
    .border_1().border_color(t.border).bg(t.surface);
}

export function sectionTab(t, id, title, selected, click, disabled = false) {
  return v_flex().id(id).h(35).items_center().justify_center().px(12).rounded(6)
    .border_1().border_color(selected ? t.input : t.border).bg(selected ? t.selected : t.surface)
    .text_color(selected ? t.foreground : t.muted).text_size(12).font_semibold()
    .when(!disabled, node => node.cursor_pointer().hover(s => s.bg(t.raised))
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation()).on_click(click))
    .child(title);
}

export function brandMark(t) {
  return h_flex().w(30).h(30).rounded(7).bg(t.selected).gap(3).justify_center().items_end().pb(8)
    .children([6, 10, 14].map(height => div().w(3).h(height).rounded(1).bg(t.accent)));
}

export function columns(wide, primary, secondary, primaryWidth = 270) {
  if (!secondary) return primary;
  if (!wide) return v_flex().w_full().gap(10).child(primary).child(secondary);
  return h_flex().w_full().items_start().gap(10)
    .child(div().w(primaryWidth).min_w_0().flex_shrink_0().child(primary))
    .child(div().min_w_0().flex_1().child(secondary));
}

export function input(t, state) {
  return Input.new(state).w_full().min_w_0().h(34).px(9).rounded(6).border_1()
    .border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground);
}

export function field(t, name, state) {
  return v_flex().w_full().min_w_0().gap(4)
    .child(label(name, 11, t.muted)).child(input(t, state));
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
    .child(div().h(6).w_full().rounded(3).bg(t.raised).overflow_hidden()
      .when(width > 0, node => node.child(div().h_full().w(`${width}%`).rounded(3).bg(color))));
}

export function reviewStatus(status) {
  const names = {
    approved: 'Approved',
    pending: 'No saved verdict',
    provisional: 'Provisional',
    failed_quorum: 'Quorum failed',
    invalid_ballots: 'Invalid ballots',
    rejected: 'Rejected',
    unconfirmed: 'Approval unconfirmed'
  };
  return names[status] ?? String(status).replace(/_/g, ' ');
}
