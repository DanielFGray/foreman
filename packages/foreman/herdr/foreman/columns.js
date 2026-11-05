// The column layout the Tasks board and the Models view share. The columns
// split the view's width but never narrow past a minimum, so a card shows its
// title rather than a word or two, and a view too narrow for them scrolls
// across them. Each column scrolls down by itself, under its head.
//
// A view keeps every card's rectangle in view coordinates, because a drag's
// targets are those rectangles (`drag.js`). A card is drawn inside its
// column's body, which clips it at the head, so `inBody` moves its rectangle
// into the body's coordinates.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

export const PAD = 12;
export const HEAD = 30;
// Where a column's body, and so its first card, starts.
export const CARDS_TOP = PAD + HEAD;

// A view's scroll before any wheel: across all columns, and down each one.
export const unscrolled = (count) => ({ x: 0, y: Array(count).fill(0) });

// Each column's x and width in a view `width` wide, scrolled `scroll.x`
// across, and how far the columns reach past the view's right edge.
export const columnsAcross = (width, count, { min, gap, scroll }) => {
  const columnW = Math.max(min, (width - 2 * PAD - (count - 1) * gap) / count);
  const overflow = Math.max(0, 2 * PAD + count * columnW + (count - 1) * gap - width);
  const xs = Array.from({ length: count }, (_, index) => PAD + index * (columnW + gap) - scroll.x);
  return { xs, columnW, overflow };
};

// How far a column whose cards stand `content` px tall can scroll down in a
// view `height` px tall.
export const reachOf = (content, height) => Math.max(0, content + PAD - (height - CARDS_TOP));

// The scroll after one wheel event, from the view's layout: `xs`, `columnW`,
// `overflow` and each column's `reach`. A wheel scrolls the column under the
// pointer down; a sideways scroll, or a wheel with shift held, scrolls every
// column across.
export const scrolledBy = (scroll, event, { xs, columnW, overflow, reach }) => {
  const dx = event.delta?.x ?? 0, dy = event.delta?.y ?? 0;
  const [across, down] = event.modifiers?.shift && dx === 0 ? [dy, 0] : [dx, dy];
  const left = event.position.x - (event.bounds?.x ?? 0);
  // Columns may overlap: the Models view pins columns over the level columns
  // scrolled under them. A later column is drawn on top, so the last column
  // under the pointer is the one the operator sees.
  const under = xs.findLastIndex((x) => left >= x && left < x + columnW);
  return {
    x: clamp(scroll.x + across, overflow),
    y: scroll.y.map((at, index) => index === under ? clamp(at + down, reach[index]) : at),
  };
};

// A column's head: its color, its label and how many cards it holds.
export const columnHead = (column, x, width, count, t) =>
  h_flex().absolute().left(x).top(PAD).w(width).h(HEAD - 6).items_center().gap(8).px(3)
    .child(div().size(8).rounded(8).bg(column.color(t)).flex_none())
    .child(div().text_size(13).font_semibold().truncate().child(column.label))
    .child(div().px(6).rounded(4).bg(`${column.color(t)}26`).text_size(10).text_color(column.color(t))
      .child(String(count)));

// A column's body, under its head. It runs past the view's foot, which the
// view clips: a mod element has no bottom edge to pin.
export const columnBody = (id, x, width) =>
  div().id(id).absolute().left(x).top(CARDS_TOP).w(width).h_full().overflow_hidden();

// A card's rectangle in its column body's coordinates.
export const inBody = (rect) => ({ ...rect, x: 0, y: rect.y - CARDS_TOP });

const clamp = (value, max) => Math.min(max, Math.max(0, value));
