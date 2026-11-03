// The Tasks view's Board mode: the shown project's tasks in the six board
// columns, as the dispatcher publishes them in state.json. A placement's
// `column` names its column, the top-level `landed` list fills Landed, and
// cards keep the order of `placements`, which is the queue in dispatch order.
// The view computes no column: a card moves when foreman publishes it in
// another one.
//
// A Queue card dragged onto Authoring runs `foreman policy grant <task>
// <steps>` with the project's `grantSteps`; with none, the card lists no
// target but where it stands. A click selects a card and opens its detail
// under the board (`detail.js`), where its row's actions run. A Queue card
// under an epic names the epic, from the queue foreman ranks.
//
// The board lays its cards out itself, in absolute rectangles from `layout`,
// so a drag's targets are the rectangles the same layout gives the card where
// it stands and where the drop would put it (`drag.js`).
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { TASK_ID } from "./status.js";

const PAD = 12;
const GAP = 10;
const HEAD = 30;
const CARD_H = 50;
const LINE_H = 16;
const STRIPE = 3;

const COLUMNS = [
  { key: "queue", label: "Queue", color: (t) => t.muted },
  { key: "needs-you", label: "Needs you", color: (t) => t.blocked },
  { key: "authoring", label: "Authoring", color: (t) => t.working },
  { key: "review", label: "Review", color: (t) => t.accent },
  { key: "fixing", label: "Fixing", color: () => "#f59e0b" },
  { key: "landed", label: "Landed", color: (t) => t.done },
];
const AUTHORING = COLUMNS.findIndex((column) => column.key === "authoring");

export class Board {
  constructor(pane) {
    this.pane = pane;
    // The board's bounds in the window, from the last move over it.
    this.bounds = null;
    this.scroll = 0;
  }

  // Each column's cards: a placement, or a landed task, with the row it
  // stands for (`rowOf`), which carries its detail, epic and actions. An
  // attention row with no placement (a held project, an orphaned worker, an
  // unreviewed branch, a spent account) is a Needs-you card of its own, keyed
  // by the row.
  columns() {
    const columns = COLUMNS.map(() => []);
    const placements = this.pane.placements();
    for (const placement of placements) {
      const index = COLUMNS.findIndex((column) => column.key === placement.column);
      columns[index].push({ ...placement, row: this.pane.rowOf(placement.key, placement.column) });
    }
    const placed = new Set(placements.map((placement) => placement.key));
    const needsYou = COLUMNS.findIndex((column) => column.key === "needs-you");
    for (const row of this.pane.rows()) {
      if (row.view !== "attention" || placed.has(row.key.match(TASK_ID)?.[0])) continue;
      columns[needsYou].push({ key: row.key, label: row.label, column: "needs-you", grant: null, runs: [], gates: [], url: row.url, pr: row.pr, row });
    }
    columns[COLUMNS.length - 1] = this.pane.landed()
      .map((task) => ({ ...task, column: "landed", grant: null, runs: [], gates: [], url: null, pr: null, row: this.pane.rowOf(task.key, "landed") }));
    return columns;
  }

  // The selected card, as the board shows it now.
  selected() { return this.columns().flat().find((card) => card.key === this.pane.detail.key); }

  // Every card's rectangle in board coordinates, and each column's x and width.
  layout(columns) {
    const width = this.bounds?.width ?? this.pane.size?.width ?? 600;
    const columnW = Math.max(80, (width - 2 * PAD - (COLUMNS.length - 1) * GAP) / COLUMNS.length);
    const rects = new Map();
    const xs = COLUMNS.map((_, index) => PAD + index * (columnW + GAP));
    columns.forEach((cards, index) => {
      let y = PAD + HEAD - this.scroll;
      for (const card of cards) {
        const height = CARD_H + (lineOf(card) === null ? 0 : LINE_H);
        rects.set(card.key, { x: xs[index], y, width: columnW, height });
        y += height + GAP;
      }
    });
    return { rects, xs, columnW };
  }

  // A Queue card lists two target states: where it stands, which runs
  // nothing, and granted, at the foot of Authoring. A card with no grant to
  // run lists only where it stands.
  targets(card, columns) {
    if (this.bounds === null) return [];
    const window = (rect) => ({ ...rect, x: rect.x + this.bounds.x, y: rect.y + this.bounds.y });
    const stay = { rect: window(this.layout(columns).rects.get(card.key)), run: null };
    const steps = this.pane.grantSteps();
    if (card.column !== "queue" || steps.length === 0) return [stay];
    const moved = columns.map((cards, index) =>
      index === AUTHORING ? [...cards, card] : cards.filter((one) => one.key !== card.key));
    const granted = window(this.layout(moved).rects.get(card.key));
    return [stay, { rect: granted, run: (cx) => this.pane.act(["policy", "grant", card.key, ...steps], cx, (_done, cx) => cx.notify()) }];
  }

  press(card, event) {
    const columns = this.columns();
    const rect = this.layout(columns).rects.get(card.key);
    const origin = this.bounds ?? { x: 0, y: 0 };
    this.pane.drag.press(card.key, event.position, { ...rect, x: rect.x + origin.x, y: rect.y + origin.y }, () => this.targets(card, columns));
  }

  scrolled(event, cx) {
    this.scroll = Math.max(0, this.scroll + (event.delta?.y ?? 0));
    cx.notify();
  }

  view(t) {
    const columns = this.columns();
    const { rects, xs, columnW } = this.layout(columns);
    const drag = this.pane.drag;
    const preview = drag.preview();
    const origin = this.bounds ?? { x: 0, y: 0 };
    const dragged = columns.flat().find((card) => drag.dragging(card.key));
    const floating = dragged === undefined ? null : drag.floating();
    const board = div().id("task-board").relative().flex_1().w_full().min_h(0).overflow_hidden().bg(t.canvas)
      .on_mouse_move((event, _cx) => { this.bounds = event.bounds; })
      .on_scroll_wheel((event, cx) => this.scrolled(event, cx))
      .children(COLUMNS.map((column, index) => h_flex().absolute().left(xs[index]).top(PAD).w(columnW).h(HEAD - 6)
        .items_center().gap(8).px(3)
        .child(div().size(8).rounded(8).bg(column.color(t)).flex_none())
        .child(div().text_size(13).font_semibold().truncate().child(column.label))
        .child(div().px(6).rounded(4).bg(`${column.color(t)}26`).text_size(10).text_color(column.color(t))
          .child(String(columns[index].length)))))
      .children(columns.flatMap((cards, index) => cards.map((card) =>
        this.card(card, COLUMNS[index], rects.get(card.key), t, card === dragged))))
      .when(dragged !== undefined && preview !== null && preview.run !== null, (el) => el.child(
        outline(preview.rect, origin, t)))
      .when(floating !== null, (el) => el.child(
        this.card(dragged, COLUMNS.find((column) => column.key === dragged.column), { ...floating, x: floating.x - origin.x, y: floating.y - origin.y }, t, false)
          .opacity(0.9)));
    return v_flex().flex_1().min_h(0).child(board).child(this.pane.detail.view(t, this.selected()));
  }

  card(card, column, rect, t, ghost) {
    const color = column.color(t);
    const rung = card.runs.findLast((run) => run.open)?.rung ?? null;
    const movable = card.column === "queue";
    const selected = this.pane.detail.key === card.key;
    const line = lineOf(card);
    return h_flex().id(`board-card-${card.key}`).absolute().left(rect.x).top(rect.y).w(rect.width).h(rect.height)
      .rounded(6).overflow_hidden().bg(selected ? t.selected : t.surface).border(1).border_color(selected ? color : t.border)
      .when(ghost, (el) => el.opacity(0.35))
      .hover((s) => s.border_color(color))
      .when(movable, (el) => el.cursor_grab().on_mouse_down("left", (event, _cx) => this.press(card, event)))
      .on_click((_event, cx) => this.pane.detail.toggle(card.key, cx))
      .child(div().w(STRIPE).h_full().bg(color).flex_none())
      .child(v_flex().flex_1().min_w(0).px(8).py(5).gap(2)
        .child(h_flex().gap(6).text_size(10).text_color(t.muted)
          .child(div().truncate().child(card.key))
          .child(div().flex_1())
          .when(rung !== null, (el) => el.child(div().flex_none().child(rung)))
          .when(card.grant !== null, (el) => el.child(div().flex_none().text_color(t.done).child(grantMark(card)))))
        .child(div().text_size(12).truncate().child(card.label))
        .when(line !== null, (el) => el.child(div().text_size(10).text_color(card.column === "needs-you" ? t.blocked : t.dim).truncate().child(line))));
  }
}

// The card's third line: why a Needs-you card waits, or the epic a Queue card sits under.
const lineOf = (card) =>
  card.column === "needs-you" ? card.row?.detail ?? null
  : card.column === "queue" && card.row?.parent != null ? `under ${card.row.parent}`
  : null;

// Where the drop would put the card, drawn as an empty slot.
const outline = (rect, origin, t) =>
  div().absolute().left(rect.x - origin.x).top(rect.y - origin.y).w(rect.width).h(rect.height)
    .rounded(6).border(2).border_color(t.accent);

// A card's grant in a few words: its own or its epic's, and how many tasks it admits still.
const grantMark = (card) => {
  const { scope, left } = card.grant;
  const whose = scope === card.key ? "granted" : `granted by ${scope}`;
  return left === null ? whose : `${whose}, ${left} left`;
};
