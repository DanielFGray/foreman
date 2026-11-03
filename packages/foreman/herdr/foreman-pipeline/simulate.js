// The pipeline pane's simulator: a pretend task walked through the project's
// draft (else the pipeline it runs), one event at a time. foreman decides
// every step with the dispatcher's own rules (`foreman pipeline trace`), so
// this file holds only the pretend task and the events chosen so far, and
// replays them after each choice and each change to the draft.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { chip, picker } from "./parts.js";

const SIZES = ["1", "2", "3"];

export class Simulator {
  // Runs in the pane's `init`, the one place besides a handler that may make inputs.
  constructor(pane) {
    this.pane = pane;
    this.on = false;
    this.size = "2";
    this.events = [];
    this.trace = null;
    this.problem = null;
    this.labels = InputState.new({ placeholder: "labels, such as research bug" });
    this.labels.on("submit", (_event, cx) => this.run(cx));
  }

  toggle(cx) {
    this.on = !this.on;
    if (this.on) this.run(cx);
    else { this.trace = null; this.problem = null; cx.notify(); }
  }

  // Replays the pretend task and its events, and takes foreman's answer.
  run(cx) {
    const labels = this.labels.value().split(/[\s,]+/).filter((label) => label !== "");
    const request = { task: { labels, size: Number(this.size) }, events: this.events };
    cx.spawn(async (cx) => {
      const result = await this.pane.foreman(["pipeline", "trace", this.pane.project, JSON.stringify(request), "--json"]);
      if (result.code !== 0) this.problem = result.stderr.trim().split("\n").at(-1) || `foreman exited ${result.code}`;
      else {
        try { this.trace = JSON.parse(result.stdout); this.problem = null; }
        catch (error) { this.problem = String(error.message ?? error); }
      }
      cx.notify();
    });
  }

  choose(event, cx) { this.events = [...this.events, event]; this.run(cx); }

  // Goes back to the step after the first `count` events.
  back(count, cx) { this.events = this.events.slice(0, count); this.run(cx); }

  // How the board marks a block: where the task stands now, a block it passed, or neither.
  mark(blockId) {
    const last = this.trace?.steps.at(-1);
    if (!this.on || last === undefined) return null;
    if (standsAt(last.placement) === blockId) return "here";
    return last.route.includes(blockId) ? "passed" : null;
  }

  // The pretend task, the events offered where it stands, and the steps so far.
  toolbar(t) {
    const bar = v_flex().id("simulate").max_h(260).overflow_y_scrollbar().px(10).py(5).gap(4).bg(t.surface).border_b(1).border_color(t.border);
    const task = h_flex().flex_wrap().gap_x(8).gap_y(4).items_center()
      .child(div().w(64).text_color(t.muted).child("labels"))
      .child(Input.new(this.labels).w(200).h(22).px(6).rounded(4).border(1).border_color(t.border).bg(t.canvas).text_size(12).text_color(t.foreground))
      .child(picker(t, "size", SIZES, this.size, (size, cx) => { this.size = size; this.run(cx); }))
      .child(chip(t, "start again", "simulate-reset", (cx) => this.back(0, cx)));
    if (this.problem !== null) return bar.child(task).child(div().text_color(t.blocked).child(this.problem));
    if (this.trace === null) return bar.child(task).child(div().text_color(t.muted).child("tracing…"));
    const { steps, refused, source, assumes } = this.trace;
    const last = steps.at(-1);
    return bar.child(task)
      .child(h_flex().flex_wrap().gap_x(8).gap_y(4).items_center()
        .child(div().font_semibold().child(whereNow(last)))
        .when(last.offers.length > 0, (el) => el.child(div().text_color(t.muted).child("then:")))
        .children(last.offers.map((offer) => chip(t, offerName(offer), `offer-${offer}`, (cx) => this.choose(offer, cx)))))
      .when(refused !== null, (el) => el.child(div().text_color(t.blocked)
        .child(`the ${source} no longer offers ${offerName(refused.event)} here, so the steps after it are dropped`)))
      .children(steps.map((step, index) => h_flex().id(`step-${index}`).gap(8).rounded(4).px(4)
        .when(index < steps.length - 1, (el) => el.hover((s) => s.bg(t.hover)).on_click((_event, cx) => this.back(index, cx)))
        .child(div().w(18).text_color(t.dim).child(String(index)))
        .child(div().w(110).text_color(t.muted).truncate().child(step.event === null ? "start" : offerName(step.event)))
        .child(div().flex_1().truncate().child(whereNow(step)))))
      .child(div().text_color(t.dim).child(`Traced through the ${source}. ${assumes.accounts} ${assumes.gates}`));
  }
}

// The block a placement stands the task at, if any.
const standsAt = (placement) => placement._tag === "At" ? placement.node.id : placement._tag === "Parked" ? placement.node : null;

// One step in words: where the task stands, on which rung, or why it stopped.
const whereNow = (step) => {
  const { placement, rung, parked } = step;
  if (parked !== null) return `parked: ${parked}`;
  if (placement._tag === "Outside") return step.event === "landed" ? "landed: the task is done" : "outside the pipeline";
  if (placement._tag === "Parked") return `parked at ${placement.node}`;
  const on = rung === null ? "" : rung._tag === "Dispatch" ? ` on ${rung.name}` : rung._tag === "Waiting" ? ", waiting for a rung with room" : ", and every rung has failed it";
  return `at ${placement.node.id}, ${placement.state}${on}`;
};

// An event as the operator reads it: an exit by its name.
const offerName = (offer) => offer.startsWith("exit:") ? offer.slice("exit:".length) : offer;
