// The pipeline pane's task graph: the project's open and claimed tasks and
// epics, each in a column right of the items it waits for, and the grant that
// covers each. foreman lays the graph out and names the steps a grant gives
// (`foreman pipeline graph <project> --json`), so this file draws cards and
// runs grants and revokes.
//
// A card dropped on the board, or the picked cards sent through, runs
// `foreman policy grant <id> <steps>`: an epic's grant covers every task
// under it. A drag lists one target, the board, and runs on the pane's one
// drag (`drag.js`).
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { chip, refusalOf } from "./parts.js";

const CARD_W = 136;
const GAP = 6;

export class Tasks {
  constructor(pane) {
    this.pane = pane;
    this.on = false;
    this.report = null;
    this.problem = null;
    this.loading = false;
    this.picked = new Set();
    // The board's bounds in the window, taken from the last move over it.
    this.board = null;
  }

  toggle(cx) {
    this.on = !this.on;
    if (this.on) this.load(cx);
    else { this.report = null; this.problem = null; this.picked = new Set(); }
    cx.notify();
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      const result = await this.pane.foreman(["pipeline", "graph", this.pane.project, "--json"]);
      this.loading = false;
      if (result.code !== 0) this.problem = result.stderr.trim().split("\n").at(-1) || `foreman exited ${result.code}`;
      else {
        try {
          this.report = JSON.parse(result.stdout);
          this.problem = null;
          const shown = new Set(this.report.items.map((item) => item.id));
          this.picked = new Set([...this.picked].filter((id) => shown.has(id)));
        } catch (error) { this.problem = String(error.message ?? error); }
      }
      cx.notify();
    });
  }

  // The panel's width: one card column per graph column, and at most half the
  // pane, so the board stays in view to drop on. Wider graphs scroll across.
  width() {
    if (!this.on) return 0;
    const columns = this.report === null ? 1 : Math.max(1, ...this.report.items.map((item) => item.column + 1));
    const half = this.pane.size === null ? Infinity : this.pane.size.width / 2;
    return Math.max(CARD_W + 3 * GAP, Math.min(columns * (CARD_W + GAP) + 3 * GAP, half));
  }

  // Runs each foreman command in turn, stopping at the first refusal, then reads the graph again.
  run(commands, cx) {
    this.pane.busy = true; this.pane.problem = null; cx.notify();
    cx.spawn(async (cx) => {
      for (const args of commands) {
        const result = await this.pane.foreman(args);
        if (result.code !== 0) { this.pane.problem = refusalOf(result); break; }
      }
      this.pane.busy = false;
      this.load(cx);
    });
  }

  grant(ids, cx) {
    const steps = this.report?.grantSteps ?? [];
    if (steps.length === 0) { this.pane.problem = "every step this pipeline gates on is on, so a grant changes nothing"; cx.notify(); return; }
    this.run(ids.map((id) => ["policy", "grant", id, ...steps]), cx);
  }

  revoke(scope, cx) { this.run([["policy", "revoke", scope]], cx); }

  // A click picks the card alone, or unpicks it when it was the one picked; a
  // shift-click adds it to the picked cards or takes it out.
  pick(id, add, cx) {
    const had = this.picked.has(id);
    if (add) {
      const picked = new Set(this.picked);
      if (had) picked.delete(id); else picked.add(id);
      this.picked = picked;
    } else this.picked = new Set(had && this.picked.size === 1 ? [] : [id]);
    cx.notify();
  }

  // The board's own move handler, which is where its bounds come from.
  overMoved(event) { this.board = event.bounds; }

  // A press on a card. Its one target state is granted, and the rectangle a
  // granted card has is the board, from the board's last move.
  press(item, event) {
    const at = event.position;
    this.pane.drag.press(item.id, at, event.bounds ?? { x: at.x, y: at.y, width: 0, height: 0 }, () =>
      this.board == null ? [] : [{ rect: this.board, run: (cx) => this.grant([item.id], cx) }]);
  }

  dragged() { return this.report?.items.find((one) => this.pane.drag.dragging(one.id)); }

  // Whether the board should show that a drop there grants the card.
  dropping() { return this.dragged() !== undefined && this.pane.drag.preview() !== null; }

  // The card that follows the pointer while dragging, in pane coordinates.
  ghost(t) {
    const item = this.dragged();
    if (item === undefined) return null;
    const rect = this.pane.local(this.pane.drag.floating());
    return div().absolute().left(rect.x).top(rect.y).w(CARD_W).p(4)
      .rounded(4).border(1).border_color(t.accent).bg(t.surface).opacity(0.9)
      .child(div().text_color(t.muted).child(item.id))
      .child(div().truncate().child(item.title))
      .child(div().text_size(10).text_color(t.accent).child(this.dropping() ? "drop to grant" : "drop on the board"));
  }

  view(t) {
    const panel = v_flex().id("tasks").w(this.width()).h_full().bg(t.chrome).border_r(1).border_color(t.border);
    if (this.problem !== null) return panel.p(GAP).child(div().text_color(t.blocked).child(this.problem));
    if (this.report === null) return panel.p(GAP).child(div().text_color(t.muted).child("reading the tasks…"));
    const columns = [];
    for (const item of this.report.items) (columns[item.column] ??= []).push(item);
    for (const column of columns) column?.sort((a, b) => a.row - b.row);
    return panel
      .child(this.bar(t))
      .child(div().id("task-graph").flex_1().overflow_scrollbar().p(GAP)
        .child(h_flex().items_start().gap(GAP)
          .children(columns.map((column, index) => v_flex().id(`column-${index}`).w(CARD_W).gap(GAP)
            .children((column ?? []).map((item) => this.card(item, t)))))));
  }

  // What a grant gives, the picked cards, and what can be done with them.
  bar(t) {
    const { grantSteps, steps } = this.report;
    const picked = this.report.items.filter((item) => this.picked.has(item.id));
    const one = picked.length === 1 ? picked[0] : null;
    return v_flex().px(GAP).py(4).gap(3).border_b(1).border_color(t.border)
      .child(div().text_color(t.muted).child(stepsLine(steps, grantSteps)))
      .when(picked.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).items_center()
        .child(div().child(one === null ? `${picked.length} picked` : one.id))
        .when(grantSteps.length > 0, (el) => el.child(chip(t, picked.length === 1 ? "send through" : `send ${picked.length} through`, "send-through", (cx) => this.grant(picked.map((item) => item.id), cx))))
        .when(one?.grant != null, (el) => el.child(chip(t, one.grant.scope === one.id ? "revoke" : `revoke ${one.grant.scope}, the whole epic`, "revoke", (cx) => this.revoke(one.grant.scope, cx))))
        .child(chip(t, "clear", "clear-picked", (cx) => { this.picked = new Set(); cx.notify(); }))))
      .when(one !== null, (el) => el.child(div().text_color(t.muted).child(one.title)));
  }

  card(item, t) {
    const picked = this.picked.has(item.id);
    const dragged = this.pane.drag.dragging(item.id);
    return v_flex().id(`card-${item.id}`).w(CARD_W).p(4).gap(1).rounded(4).border(picked ? 2 : 1)
      .border_color(picked ? t.accent : item.grant !== null ? t.done : t.border)
      .bg(dragged ? t.hover : item.type === "epic" ? t.canvas : t.surface)
      .hover((s) => s.bg(t.hover)).cursor_grab()
      .on_mouse_down("left", (event, _cx) => this.press(item, event))
      .on_click((event, cx) => this.pick(item.id, event.modifiers?.shift === true, cx))
      .child(h_flex().gap(4).text_size(10)
        .child(div().text_color(t.muted).child(item.type === "epic" ? `epic ${item.id}` : item.id))
        .child(div().flex_1())
        .when(item.grant !== null, (el) => el.child(div().text_color(t.done)
          .child(grantMark(item, this.report.grantSteps)))))
      .child(div().text_size(11).truncate().child(item.title))
      .child(div().text_size(10).text_color(t.dim).truncate().child(this.standing(item)));
  }

  // Where a card's task stands: at a block on the board, waiting for its
  // blockers, or neither yet.
  standing(item) {
    const placement = this.pane.placements.find((one) => one.key === item.id);
    if (item.waitsFor.length > 0) return `waits for ${item.waitsFor.join(", ")}`;
    if (placement !== undefined) return `at ${placement.node}, ${placement.state}`;
    return item.type === "epic" ? item.status : `${item.status}, not placed`;
  }
}

// What a grant from this pane does, against what runs for every task anyway.
const stepsLine = (steps, grantSteps) => {
  if (steps.length === 0) return "this pipeline has no gate, so every task goes through";
  const on = steps.filter(({ mode }) => mode === "on").map(({ step }) => step);
  if (grantSteps.length === 0) return `${words(on)} run for every task, so a grant changes nothing`;
  const rest = on.length === 0 ? "no step runs without one" : `${words(on)} run for every task`;
  return `drop a card on the board to grant it ${words(grantSteps)}; ${rest}`;
};

const words = (list) => list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

// A card's grant in a few words: whether it is its own or its epic's, and
// which steps, when it gives only some of the steps a grant from here gives.
const grantMark = (item, grantSteps) => {
  const some = item.type === "task" && item.grant.steps.length < grantSteps.length;
  const what = some ? `${item.grant.steps.join(", ")} granted` : "granted";
  return item.grant.scope === item.id ? what : `${what} by ${item.grant.scope}`;
};
