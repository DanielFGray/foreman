// The Foreman pane's Models view: the ladder's levels, the available rungs and
// models, and the reviewers, from one `foreman ladder --json`. Which columns
// there are, and what each drop runs, is `models-board.js`; this file draws
// them and runs the commands.
//
// Every change is one or more foreman commands, run in order until one
// refuses, and the view reads `foreman ladder --json` again after them: the
// columns never change before foreman answers. A click on a card's thinking
// level sets the next one in the cycle.
//
// A drop zone is a column's body, or a strip over the gap between two level
// columns (and before the first and after the last), which puts a rung in a
// level of its own there. Where a strip and a column overlap, the strip wins
// (`drag.js` takes the first target listed). Available and Reviewers stay at
// the right edge and the level columns scroll under them, so both are a drop
// from any level (`pinnedAcross`).
//
// Under the columns, Accounts lists each account the ladder draws on: its
// quota row from state.json (what it has left, or why it is unreadable) and
// the rungs and reviewers it pays for (`accounts` there). A rung card and a
// reviewer card name their account.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { columnsOf, dropsOf, pinnedAcross, thinkingArgs } from "./models-board.js";
import { refusalOf } from "./status.js";
import { CARDS_TOP, PAD, columnBody, columnHead, columnsAcross, inBody, reachOf, scrolledBy } from "./columns.js";

const GAP = 8;
// How wide a gap's drop strip is: it reaches into the columns either side.
const GAP_ZONE = 28;
const CARD_H = 40;
const STRIPE = 3;
// Wider than a Board column: a card's first line holds the name, the
// trial state and the thinking level, and its second the model and the account.
const COLUMN_MIN = 260;

const COLORS = { level: (t) => t.working, available: (t) => t.muted, reviewers: (t) => t.accent };

export class Models {
  constructor(pane) {
    this.pane = pane;
    // The last `foreman ladder --json`: { rungs, models, reviewers }.
    this.ladder = null;
    this.bounds = null;
    // Scrolled across all columns, and down each column by its key, so a
    // column keeps its scroll when a level column comes or goes.
    this.scroll = { x: 0, y: {} };
  }

  // Reads the ladder and the models again, and draws them.
  load(cx) {
    this.pane.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      const result = await this.pane.foreman(["ladder", "--json"]);
      this.pane.busy = false;
      if (result.code === 0) {
        try { this.ladder = JSON.parse(result.stdout); } catch (error) { this.pane.problem = String(error.message ?? error); }
      } else this.pane.problem = refusalOf(result);
      cx.notify();
    });
  }

  // Runs foreman commands in order until one refuses, then reads the ladder
  // again whatever they answered.
  run(commands, cx) {
    const [first, ...rest] = commands;
    this.pane.act(first, cx, (done, cx) => (done && rest.length > 0 ? this.run(rest, cx) : this.load(cx)));
  }

  columns() { return this.ladder === null ? [] : columnsOf(this.ladder); }

  // Every card's rectangle in view coordinates; each column's x and width; how
  // far the columns reach past the view's right edge; where the level columns
  // stop showing (`edge`, left of the pinned columns); how far each column can
  // scroll down; and the view's height.
  layout(columns) {
    const width = this.bounds?.width ?? this.pane.size?.width ?? 600;
    const height = this.bounds?.height ?? this.pane.size?.height ?? 600;
    const scroll = this.scrollOf(columns);
    const across = columnsAcross(width, columns.length, { min: COLUMN_MIN, gap: GAP, scroll });
    const { xs, edge } = pinnedAcross(columns, across.xs, across.columnW, { right: width - PAD, gap: GAP });
    const { columnW, overflow } = across;
    const rects = new Map();
    columns.forEach((column, index) => column.cards.forEach((card, row) =>
      rects.set(card.key, { x: xs[index], y: CARDS_TOP - scroll.y[index] + row * (CARD_H + GAP), width: columnW, height: CARD_H })));
    const reach = columns.map((column) => reachOf(column.cards.length * (CARD_H + GAP), height));
    return { rects, xs, columnW, overflow, edge, reach, height };
  }

  // The scroll as `columns.js` takes it: one y per column, in column order.
  scrollOf(columns) { return { x: this.scroll.x, y: columns.map((column) => this.scroll.y[column.key] ?? 0) }; }

  // A drop zone's rectangle in view coordinates, or null when it does not show.
  // A level column scrolled under the pinned columns, or off the left, shows
  // in part or not at all. A gap shows while its middle does, and its strip
  // still reaches into the columns either side.
  zoneRect(zone, columns, { xs, columnW, edge, height }) {
    const body = { y: CARDS_TOP, height: height - CARDS_TOP };
    if (zone.kind === "gap") {
      const middle = zone.at === 0 ? xs[0] - GAP / 2 : xs[zone.at - 1] + columnW + GAP / 2;
      return middle >= 0 && middle <= edge + GAP / 2 ? { ...body, x: middle - GAP_ZONE / 2, width: GAP_ZONE } : null;
    }
    const column = columns.find((one) => one.key === zone.key);
    const rect = { ...body, x: xs[columns.indexOf(column)], width: columnW };
    return column.kind === "level" ? shown(rect, edge) : rect;
  }

  // The drag's targets, in window coordinates: where the card stands, which
  // runs nothing; every drop `models-board.js` lists for it that shows, strips
  // before columns; and the card's own column, which runs nothing.
  targets(card, columns) {
    if (this.bounds === null) return [];
    const layout = this.layout(columns);
    const window = (rect) => ({ ...rect, x: rect.x + this.bounds.x, y: rect.y + this.bounds.y });
    const drops = dropsOf(card, columns, this.ladder);
    const home = columns.find((column) => column.cards.some((one) => one.key === card.key));
    const own = layout.rects.get(card.key);
    return [
      { rect: home.kind === "level" ? shown(own, layout.edge) : own, run: null },
      ...[...drops.filter((drop) => drop.zone.kind === "gap"), ...drops.filter((drop) => drop.zone.kind === "column")].map((drop) => ({
        rect: this.zoneRect(drop.zone, columns, layout), gap: drop.zone.kind === "gap", run: (cx) => this.run(drop.commands, cx),
      })),
      { rect: this.zoneRect({ kind: "column", key: home.key }, columns, layout), run: null },
    ].filter((target) => target.rect !== null).map((target) => ({ ...target, rect: window(target.rect) }));
  }

  press(card, event) {
    const columns = this.columns();
    const rect = this.layout(columns).rects.get(card.key);
    const origin = this.bounds ?? { x: 0, y: 0 };
    this.pane.drag.press(card.key, event.position, { ...rect, x: rect.x + origin.x, y: rect.y + origin.y }, () => this.targets(card, columns));
  }

  wheel(event, cx) {
    const columns = this.columns();
    const scrolled = scrolledBy(this.scrollOf(columns), event, this.layout(columns));
    this.scroll = { x: scrolled.x, y: Object.fromEntries(columns.map((column, index) => [column.key, scrolled.y[index]])) };
    cx.notify();
  }

  view(t) {
    if (this.ladder === null) return div().p(12).text_color(t.muted).child("reading the ladder…");
    const columns = this.columns();
    const { rects, xs, columnW, edge } = this.layout(columns);
    const drag = this.pane.drag;
    const preview = drag.preview();
    const origin = this.bounds ?? { x: 0, y: 0 };
    const cards = columns.flatMap((column) => column.cards.map((card) => ({ card, column })));
    const dragged = cards.find(({ card }) => drag.dragging(card.key));
    const floating = dragged === undefined ? null : drag.floating();
    const drawn = (list) => [
      ...list.map(({ column, index }) => columnHead(this.head(column), xs[index], columnW, column.cards.length, t)),
      ...list.map(({ column, index }) => columnBody(`models-column-${column.key}`, xs[index], columnW)
        .children(column.cards.map((card) => this.card(card, column, inBody(rects.get(card.key)), t, card === dragged?.card)))),
    ];
    const indexed = columns.map((column, index) => ({ column, index }));
    const board = div().id("models-board").relative().flex_1().w_full().min_h(0).overflow_hidden().bg(t.canvas)
      .on_mouse_move((event, _cx) => { this.bounds = event.bounds; })
      .on_scroll_wheel((event, cx) => this.wheel(event, cx))
      // The level columns, cut off where the pinned columns start.
      .child(div().id("models-levels").absolute().left(0).top(0).w(edge).h_full().overflow_hidden()
        .children(drawn(indexed.filter(({ column }) => column.kind === "level"))))
      .children(drawn(indexed.filter(({ column }) => column.kind !== "level")))
      .when(dragged !== undefined && preview !== null && preview.run !== null, (el) => el.child(this.previewOf(preview, origin, t)))
      .when(floating !== null, (el) => el.child(
        this.card(dragged.card, dragged.column, { ...floating, x: floating.x - origin.x, y: floating.y - origin.y }, t, false).opacity(0.9)));
    return v_flex().flex_1().min_h(0).child(board).child(this.accounts(t));
  }

  // A column as `columnHead` draws it.
  head(column) { return { label: column.label, color: COLORS[column.kind] }; }

  // Where the drop would land: a bar down the gap, or the column's outline.
  previewOf(preview, origin, t) {
    const { x, y, width, height } = preview.rect;
    const box = div().absolute().top(y - origin.y).h(height);
    return preview.gap
      ? box.left(x - origin.x + width / 2 - 2).w(4).rounded(2).bg(t.accent)
      : box.left(x - origin.x).w(width).rounded(6).border(2).border_color(t.accent);
  }

  // Each account: its quota row, and the rungs and reviewers that draw on it.
  accounts(t) {
    const published = this.pane.published;
    const quota = (published?.rows ?? []).filter((row) => row.view === "quota");
    return v_flex().id("accounts").flex_none().max_h(200).overflow_y_scrollbar().px(PAD).py(6).gap(4).bg(t.surface).border_t(1).border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).child("ACCOUNTS"))
      .when(quota.length === 0, (el) => el.child(div().text_color(t.muted).child("no account reading yet")))
      .children(quota.map((row) => {
        const account = published.accounts.find((one) => one.provider === row.key);
        const seats = [...(account?.rungs ?? []), ...(account?.reviewers ?? []).map((name) => `reviewer ${name}`)];
        return v_flex().gap(1)
          .child(h_flex().gap(8)
            .child(div().font_semibold().child(row.label))
            .child(div().text_color(t.muted).truncate().child(seats.length === 0 ? "nothing draws on it" : seats.join(", "))))
          .when(row.detail != null, (el) => el.child(div().text_size(11).text_color(t.muted).child(row.detail)));
      }));
  }

  // The account a rung draws on, as state.json names it.
  accountOf(rung) {
    return this.pane.published?.accounts.find((account) => account.rungs.includes(rung))?.provider ?? null;
  }

  card(card, column, rect, t, ghost) {
    const color = COLORS[column.kind](t);
    const detail = card.kind === "rung"
      ? [card.model, this.accountOf(card.name)].filter(Boolean).join(" · ")
      : card.kind === "reviewer"
        ? [card.model, card.reviewer.provider].filter(Boolean).join(" · ")
        : `${card.harness} · no rung`;
    const tag = card.kind === "rung" ? (card.rung.enabled ? card.rung.state : "disabled") : null;
    return h_flex().id(`models-card-${card.key}`).absolute().left(rect.x).top(rect.y).w(rect.width).h(rect.height)
      .rounded(6).overflow_hidden().bg(t.surface).border(1).border_color(t.border)
      .when(ghost, (el) => el.opacity(0.35))
      .hover((s) => s.border_color(color))
      .cursor_grab().on_mouse_down("left", (event, _cx) => this.press(card, event))
      .child(div().w(STRIPE).h_full().bg(color).flex_none())
      .child(v_flex().flex_1().min_w(0).px(8).py(4).gap(1)
        .child(h_flex().gap(6).text_size(12)
          .child(div().flex_1().truncate().child(card.name))
          .when(tag !== null, (el) => el.child(div().flex_none().text_size(10).text_color(t.muted).child(tag)))
          .when(card.kind !== "model", (el) => el.child(this.thinkingChip(card, t))))
        .child(div().text_size(10).text_color(t.muted).truncate().child(detail)));
  }

  // The card's thinking level; a click sets the next one. "default" is no
  // level: the harness's own default applies.
  thinkingChip(card, t) {
    return div().id(`models-thinking-${card.key}`).flex_none().px(5).rounded(4).text_size(10)
      .bg(t.canvas).text_color(card.thinking === null ? t.dim : t.foreground)
      .hover((s) => s.text_color(t.accent))
      .on_click((_event, cx) => this.run([thinkingArgs(card)], cx))
      .child(card.thinking ?? "default");
  }
}

// `rect` cut to the part between the view's left edge and `edge`, or null when
// none of it is there.
const shown = (rect, edge) => {
  const left = Math.max(rect.x, 0), right = Math.min(rect.x + rect.width, edge);
  return right > left ? { ...rect, x: left, width: right - left } : null;
};
