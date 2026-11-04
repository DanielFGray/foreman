// The Pipeline view's fleet simulation: the project's real tasks played
// through its draft and through the pipeline it runs, on one seed, by
// `foreman pipeline simulate`. foreman plans and steps every task with the
// dispatcher's own rules and draws outcomes from measured rates, so this file
// holds only the answer and a time to show it at: it compares the two runs,
// and puts one run's tasks on the board as they stood at that time.
import { div } from "gpui-kit";
import { v_flex, h_flex, SliderState, Slider, SliderTrack, SliderIndicator, SliderThumb } from "gpui-base";
import { chip, picker } from "./parts.js";
import { refusalOf } from "./status.js";

const HORIZONS = ["24", "72", "168"];
// The slider runs over the horizon in this many steps, whatever its hours.
const STEPS = 1000;
// Playing moves the slider one step this often, so a whole run plays in 20 s.
const PLAY_MS = 20;

export class Fleet {
  // Runs in the pane's `init`, the one place besides a handler that may make a slider.
  constructor(pane) {
    this.pane = pane;
    this.on = false;
    this.hours = "72";
    this.seed = 1;
    this.report = null;
    this.problem = null;
    this.running = false;
    this.which = "draft";
    this.details = false;
    this.playing = null;
    this.time = SliderState.new({ min: 0, max: STEPS, step: 1, value: STEPS });
    this.time.on("change", (_value, cx) => cx.notify());
  }

  toggle(cx) {
    this.on = !this.on;
    if (this.on) this.run(cx);
    else { this.stop(); this.report = null; this.problem = null; cx.notify(); }
  }

  // Asks foreman for both runs again, and shows the end of the horizon.
  run(cx) {
    this.stop();
    this.running = true; cx.notify();
    const args = ["pipeline", "simulate", this.pane.project(), "--seed", String(this.seed), "--hours", this.hours, "--json"];
    cx.spawn(async (cx) => {
      const result = await this.pane.foreman(args);
      this.running = false;
      if (result.code !== 0) this.problem = refusalOf(result);
      else {
        try {
          this.report = JSON.parse(result.stdout); this.problem = null;
          this.time.set_value(STEPS);
        } catch (error) { this.problem = String(error.message ?? error); }
      }
      cx.notify();
    });
  }

  // The run the board shows: the draft's when there is one and it was picked.
  shown() {
    const report = this.report;
    if (report === null) return null;
    return this.which === "draft" && report.draft !== null ? report.draft : report.saved;
  }

  // Hours since the start that the slider stands at.
  at() { return (Number(this.time.value()) / STEPS) * (this.report?.hours ?? Number(this.hours)); }

  // The tasks of the shown run as they stood at the slider's time, in the
  // shape of the dispatcher's placements, or null when the board shows the fleet.
  placements() {
    const run = this.on ? this.shown() : null;
    if (run === null) return null;
    const titles = new Map(run.tasks.map((task) => [task.id, task.title]));
    const board = new Map();
    const at = this.at();
    for (const frame of run.frames) {
      if (frame.at > at) break;
      for (const move of frame.moves) board.set(move.task, move);
    }
    return [...board.values()].filter((move) => move.node !== null)
      .map((move) => ({ node: move.node, stands: move.node, state: move.state, key: move.task, label: titles.get(move.task) ?? "", gates: [], runs: [] }));
  }

  play(cx) {
    if (this.playing !== null) { this.stop(); cx.notify(); return; }
    if (Number(this.time.value()) >= STEPS) this.time.set_value(0);
    this.playing = cx.timer.every(PLAY_MS, (cx) => {
      const next = Number(this.time.value()) + 1;
      this.time.set_value(Math.min(STEPS, next));
      if (next >= STEPS) this.stop();
      cx.notify();
    });
    cx.notify();
  }

  stop() { this.playing?.cancel(); this.playing = null; }

  // Both runs side by side, the time the board shows, and on request the rates and what the run assumes.
  toolbar(t) {
    const bar = v_flex().id("fleet").max_h(300).overflow_y_scrollbar().px(10).py(5).gap(4).bg(t.surface).border_b(1).border_color(t.border);
    const controls = h_flex().flex_wrap().gap_x(8).gap_y(4).items_center()
      .child(picker(t, "hours", HORIZONS, this.hours, (hours, cx) => { this.hours = hours; this.run(cx); }))
      .child(chip(t, "draw again", "fleet-reseed", (cx) => { this.seed += 1; this.run(cx); }))
      .child(div().text_color(t.dim).child(`seed ${this.seed}`))
      .child(chip(t, this.details ? "hide rates" : "rates", "fleet-details", (cx) => { this.details = !this.details; cx.notify(); }))
      .when(this.running, (el) => el.child(div().text_color(t.muted).child("simulating…")));
    if (this.problem !== null) return bar.child(controls).child(div().text_color(t.blocked).child(this.problem));
    const report = this.report;
    if (report === null) return bar.child(controls);
    const { draft, saved } = report;
    const shown = this.shown();
    return bar.child(controls)
      .child(div().text_color(t.muted).child(`${saved.tasks.length} tasks, ${report.slots} slot${report.slots === 1 ? "" : "s"}, ${report.hours} h`))
      .when(draft !== null, (el) => el.child(runLine(t, "draft", draft, saved)))
      .child(runLine(t, saved.source === "standard" ? "standard" : "saved", saved, draft))
      .child(h_flex().gap(8).items_center()
        .when(draft !== null, (el) => el.child(picker(t, "board", ["draft", "saved"], this.which, (which, cx) => { this.which = which; cx.notify(); })))
        .child(chip(t, this.playing === null ? "play" : "pause", "fleet-play", (cx) => this.play(cx)))
        .child(div().w(70).text_color(t.muted).child(`${this.at().toFixed(1)} h`))
        .child(div().flex_1().child(slider(this.time, t))))
      .when(draft === null, (el) => el.child(div().text_color(t.dim).child(`the board shows the ${shown.source} run`)))
      .when(this.details, (el) => el
        .children(report.rates.map((rate) => rateLine(t, rate)))
        .children(Object.values(report.assumes).map((text) => div().text_color(t.dim).child(text))));
  }
}

// One run in a line: how many landed, how soon, how many parked or still in work, and the runs it spent.
const runLine = (t, name, run, other) => {
  const landed = run.tasks.map((task) => task.landedAt).filter((at) => at !== null).sort((a, b) => a - b);
  const median = landed.length === 0 ? "none landed" : `median ${landed[Math.floor((landed.length - 1) / 2)].toFixed(1)} h to land`;
  const spent = Object.values(run.runsByRung).reduce((sum, count) => sum + count, 0);
  const better = other !== null && run.landed > other.landed;
  return h_flex().flex_wrap().gap_x(10)
    .child(div().w(64).font_semibold().text_color(name === "draft" ? t.accent : t.foreground).child(name))
    .child(div().text_color(better ? t.done : t.foreground).child(`${run.landed} landed`))
    .child(div().text_color(t.muted).child(median))
    .when(run.parked > 0, (el) => el.child(div().text_color(t.blocked).child(`${run.parked} parked`)))
    .when(run.inFlight > 0, (el) => el.child(div().text_color(t.muted).child(`${run.inFlight} still in work`)))
    .child(div().text_color(t.dim).child(`${spent} runs`))
    .when(run.problems.length > 0, (el) => el.child(div().text_color(t.blocked).child(`${run.problems.length} problem${run.problems.length === 1 ? "" : "s"}`)));
};

// One rung's rates: its role, how many of its own runs they rest on, each ending's share, and its median minutes.
const rateLine = (t, rate) => h_flex().gap(8)
  .child(div().w(170).truncate().child(rate.rung))
  .child(div().w(50).text_color(t.muted).child(rate.role))
  .child(div().w(80).text_color(rate.label === "Assumed" ? t.blocked : t.muted).child(rate.label === "Assumed" ? "assumed" : `${rate.n} runs`))
  .child(div().flex_1().truncate().text_color(t.muted).child(Object.entries(rate.endings)
    .sort(([, a], [, b]) => b - a).map(([ending, share]) => `${ending} ${Math.round(share * 100)}%`).join(", ")))
  .child(div().w(60).text_color(t.dim).child(`${rate.medianMinutes} min`));

const slider = (state, t) => Slider.new(state).child(
  SliderTrack.new(state).flex().items_center().h(18).w_full().child(
    SliderIndicator.new(state).relative().w_full().h(4).rounded(2).bg(t.border)
      .range_style((fill) => fill.rounded(2).bg(t.accent))
      .child(SliderThumb.new(state).size(12).rounded(6).bg(t.accent).ml(-6))));
