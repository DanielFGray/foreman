// The Foreman pane's Models view: the ladder's rungs and the council, from
// one `foreman ladder --json`. A model can be a worker, a council member, both
// or neither, so three columns show it: Workers (the rungs, cheapest first,
// in rank order), Models (the models that are neither) and Council.
//
// Every change is one foreman command, and the view reads `foreman ladder
// --json` again after it: the lists never change before foreman answers.
// - A worker dragged to another place in Workers runs `foreman ladder move`.
// - A worker or a Models card dropped on Council runs `foreman council add`.
// - A Council card dropped on Models runs `foreman council remove`.
// - A click on a rung's enabled mark runs `foreman ladder enable|disable`.
//
// The view lays its cards out itself, so a drag's targets are the rectangles
// the same layout gives the card in each state it can reach (`drag.js`).
//
// Under the columns, Accounts lists each account the ladder draws on: its
// quota row from state.json (what it has left, or why it is unreadable) and
// the rungs it pays for (`accounts` there). A worker card names its account.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { moveArgs } from "./ladder-order.js";
import { refusalOf } from "./parts.js";
import { HEAD, PAD, columnHead, columnsAcross, scrolledBy } from "./columns.js";

const GAP = 8;
const CARD_H = 40;
const STRIPE = 3;
// Wider than a Board column: a card's first line holds the name, the tier and
// the trial state, and its second the model, the thinking and the account.
const COLUMN_MIN = 260;

const COLUMNS = [
  { key: "workers", label: "Workers", color: (t) => t.working },
  { key: "models", label: "Models", color: (t) => t.muted },
  { key: "council", label: "Council", color: (t) => t.accent },
];
const [WORKERS, MODELS, COUNCIL] = [0, 1, 2];

export class Models {
  constructor(pane) {
    this.pane = pane;
    // The last `foreman ladder --json`: { rungs, models }.
    this.ladder = null;
    this.bounds = null;
    this.scroll = { x: 0, y: 0 };
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

  // Runs one foreman command, then reads the ladder again whatever it answered.
  run(args, cx) { this.pane.act(args, cx, (_done, cx) => this.load(cx)); }

  // Each column's cards. A card's key is unique across the view.
  columns() {
    if (this.ladder === null) return [[], [], []];
    const { rungs, models } = this.ladder;
    const workers = new Set(rungs.map((rung) => rung.model));
    return [
      rungs.map((rung) => ({ key: `w:${rung.rung}`, kind: "worker", rung, model: rung.model, title: rung.rung })),
      models.filter((one) => !one.council && !workers.has(one.model))
        .map((one) => ({ key: `m:${one.model}`, kind: "model", model: one.model, title: one.model, entry: one })),
      models.filter((one) => one.council)
        .map((one) => ({ key: `c:${one.model}`, kind: "council", model: one.model, title: one.model, entry: one })),
    ];
  }

  // Every card's rectangle in view coordinates, each column's x and width, and
  // how far the columns reach past the view's right edge.
  layout(columns) {
    const width = this.bounds?.width ?? this.pane.size?.width ?? 600;
    const { xs, columnW, overflow } = columnsAcross(width, COLUMNS.length, { min: COLUMN_MIN, gap: GAP, scroll: this.scroll });
    const rects = new Map();
    columns.forEach((cards, index) => cards.forEach((card, row) =>
      rects.set(card.key, { x: xs[index], y: PAD + HEAD - this.scroll.y + row * (CARD_H + GAP), width: columnW, height: CARD_H })));
    return { rects, xs, columnW, overflow };
  }

  // The states a card can reach: where it stands, which runs nothing; for a
  // worker, every other place in Workers; for a model not in the council, the
  // foot of Council; for a council card, the foot of Models.
  targets(card, columns) {
    if (this.bounds === null) return [];
    const window = (rect) => ({ ...rect, x: rect.x + this.bounds.x, y: rect.y + this.bounds.y });
    const at = (moved) => window(this.layout(moved).rects.get(card.key));
    const without = columns.map((cards) => cards.filter((one) => one.key !== card.key));
    const targets = [{ rect: window(this.layout(columns).rects.get(card.key)), run: null }];
    if (card.kind === "worker") {
      const rungs = this.ladder.rungs.map((rung) => rung.rung);
      const from = rungs.indexOf(card.rung.rung);
      for (let index = 0; index < rungs.length; index++) {
        if (index === from) continue;
        const moved = without.map((cards, column) => column === WORKERS ? [...cards.slice(0, index), card, ...cards.slice(index)] : cards);
        targets.push({ rect: at(moved), run: (cx) => this.run(moveArgs(rungs, card.rung.rung, index), cx) });
      }
    }
    const inCouncil = this.ladder.models.some((one) => one.model === card.model && one.council);
    if (card.kind !== "council" && !inCouncil) {
      const moved = without.map((cards, column) => column === COUNCIL ? [...cards, card] : cards);
      targets.push({ rect: at(moved), run: (cx) => this.run(["council", "add", card.model], cx) });
    }
    if (card.kind === "council") {
      const moved = without.map((cards, column) => column === MODELS ? [...cards, card] : cards);
      targets.push({ rect: at(moved), run: (cx) => this.run(["council", "remove", card.model], cx) });
    }
    return targets;
  }

  press(card, event) {
    const columns = this.columns();
    const rect = this.layout(columns).rects.get(card.key);
    const origin = this.bounds ?? { x: 0, y: 0 };
    this.pane.drag.press(card.key, event.position, { ...rect, x: rect.x + origin.x, y: rect.y + origin.y }, () => this.targets(card, columns));
  }

  view(t) {
    if (this.ladder === null) return div().p(12).text_color(t.muted).child("reading the ladder…");
    const columns = this.columns();
    const { rects, xs, columnW } = this.layout(columns);
    const drag = this.pane.drag;
    const preview = drag.preview();
    const origin = this.bounds ?? { x: 0, y: 0 };
    const dragged = columns.flat().find((card) => drag.dragging(card.key));
    const floating = dragged === undefined ? null : drag.floating();
    const board = div().id("models-board").relative().flex_1().w_full().min_h(0).overflow_hidden().bg(t.canvas)
      .on_mouse_move((event, _cx) => { this.bounds = event.bounds; })
      .on_scroll_wheel((event, cx) => { this.scroll = scrolledBy(this.scroll, event, this.layout(this.columns()).overflow); cx.notify(); })
      .children(COLUMNS.map((column, index) => columnHead(column, xs[index], columnW, columns[index].length, t)))
      .children(columns.flatMap((cards, index) => cards.map((card) =>
        this.card(card, COLUMNS[index], rects.get(card.key), t, card === dragged))))
      .when(dragged !== undefined && preview !== null && preview.run !== null, (el) => el.child(
        div().absolute().left(preview.rect.x - origin.x).top(preview.rect.y - origin.y).w(preview.rect.width).h(preview.rect.height)
          .rounded(6).border(2).border_color(t.accent)))
      .when(floating !== null, (el) => el.child(
        this.card(dragged, COLUMNS[columns.findIndex((cards) => cards.includes(dragged))], { ...floating, x: floating.x - origin.x, y: floating.y - origin.y }, t, false)
          .opacity(0.9)));
    return v_flex().flex_1().min_h(0).child(board).child(this.accounts(t));
  }

  // Each account: its quota row, and the rungs that draw on it.
  accounts(t) {
    const published = this.pane.published;
    const quota = (published?.rows ?? []).filter((row) => row.view === "quota");
    return v_flex().id("accounts").flex_none().max_h(200).overflow_y_scrollbar().px(PAD).py(6).gap(4).bg(t.surface).border_t(1).border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).child("ACCOUNTS"))
      .when(quota.length === 0, (el) => el.child(div().text_color(t.muted).child("no account reading yet")))
      .children(quota.map((row) => {
        const rungs = published.accounts.find((account) => account.provider === row.key)?.rungs ?? [];
        return v_flex().gap(1)
          .child(h_flex().gap(8)
            .child(div().font_semibold().child(row.label))
            .child(div().text_color(t.muted).truncate().child(rungs.length === 0 ? "no rung draws on it" : rungs.join(", "))))
          .when(row.detail != null, (el) => el.child(div().text_size(11).text_color(t.muted).child(row.detail)));
      }));
  }

  // The account a rung draws on, as state.json names it.
  accountOf(rung) {
    return this.pane.published?.accounts.find((account) => account.rungs.includes(rung))?.provider ?? null;
  }

  card(card, column, rect, t, ghost) {
    const color = column.color(t);
    const rung = card.kind === "worker" ? card.rung : null;
    const dim = rung !== null && !rung.enabled;
    const tier = rung?.tier ?? card.entry.tier;
    const account = rung === null ? null : this.accountOf(rung.rung);
    const detail = rung === null ? card.entry.harness : [rung.model, rung.thinking, account].filter(Boolean).join(" · ");
    return h_flex().id(`models-card-${card.key}`).absolute().left(rect.x).top(rect.y).w(rect.width).h(rect.height)
      .rounded(6).overflow_hidden().bg(t.surface).border(1).border_color(t.border)
      .when(ghost, (el) => el.opacity(0.35))
      .when(dim && !ghost, (el) => el.opacity(0.5))
      .hover((s) => s.border_color(color))
      .cursor_grab().on_mouse_down("left", (event, _cx) => this.press(card, event))
      .child(div().w(STRIPE).h_full().bg(color).flex_none())
      .child(v_flex().flex_1().min_w(0).px(8).py(4).gap(1)
        .child(h_flex().gap(6).text_size(12)
          .when(rung !== null, (el) => el.child(this.enabledMark(rung, t)))
          .child(div().flex_1().truncate().child(card.title))
          .child(div().flex_none().text_size(10).text_color(t.muted).child(tier))
          .when(rung !== null, (el) => el.child(div().flex_none().text_size(10).text_color(t.muted).child(rung.state))))
        .child(div().text_size(10).text_color(t.muted).truncate().child(detail)));
  }

  // The rung's enabled mark; a click enables or disables the rung.
  enabledMark(rung, t) {
    return div().id(`models-enabled-${rung.rung}`).flex_none().text_color(rung.enabled ? t.done : t.dim)
      .hover((s) => s.text_color(t.accent))
      .on_click((_event, cx) => this.run(["ladder", rung.enabled ? "disable" : "enable", rung.rung], cx))
      .child(rung.enabled ? "●" : "○");
  }
}
