import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { closeOverlay, openOverlay, props } from 'herdr';
import { brandMark, glyph, iconTile, label } from './components.js';

export const sections = [
  { id: 'polls', title: 'Polls', description: 'Collect votes and record decisions' },
  { id: 'delegations', title: 'Delegations', description: 'Follow agent tasks and their results' },
  { id: 'debates', title: 'Debate', description: 'Read the conversation between agents' },
  { id: 'reviews', title: 'Reviews', description: 'Inspect verdicts and direct ballots' },
  { id: 'team', title: 'Team', description: 'Set roles and see which models are active' }
];

function openSection(id) {
  closeOverlay(props().overlay);
  openOverlay({
    mod: 'council', kind: 'window', key: 'council', width: 760, height: 710,
    props: { initialTab: id }
  });
}

export function launcher(t, compact, measure) {
  let anchor = 'pointer';
  return h_flex().size_full().items_center().px(compact ? 5 : 10)
    .on_size_change(measure)
    .child(h_flex().id('council-launcher').w_full().max_w(280).h(34).rounded(8).items_center()
      .gap(8).px(compact ? 0 : 7).when(compact, node => node.justify_center())
      .bg(t.surface).border_1().border_color(t.border).cursor_pointer()
      .hover(s => s.bg(t.raised).border_color(t.input)).active(s => s.bg(t.selected))
      .when(compact, node => node.tooltip('Open Council menu'))
      .on_mouse_down('left', (event, cx) => {
        cx.stop_propagation();
        const bounds = event.bounds;
        if (bounds) anchor = { x: bounds.x, y: bounds.y + bounds.height + 4 };
      })
      .on_click(() => openOverlay({ mod: 'council', kind: 'popup', width: 304, at: anchor, props: { role: 'menu' } }))
      .child(brandMark(25))
      .when(!compact, node => node.child(label('Council', 13, t.foreground).flex_1().truncate().font_semibold())
        .child(glyph('down', 14).text_color(t.muted))));
}

export function menu(t, focus, index, move) {
  return v_flex().id('council-menu-popup').track_focus(focus).w_full().p(6).bg(t.popover)
    .on_key_down((event, cx) => {
      if (event.key === 'up' || event.key === 'down') {
        move(cx, event.key === 'down' ? 1 : -1);
        cx.stop_propagation();
      } else if (event.key === 'enter' && index >= 0) {
        openSection(sections[index].id);
        cx.stop_propagation();
      }
    })
    .child(h_flex().gap(9).items_center().px(9).pt(7).pb(10)
      .child(brandMark(29)).child(label('Council', 15, t.foreground).font_semibold()))
    .child(div().h(1).mx(5).mb(3).bg(t.border))
    .children(sections.map(({ id, title, description }, position) =>
      h_flex().id(`menu-${id}`).h(52).px(7).items_center().gap(9).rounded(7).cursor_pointer()
        .when(index === position, node => node.bg(t.raised))
        .hover(s => s.bg(t.selected))
        .on_click(() => openSection(id))
        .child(iconTile(t, id, 30))
        .child(v_flex().min_w_0().flex_1().gap(2)
          .child(label(title, 13, t.foreground).font_semibold())
          .child(label(description, 11, t.muted)))
        .child(glyph('right', 13).text_color(t.dim))));
}
