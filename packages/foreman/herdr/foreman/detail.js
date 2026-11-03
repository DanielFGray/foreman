// The strip under the Tasks board for the selected card: the task's record as
// its tracker keeps it (`foreman show <id> --json`), its page and pull
// request, every action its row takes (`foreman <action> <key>`), `launch`
// with a rung picker (`foreman dispatch <id> --rung <r>`) for a Queue card,
// and an `allow <step>` chip for each gate an ask holds it at.
//
// The record is read again each time a card is selected: the board only
// carries a title, and a log grows while the task is worked.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { chip } from "./parts.js";
import { pullRequestLine, TASK_ID } from "./status.js";

// These take an answer the pane has no input for; the CLI takes them.
const NEEDS_INPUT = new Set(["complete", "intervene"]);
// These end an agent or give up a claim, so a first click only arms them.
const DESTRUCTIVE = new Set(["kill", "close", "release"]);
// The detail shows this many of the task's newest log entries.
const LOGS_SHOWN = 3;

export class Detail {
  constructor(pane) {
    this.pane = pane;
    // The selected card's key, its record as last read, and the action armed by a first click.
    this.key = null;
    this.record = null;
    this.armed = null;
    this.launching = false;
    // The ladder's dispatchable rungs, read once for the launch picker.
    this.rungs = null;
  }

  // Selects a card, or clears the selection when it was the one selected.
  toggle(key, cx) {
    this.armed = null; this.launching = false;
    this.key = this.key === key ? null : key;
    this.record = null;
    cx.notify();
    // A card keyed by a project or an account has no task to read.
    const id = key.match(TASK_ID)?.[0];
    if (this.key === null || id === undefined) return;
    cx.spawn(async (cx) => {
      const result = await this.pane.foreman(["show", id, "--json"]);
      let record;
      try {
        record = result.code === 0 ? JSON.parse(result.stdout) : { error: (result.stderr || result.stdout).trim() };
      } catch (error) { record = { error: `foreman show's answer is not JSON: ${error.message}` }; }
      if (this.key === key) { this.record = record; cx.notify(); }
    });
  }

  clear() { this.key = null; this.record = null; this.armed = null; this.launching = false; }

  loadRungs(cx) {
    if (this.rungs !== null) return;
    this.rungs = [];
    cx.spawn(async (cx) => {
      const result = await this.pane.foreman(["ladder", "list", "--json"]);
      if (result.code === 0) { try { this.rungs = JSON.parse(result.stdout).filter((rung) => rung.state !== "disabled"); } catch {} }
      cx.notify();
    });
  }

  run(args, cx) {
    this.armed = null; this.launching = false;
    this.pane.act(args, cx, (_done, cx) => { this.pane.loadQueue(cx); cx.notify(); });
  }

  action(action, key, cx) {
    const id = `${action} ${key}`;
    if (DESTRUCTIVE.has(action) && this.armed !== id) { this.armed = id; cx.notify(); return; }
    this.run([action, key], cx);
  }

  // `card` is the selected board card: a placement or a landed task, with the row it stands for.
  view(t, card) {
    if (card === undefined) return div();
    const row = card.row;
    const actions = (row?.actions ?? []).filter((action) => !NEEDS_INPUT.has(action));
    const launchable = card.column === "queue" && row?.epic !== true;
    const asked = row?.actions.includes("approve") === true ? (card.gates ?? []).map((gate) => gate.step) : [];
    const pr = card.pr ?? row?.pr ?? null;
    const url = card.url ?? row?.url ?? null;
    const note = (text, tone) => div().text_size(11).text_color(tone ?? t.muted).child(text);
    return v_flex().id("card-detail").flex_none().max_h(320).overflow_y_scrollbar().p(10).gap(4).bg(t.surface).border_t(1).border_color(t.border)
      .on_click((_event, cx) => { if (this.armed !== null) { this.armed = null; cx.notify(); } })
      .child(h_flex().gap(8).items_center()
        .child(div().text_color(t.muted).child(card.key))
        .child(div().flex_1().font_semibold().truncate().child(card.label))
        .child(chip(t, "close", "detail-close", (cx) => { this.clear(); cx.notify(); })))
      .when(row?.detail != null, (el) => el.child(note(row.detail, card.column === "needs-you" ? t.blocked : undefined)))
      .when(url !== null, (el) => el.child(note(url, t.dim)))
      .when(pr !== null, (el) => el.child(note(pullRequestLine(pr))))
      .when(actions.length > 0 || launchable || asked.length > 0, (el) => el.child(h_flex().flex_wrap().gap(4)
        .when(launchable, (el) => el.child(chip(t, this.launching ? "cancel" : "launch", "detail-launch", (cx) => {
          this.launching = !this.launching; this.loadRungs(cx); cx.notify();
        })))
        .children(asked.map((step) => chip(t, `allow ${step}`, `detail-allow-${step}`,
          (cx) => this.run(["policy", "grant", card.key, step, "--count", "1"], cx))))
        .children(actions.map((action) => {
          const armed = this.armed === `${action} ${row.key}`;
          return chip(t, armed ? `${action}?` : action, `detail-${action}`, (cx) => this.action(action, row.key, cx));
        }))))
      .when(this.launching, (el) => el.child(h_flex().flex_wrap().gap(4)
        .children((this.rungs ?? []).map((rung) => chip(t, rung.rung, `detail-rung-${rung.rung}`,
          (cx) => this.run(["dispatch", card.key, "--rung", rung.rung], cx))))))
      .child(this.recordView(t, note));
  }

  // The task as its tracker records it: facts, description, definition of done and newest logs.
  recordView(t, note) {
    const task = this.record;
    if (this.key.match(TASK_ID) === null) return div();
    if (task === null) return note("reading the task…");
    if (task.error) return note(task.error, t.blocked);
    const facts = [task.type === "epic" ? "epic" : null, task.status, `priority ${task.priority}`, task.project, task.parent ? `under ${task.parent}` : null, ...task.labels].filter(Boolean);
    const logs = task.logs.slice(-LOGS_SHOWN).reverse();
    return v_flex().gap(6).pt(4).border_t(1).border_color(t.border)
      .child(note(facts.join(" · ")))
      .when(Boolean(task.description), (el) => el.child(div().text_size(12).child(task.description)))
      .when(Boolean(task.definitionOfDone), (el) => el.child(note(`Done when: ${task.definitionOfDone}`)))
      .children(logs.map((log, i) => v_flex().id(`log-${i}`).gap(1)
        .child(note(log.createdAt.slice(0, 16).replace("T", " "), t.dim))
        .child(div().text_size(11).child(log.message))))
      .when(task.logs.length > LOGS_SHOWN, (el) => el.child(note(`${task.logs.length - LOGS_SHOWN} older log entries: foreman show ${task.id ?? this.key}`, t.dim)));
  }
}
