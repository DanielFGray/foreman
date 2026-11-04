// The Tasks view's Graph mode: the project's open and claimed tasks and
// epics, each in a column right of the items it waits for, and the grant that
// covers each. foreman lays the graph out and names the steps a grant gives
// (`foreman pipeline graph <project> --json`), so this file draws cards and
// runs grants and revokes.
//
// A click picks a card, a shift-click adds it to the picked cards or takes it
// out, and `send through` runs `foreman policy grant <id> <steps>` for each
// picked card: an epic's grant covers every task under it.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { chip } from "./parts.js";
import { refusalOf } from "./status.js";

const CARD_W = 136;
const GAP = 6;

export class Tasks {
  constructor(pane) {
    this.pane = pane;
    this.report = null;
    this.problem = null;
    this.loading = false;
    this.picked = new Set();
  }

  // Drops what was read for another project.
  clear() { this.report = null; this.problem = null; this.picked = new Set(); }

  load(cx) {
    const project = this.pane.project();
    if (this.loading || project === null) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      const result = await this.pane.foreman(["pipeline", "graph", project, "--json"]);
      this.loading = false;
      // The space moved to another project while this read ran: read for the one shown now.
      if (this.pane.project() !== project) { this.load(cx); return; }
      if (result.code !== 0) this.problem = refusalOf(result);
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

  view(t) {
    const view = v_flex().id("tasks").flex_1().min_h(0).w_full().bg(t.canvas);
    if (this.problem !== null) return view.p(GAP).child(div().text_color(t.blocked).child(this.problem));
    if (this.report === null) return view.p(GAP).child(div().text_color(t.muted).child("reading the tasks…"));
    const columns = [];
    for (const item of this.report.items) (columns[item.column] ??= []).push(item);
    for (const column of columns) column?.sort((a, b) => a.row - b.row);
    const placed = new Map(this.pane.placements().map((one) => [one.key, one]));
    return view
      .child(this.bar(t))
      .child(div().id("task-graph").flex_1().overflow_scrollbar().p(GAP)
        .child(h_flex().items_start().gap(GAP)
          .children(columns.map((column, index) => v_flex().id(`column-${index}`).w(CARD_W).gap(GAP)
            .children((column ?? []).map((item) => this.card(item, placed.get(item.id), t)))))));
  }

  // What a grant gives, the picked cards, and what can be done with them.
  bar(t) {
    const { grantSteps, steps } = this.report;
    const picked = this.report.items.filter((item) => this.picked.has(item.id));
    const one = picked.length === 1 ? picked[0] : null;
    // The pick row keeps one height, picked or not, so a pick never moves the
    // cards under the pointer before the next click.
    const row = h_flex().h(22).flex_none().gap(6).items_center().overflow_hidden();
    return v_flex().px(GAP).py(4).gap(3).bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_color(t.muted).truncate().child(stepsLine(steps, grantSteps)))
      .child(picked.length === 0
        ? row.child(div().text_color(t.dim).truncate().child("click a card to pick it, shift-click to pick more"))
        : row
          .child(div().flex_none().child(one === null ? `${picked.length} picked` : one.id))
          .when(grantSteps.length > 0, (el) => el.child(chip(t, picked.length === 1 ? "send through" : `send ${picked.length} through`, "send-through", (cx) => this.grant(picked.map((item) => item.id), cx)).flex_none()))
          .when(one?.grant != null, (el) => el.child(chip(t, one.grant.scope === one.id ? "revoke" : `revoke ${one.grant.scope}, the whole epic`, "revoke", (cx) => this.revoke(one.grant.scope, cx)).flex_none()))
          .child(chip(t, "clear", "clear-picked", (cx) => { this.picked = new Set(); cx.notify(); }).flex_none())
          .when(one !== null, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(one.title))));
  }

  card(item, placement, t) {
    const picked = this.picked.has(item.id);
    return v_flex().id(`card-${item.id}`).w(CARD_W).p(4).gap(1).rounded(4).border(picked ? 2 : 1)
      .border_color(picked ? t.accent : item.grant !== null ? t.done : t.border)
      .bg(item.type === "epic" ? t.canvas : t.surface)
      .hover((s) => s.bg(t.hover))
      .on_click((event, cx) => this.pick(item.id, event.modifiers?.shift === true, cx))
      .child(h_flex().gap(4).text_size(10)
        .child(div().text_color(t.muted).child(item.type === "epic" ? `epic ${item.id}` : item.id))
        .child(div().flex_1())
        .when(item.grant !== null, (el) => el.child(div().text_color(t.done)
          .child(grantMark(item, this.report.grantSteps)))))
      .child(div().text_size(11).truncate().child(item.title))
      .child(div().text_size(10).text_color(t.dim).truncate().child(standing(item, placement)));
  }
}

// Where a card's task stands: at a block on the board, waiting for its
// blockers, or neither yet.
const standing = (item, placement) => {
  if (item.waitsFor.length > 0) return `waits for ${item.waitsFor.join(", ")}`;
  if (placement !== undefined) return `at ${placement.node}, ${placement.state}`;
  return item.type === "epic" ? item.status : `${item.status}, not placed`;
};

// What a grant from this view does, against what runs for every task anyway.
const stepsLine = (steps, grantSteps) => {
  if (steps.length === 0) return "this pipeline has no gate, so every task goes through";
  const on = steps.filter(({ mode }) => mode === "on").map(({ step }) => step);
  if (grantSteps.length === 0) return `${words(on)} run for every task, so a grant changes nothing`;
  const rest = on.length === 0 ? "no step runs without one" : `${words(on)} run for every task`;
  return `send a card through to grant it ${words(grantSteps)}; ${rest}`;
};

const words = (list) => list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

// A card's grant in a few words: whether it is its own or its epic's, and
// which steps, when it gives only some of the steps a grant from here gives.
const grantMark = (item, grantSteps) => {
  const some = item.type === "task" && item.grant.steps.length < grantSteps.length;
  const what = some ? `${item.grant.steps.join(", ")} granted` : "granted";
  return item.grant.scope === item.id ? what : `${what} by ${item.grant.scope}`;
};
