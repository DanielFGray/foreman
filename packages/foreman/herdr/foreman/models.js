// The Foreman pane's Models view: the ladder's levels, the reviewers, and the
// available rungs and models, from one `foreman ladder --json`. Which rows
// there are, where they stand and what each drop runs is `models-board.js`;
// this file draws them and runs the commands.
//
// Every change is one or more foreman commands, run in order until one
// refuses, and the view reads `foreman ladder --json` again after them: the
// rows never change before foreman answers. A click on a card's thinking
// level sets the next one in the cycle.
//
// Each level, Reviewers and Available is a row: its label at the left, its
// cards wrapping to the pane's width. The rows scroll down together, so the
// view works in a narrow pane. Available opens on a click on its label, and
// then shows a head per provider, which opens that provider's cards; the pane
// keeps what is open. A drop zone is a row, or a strip across the space
// between two level rows (and above the first and below the last), which puts
// a rung in a level of its own there.
//
// Under the rows, Accounts lists each account the ladder draws on: its quota
// row from state.json (what it has left, or why it is unreadable) and the
// rungs and reviewers it pays for (`accounts` there). A rung card and a
// reviewer card name their account.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { ROW, columnsOf, dropsOf, rowsOf, thinkingArgs } from "./models-board.js";
import { refusalOf } from "./status.js";

const STRIPE = 3;
const OPEN_KEY = "models-open";

const COLORS = { level: (t) => t.working, available: (t) => t.muted, reviewers: (t) => t.accent };

export class Models {
  constructor(pane) {
    this.pane = pane;
    // The last `foreman ladder --json`: { rungs, models, reviewers }.
    this.ladder = null;
    // The view's bounds in the window, from the last move over it.
    this.bounds = null;
    // How far the rows are scrolled down.
    this.scroll = 0;
    // What the operator opened: Available, and each provider group in it.
    this.open = storedOpen();
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

  toggle(key, cx) {
    if (!this.open.delete(key)) this.open.add(key);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...this.open])); } catch {}
    cx.notify();
  }

  columns() { return this.ladder === null ? [] : columnsOf(this.ladder); }

  // The rows as `rowsOf` places them, moved up by the scroll, and how far the
  // rows can scroll.
  layout(columns) {
    const width = this.bounds?.width ?? this.pane.size?.width ?? 600;
    const height = this.bounds?.height ?? this.pane.size?.height ?? 600;
    const placed = rowsOf(columns, width, this.open);
    const up = (rect) => ({ ...rect, y: rect.y - this.scroll });
    return {
      rows: placed.rows.map((row) => ({ ...row, rect: up(row.rect) })),
      heads: placed.heads.map((head) => ({ ...head, rect: up(head.rect) })),
      cards: new Map([...placed.cards].map(([key, rect]) => [key, up(rect)])),
      gaps: placed.gaps.map(up),
      reach: Math.max(0, placed.height - height),
    };
  }

  // The drag's targets, in window coordinates: where the card stands, which
  // runs nothing; every drop `models-board.js` lists for it, strips before
  // rows; and the card's own row, which runs nothing.
  targets(card, columns) {
    if (this.bounds === null) return [];
    const { rows, cards, gaps } = this.layout(columns);
    const window = (rect) => ({ ...rect, x: rect.x + this.bounds.x, y: rect.y + this.bounds.y });
    const rowOf = (key) => rows.find((row) => row.column.key === key).rect;
    const drops = dropsOf(card, columns, this.ladder);
    const home = columns.find((column) => column.cards.some((one) => one.key === card.key));
    return [
      { rect: cards.get(card.key), run: null },
      ...[...drops.filter((drop) => drop.zone.kind === "gap"), ...drops.filter((drop) => drop.zone.kind === "column")].map((drop) => ({
        rect: drop.zone.kind === "gap" ? gaps[drop.zone.at] : rowOf(drop.zone.key),
        gap: drop.zone.kind === "gap", run: (cx) => this.run(drop.commands, cx),
      })),
      { rect: rowOf(home.key), run: null },
    ].map((target) => ({ ...target, rect: window(target.rect) }));
  }

  press(card, event) {
    const columns = this.columns();
    const rect = this.layout(columns).cards.get(card.key);
    const origin = this.bounds ?? { x: 0, y: 0 };
    this.pane.drag.press(card.key, this.pane.drawn(event.position), { ...rect, x: rect.x + origin.x, y: rect.y + origin.y }, () => this.targets(card, columns));
  }

  wheel(event, cx) {
    const delta = this.pane.drawn(event.delta);
    const { reach } = this.layout(this.columns());
    this.scroll = Math.min(reach, Math.max(0, this.scroll + (delta?.y ?? 0)));
    cx.notify();
  }

  view(t) {
    if (this.ladder === null) return div().p(12).text_color(t.muted).child("reading the ladder…");
    const columns = this.columns();
    const { rows, heads, cards } = this.layout(columns);
    const drag = this.pane.drag;
    const preview = drag.preview();
    const origin = this.bounds ?? { x: 0, y: 0 };
    const dragged = columns.flatMap((column) => column.cards.map((card) => ({ card, column }))).find(({ card }) => drag.dragging(card.key));
    const floating = dragged === undefined ? null : drag.floating();
    const board = div().id("models-board").relative().flex_1().w_full().min_h(0).overflow_hidden().bg(t.canvas)
      .on_mouse_move((event, _cx) => { this.bounds = this.pane.drawn(event.bounds); })
      .on_scroll_wheel((event, cx) => this.wheel(event, cx))
      .children(rows.map(({ column, rect }) => this.label(column, rect, t)))
      .children(heads.map((head) => this.groupHead(head, t)))
      .children(rows.flatMap(({ column }) => column.cards.filter((card) => cards.has(card.key)).map((card) =>
        this.card(card, column, cards.get(card.key), t, card === dragged?.card))))
      .when(dragged !== undefined && preview !== null && preview.run !== null, (el) => el.child(this.previewOf(preview, origin, t)))
      .when(floating !== null, (el) => el.child(
        this.face(dragged.card, dragged.column, { ...floating, x: floating.x - origin.x, y: floating.y - origin.y }, t).opacity(0.9)));
    return v_flex().flex_1().min_h(0).child(board).child(this.accounts(t));
  }

  // A row's label: its color, its name and how many cards it holds. A click on
  // Available's opens or closes it.
  label(column, rect, t) {
    const color = COLORS[column.kind](t);
    const foldable = column.groups !== undefined;
    return h_flex().id(`models-label-${column.key}`).absolute().left(rect.x).top(rect.y).w(ROW.LABEL_W - 8).h(ROW.CARD_H).items_center().gap(6)
      .child(div().size(8).rounded(8).bg(color).flex_none())
      .child(div().text_size(12).font_semibold().truncate().child(`${foldable ? (this.open.has(column.key) ? "▾ " : "▸ ") : ""}${column.label}`))
      .child(div().px(5).rounded(4).bg(`${color}26`).text_size(10).text_color(color).flex_none().child(String(column.cards.length)))
      .when(foldable, (el) => el.cursor_pointer().on_click((_event, cx) => this.toggle(column.key, cx)));
  }

  // A provider group's head in Available: its name and how many cards it holds.
  // A click opens or closes it.
  groupHead({ group, open, rect }, t) {
    return h_flex().id(`models-group-${group.key}`).absolute().left(rect.x).top(rect.y).w(rect.width).h(rect.height).items_center().gap(6)
      .px(6).rounded(4).hover((s) => s.bg(t.surface)).cursor_pointer()
      .child(div().text_size(11).text_color(t.muted).child(`${open ? "▾" : "▸"} ${group.label}`))
      .child(div().text_size(10).text_color(t.dim).child(String(group.cards.length)))
      .on_click((_event, cx) => this.toggle(group.key, cx));
  }

  // Where the drop would land: a bar across the gap, or the row's outline.
  previewOf(preview, origin, t) {
    const { x, y, width, height } = preview.rect;
    const box = div().absolute().left(x - origin.x).w(width);
    return preview.gap
      ? box.top(y - origin.y + height / 2 - 2).h(4).rounded(2).bg(t.accent)
      : box.top(y - origin.y).h(height).rounded(6).border(2).border_color(t.accent);
  }

  // Each account: its quota row, and the rungs and reviewers that draw on it.
  accounts(t) {
    const published = this.pane.published;
    const quota = (published?.rows ?? []).filter((row) => row.view === "quota");
    return v_flex().id("accounts").flex_none().max_h(200).overflow_y_scrollbar().px(ROW.PAD).py(6).gap(4).bg(t.surface).border_t(1).border_color(t.border)
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

  // The card in its column: it drags, and a click on its thinking level sets the next one.
  card(card, column, rect, t, ghost) {
    const thinking = this.thinking(card, t).id(`models-thinking-${card.key}`)
      .hover((s) => s.text_color(t.accent))
      .on_click((_event, cx) => this.run([thinkingArgs(card)], cx));
    return this.face(card, column, rect, t, thinking).id(`models-card-${card.key}`)
      .when(ghost, (el) => el.opacity(0.35))
      .hover((s) => s.border_color(COLORS[column.kind](t)))
      .cursor_grab().on_mouse_down("left", (event, _cx) => this.press(card, event));
  }

  // The card as it looks, taking no input. The copy that follows a drag is
  // this alone: after a release outside the window the copy stays under the
  // pointer, and the next press must reach the card beneath it.
  face(card, column, rect, t, thinking = this.thinking(card, t)) {
    const color = COLORS[column.kind](t);
    const detail = card.kind === "rung"
      ? [card.model, this.accountOf(card.name)].filter(Boolean).join(" · ")
      : card.kind === "reviewer"
        ? [card.model, card.reviewer.provider].filter(Boolean).join(" · ")
        : `${card.harness} · no rung`;
    const tag = card.kind === "rung" ? (card.rung.enabled ? card.rung.state : "disabled") : null;
    return h_flex().absolute().left(rect.x).top(rect.y).w(rect.width).h(rect.height)
      .rounded(6).overflow_hidden().bg(t.surface).border(1).border_color(t.border)
      .child(div().w(STRIPE).h_full().bg(color).flex_none())
      .child(v_flex().flex_1().min_w(0).px(8).py(4).gap(1)
        .child(h_flex().gap(6).text_size(12)
          .child(div().flex_1().truncate().child(card.name))
          .when(tag !== null, (el) => el.child(div().flex_none().text_size(10).text_color(t.muted).child(tag)))
          .when(card.kind !== "model", (el) => el.child(thinking)))
        .child(div().text_size(10).text_color(t.muted).truncate().child(detail)));
  }

  // The card's thinking level. "default" is no level: the harness's own default applies.
  thinking(card, t) {
    return div().flex_none().px(5).rounded(4).text_size(10)
      .bg(t.canvas).text_color(card.thinking === null ? t.dim : t.foreground)
      .child(card.thinking ?? "default");
  }
}

// What the pane kept open; nothing, the first time.
const storedOpen = () => {
  try {
    const kept = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
    return new Set(Array.isArray(kept) ? kept.filter((key) => typeof key === "string") : []);
  } catch { return new Set(); }
};
