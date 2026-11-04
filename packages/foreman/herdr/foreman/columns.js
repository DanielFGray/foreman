// The column layout the Tasks board and the Models view share. The columns
// split the view's width but never narrow past a minimum, so a card shows its
// title rather than a word or two, and a view too narrow for them scrolls
// across them.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

export const PAD = 12;
export const HEAD = 30;

// Each column's x and width in a view `width` wide, scrolled `scroll.x`
// across, and how far the columns reach past the view's right edge.
export const columnsAcross = (width, count, { min, gap, scroll }) => {
  const columnW = Math.max(min, (width - 2 * PAD - (count - 1) * gap) / count);
  const overflow = Math.max(0, 2 * PAD + count * columnW + (count - 1) * gap - width);
  const xs = Array.from({ length: count }, (_, index) => PAD + index * (columnW + gap) - scroll.x);
  return { xs, columnW, overflow };
};

// The scroll after one wheel event. A wheel scrolls down; a sideways scroll,
// or a wheel with shift held, scrolls across, as far as `overflow`.
export const scrolledBy = (scroll, event, overflow) => {
  const dx = event.delta?.x ?? 0, dy = event.delta?.y ?? 0;
  const [across, down] = event.modifiers?.shift && dx === 0 ? [dy, 0] : [dx, dy];
  return { x: Math.min(overflow, Math.max(0, scroll.x + across)), y: Math.max(0, scroll.y + down) };
};

// A column's head: its color, its label and how many cards it holds.
export const columnHead = (column, x, width, count, t) =>
  h_flex().absolute().left(x).top(PAD).w(width).h(HEAD - 6).items_center().gap(8).px(3)
    .child(div().size(8).rounded(8).bg(column.color(t)).flex_none())
    .child(div().text_size(13).font_semibold().truncate().child(column.label))
    .child(div().px(6).rounded(4).bg(`${column.color(t)}26`).text_size(10).text_color(column.color(t))
      .child(String(count)));
