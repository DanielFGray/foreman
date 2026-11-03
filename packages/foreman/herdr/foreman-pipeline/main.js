// The pipeline pane: one project's pipeline as foreman draws it, the tasks
// that stand at each block, and an editor for the project's draft.
//
// The drawing is foreman's (`foreman pipeline show <project> --json`, its
// `drawing`): boxes and wire routes in pixels, so this pane lays nothing out.
// It asks for a drawing that runs down when the pane is taller than it is
// wide, and across otherwise, and asks again when the pane's shape flips.
// A mod cannot load foreman's own modules (they need web globals the mod
// engine lacks), and a second copy of the layout here would drift from the
// one herdr-web draws. Where each task stands is the dispatcher's placement in
// state.json, with the task's runs so far; a task waiting at an ask is the
// dispatcher's attention row that offers `approve`, which a button here runs.
//
// Simulating (`simulate.js`) walks a pretend task through the draft with
// `foreman pipeline trace`, and marks where it stands and the blocks it passed.
// The fleet simulation (`fleet.js`) plays the project's real tasks through the
// draft and the pipeline it runs with `foreman pipeline simulate`, and puts the
// simulated tasks on the board in place of the dispatcher's. One of the two
// shows at a time.
//
// A Board / Pipeline switch picks the view. The Board view (`board.js`)
// shows the project's tasks in the dispatcher's board columns, and grants a
// Queue card dropped on Authoring. Both views drag through `drag.js`.
//
// The task graph (`tasks.js`) shows the project's open and claimed work in
// columns by what it waits for (`foreman pipeline graph`), and grants a card's
// task or epic the pipeline's steps when it is dropped on the board.
//
// Editing (`editor.js`) changes the project's draft, never the pipeline it
// runs: each change is one `foreman pipeline edit`, and `foreman pipeline
// save` checks the draft and makes it the pipeline. foreman owns the draft, so
// it outlives this pane.
//
// Open it beside the shell with
//   herdr-app do pane.split '{"direction":"right","mod":"foreman-pipeline","props":{"project":"<name>"}}'
// or from the Foreman panel's pipeline button.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, props, home } from "herdr";
import { Editor } from "./editor.js";
import { Simulator } from "./simulate.js";
import { Fleet } from "./fleet.js";
import { Tasks } from "./tasks.js";
import { Board } from "./board.js";
import { Drag } from "./drag.js";
import { chip, refusalOf, wiresLayer } from "./parts.js";

// The state.json version this pane reads; bumped with PUBLISHED_VERSION.
const VERSION = 5;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
// Fit never shrinks the drawing past this, so its words stay legible; a
// narrow pane scrolls across it instead.
const FIT_MIN = 0.75;

export default class Pipeline extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.project = p.project ?? null;
    this.state = p.state ?? `${home()}/.local/state/foreman/state.json`;
    this.command = p.command ?? ["foreman"];
    this.shown = null; this.problem = null; this.placements = []; this.asks = new Map(); this.busy = false;
    this.rows = []; this.landed = []; this.projects = [];
    this.zoom = 1; this.pan = [0, 0]; this.size = null; this.selected = null;
    // The drawing fits the pane until the operator zooms or pans it.
    this.fitted = true;
    this.editor = new Editor(this);
    this.sim = new Simulator(this);
    this.fleet = new Fleet(this);
    this.tasks = new Tasks(this);
    this.board = new Board(this);
    // The pane's one drag, which the Board view and the task graph both use.
    this.drag = new Drag();
    // The pane root's bounds in the window, from the last move over it.
    this.origin = null;
    // Which view the pane shows: the task board, or the pipeline drawing.
    this.mode = "board";
    this.loadPlacements(cx);
    this.watch(cx);
  }

  // Reads the drawing again when the pipelines or drafts file changes, and the
  // standings when the dispatcher publishes. Both live in folders herdr can
  // watch. The task graph is read again on both: grants live in the policy
  // file beside the pipelines, and a publish follows each change to the tasks.
  watch(cx) {
    const stateFolder = this.state.slice(0, this.state.lastIndexOf("/"));
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(stateFolder); } catch { return; }
        this.loadPlacements(cx);
        if (this.tasks.on) this.tasks.load(cx);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(`${home()}/.config/foreman`); } catch { return; }
        if (this.size !== null) this.loadDrawing(cx);
        if (this.tasks.on) this.tasks.load(cx);
      }
    });
  }

  loadDrawing(cx) {
    if (this.project === null) { this.problem = "open this pane with props {project}"; cx.notify(); return; }
    this.ask(["pipeline", "show", this.project, "--json", "--flow", this.flow()], cx);
  }

  // Sends one change to the draft. foreman answers the new reading, and the
  // block the change added, which the pane then selects.
  change(change, cx) {
    this.ask(["pipeline", "edit", this.project, JSON.stringify(change), "--json", "--flow", this.flow()], cx, (shown) => {
      if (shown.added !== null) this.select(shown.added);
    });
  }

  // Runs a foreman command that changes something, shows its refusal if it
  // refuses, and then calls `after` either way.
  act(args, cx, after) {
    this.busy = true; this.problem = null; cx.notify();
    cx.spawn(async (cx) => {
      const result = await this.foreman(args);
      this.busy = false;
      if (result.code !== 0) this.problem = refusalOf(result);
      after(result.code === 0, cx);
    });
  }

  // Runs `foreman approve <task>`. The dispatcher starts the step on its next
  // tick and publishes, and the watch reads the standings again then.
  approve(key, cx) { this.act(["approve", key], cx, (_done, cx) => cx.notify()); }

  // Runs `foreman pipeline save` or `discard`, then reads the pipeline again.
  finish(verb, cx) {
    this.act(["pipeline", verb, this.project], cx, (done, cx) => {
      if (done && verb === "save" && this.editor.on) this.editor.toggle();
      this.loadDrawing(cx);
    });
  }

  // The asks the board shows: none while it shows simulated tasks.
  shownAsks() { return this.fleet.on ? new Map() : this.asks; }

  // Runs a foreman command that answers a reading, and takes the reading.
  ask(args, cx, then = () => {}) {
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      const result = await this.foreman(args);
      this.busy = false;
      if (result.code !== 0) { this.problem = refusalOf(result); cx.notify(); return; }
      try {
        const shown = JSON.parse(result.stdout);
        this.problem = null;
        this.showing(shown, cx);
        then(shown);
      } catch (error) { this.problem = String(error.message ?? error); }
      cx.notify();
    });
  }

  foreman(args) {
    const [cmd, ...rest] = this.command;
    return exec(cmd, [...rest, ...args]);
  }

  // Takes a reading of the pipeline, and drops a pick that names a block it no longer has.
  showing(shown, cx) {
    this.shown = shown;
    if (this.selected !== null && !this.view().drawing.blocks.some((block) => block.id === this.selected)) this.select(null);
    if (this.fitted) this.fit(cx);
    // A change to the draft can change every step after it.
    if (this.sim.on) this.sim.run(cx);
    if (this.fleet.on) this.fleet.run(cx);
  }

  // What the board draws: the draft while one is open, else the pipeline the project runs.
  view() { return this.shown.draft ?? this.shown; }

  // The way the drawing should run in this pane: down a column, across a row.
  flow() { return this.size !== null && this.size.height > this.size.width ? "down" : "across"; }

  select(id) { this.selected = id; this.editor.load(this.selectedNode()); }

  selectedNode() {
    return this.selected === null ? undefined : this.view().pipeline.nodes.find((node) => node.id === this.selected);
  }

  loadPlacements(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(this.state);
      if (text === null) return;
      try {
        const published = JSON.parse(text);
        if (published.version !== VERSION) { this.problem = `state.json is version ${published.version}; this pane reads ${VERSION}`; cx.notify(); return; }
        this.placements = published.placements.filter((placement) => placement.project === this.project);
        this.asks = new Map(published.rows
          .filter((row) => row.project === this.project && row.actions.includes("approve"))
          .map((row) => [row.key, row]));
        this.rows = published.rows.filter((row) => row.project === this.project);
        this.landed = published.landed.filter((task) => task.project === this.project);
        this.projects = published.projects;
      } catch {}
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const root = v_flex().id("root").relative().size_full().bg(t.canvas).text_size(12).text_color(t.foreground)
      .on_mouse_down("left", () => this.drag.pressedAnywhere())
      .on_mouse_move((event, cx) => { this.origin = event.bounds; if (this.drag.moved(event.position)) cx.notify(); })
      .on_mouse_up("left", (event, cx) => {
        const target = this.drag.released();
        if (target?.run != null) target.run(cx);
        cx.notify();
      })
      .on_size_change((size, cx) => {
        const before = this.size === null ? null : this.flow();
        this.size = size;
        if (this.flow() !== before) this.loadDrawing(cx);
        else if (this.fitted) this.fit(cx);
        cx.notify();
      });
    if (this.mode === "board") return root.child(this.switchBar(t)).child(this.board.view(t));
    if (this.shown === null) return root.child(this.switchBar(t)).p(12).child(div().text_color(t.muted).child(this.problem ?? "reading the pipeline…"));
    const { drawing } = this.view();
    const draft = this.shown.draft;
    const at = byBlock(this.fleet.placements() ?? this.placements);
    const editing = this.editor.on;
    return root
      .child(this.header(t, at))
      .when(editing, (el) => el.child(this.editor.toolbar(t)))
      .when(this.sim.on, (el) => el.child(this.sim.toolbar(t)))
      .when(this.fleet.on, (el) => el.child(this.fleet.toolbar(t)))
      .when(draft !== null && draft.problems.length > 0, (el) => el.child(problemsView(t, draft.problems)))
      .child(h_flex().flex_1().min_h(0).items_start()
        .when(this.tasks.on, (el) => el.child(this.tasks.view(t)))
        .child(div().id("board").relative().flex_1().h_full().overflow_hidden()
          .when(this.tasks.dropping(), (el) => el.border(2).border_color(t.accent))
          .on_mouse_move((event, _cx) => this.tasks.overMoved(event))
          .on_scroll_wheel((event, cx) => this.scroll(event, cx))
          .child(div().absolute().left(this.pan[0]).top(this.pan[1]).w(drawing.width * this.zoom).h(drawing.height * this.zoom)
            .child(wiresLayer(drawing, this.zoom, t))
            .children(drawing.blocks.map((block) => this.blockView(block, at.get(block.id) ?? [], t)))
            .when(editing, (el) => el.children(drawing.wires.map((wire, index) => this.editor.plus(wire, index, t)))))))
      .when(this.selected !== null, (el) => el.child(this.detail(t, at)))
      .child(this.tasks.ghost(t) ?? div());
  }

  header(t, at) {
    const problems = this.shown.problems ?? [];
    const placed = [...at.values()].reduce((sum, tasks) => sum + tasks.length, 0);
    return h_flex().flex_wrap().px(10).py(6).gap_x(10).gap_y(4).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(this.modeChip(t))
      .child(div().font_semibold().child(this.project))
      .child(div().text_color(t.muted).child(this.shown.drawn ? "its own pipeline" : "the standard pipeline"))
      .child(div().text_color(t.muted).child(`${placed} task${placed === 1 ? "" : "s"} ${this.fleet.on ? "simulated" : "placed"}`))
      .when(problems.length > 0, (el) => el.child(div().text_color(t.blocked).child(`${problems.length} problem${problems.length === 1 ? "" : "s"}`)))
      .when(this.shown.draft !== null, (el) => el
        .child(div().text_color(t.accent).child("showing the draft"))
        .child(chip(t, "save", "save", (cx) => this.finish("save", cx)))
        .child(chip(t, "discard", "discard", (cx) => this.finish("discard", cx))))
      .child(chip(t, this.editor.on ? "stop editing" : "edit", "edit", (cx) => { this.editor.toggle(); cx.notify(); }))
      .child(chip(t, this.sim.on ? "stop simulating" : "simulate", "simulate", (cx) => { if (this.fleet.on) this.fleet.toggle(cx); this.sim.toggle(cx); }))
      .child(chip(t, this.fleet.on ? "stop the fleet" : "fleet", "fleet", (cx) => { if (this.sim.on) this.sim.toggle(cx); this.fleet.toggle(cx); }))
      .child(chip(t, this.tasks.on ? "hide tasks" : "tasks", "tasks", (cx) => { this.tasks.toggle(cx); if (this.fitted) this.fit(cx); }))
      .child(div().flex_1())
      .when(this.busy, (el) => el.child(div().text_color(t.muted).child("…")))
      .when(this.problem !== null, (el) => el.child(div().text_color(t.blocked).child(this.problem)))
      .child(chip(t, "−", "zoom-out", (cx) => this.zoomBy(1 / 1.2, cx)))
      .child(div().text_color(t.muted).child(`${Math.round(this.zoom * 100)}%`))
      .child(chip(t, "+", "zoom-in", (cx) => this.zoomBy(1.2, cx)))
      .child(chip(t, "fit", "zoom-fit", (cx) => this.fit(cx)));
  }

  // The bar over the Board view: the switch, the project, and the last refusal.
  switchBar(t) {
    return h_flex().px(10).py(6).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(this.modeChip(t))
      .child(div().font_semibold().child(this.project ?? "no project"))
      .child(div().flex_1())
      .when(this.busy, (el) => el.child(div().text_color(t.muted).child("…")))
      .when(this.problem !== null, (el) => el.child(div().text_color(t.blocked).truncate().child(this.problem)));
  }

  // The Board / Pipeline switch. The drawing is read when the pipeline first shows.
  modeChip(t) {
    return h_flex().gap(4)
      .children([["board", "Board"], ["pipeline", "Pipeline"]].map(([mode, label]) =>
        div().id(`mode-${mode}`).px(6).rounded(4).border(1)
          .border_color(this.mode === mode ? t.accent : t.border).text_color(this.mode === mode ? t.accent : t.foreground)
          .hover((s) => s.bg(t.hover))
          .on_click((_event, cx) => {
            if (this.mode === mode) return;
            this.mode = mode; this.drag.pressedAnywhere();
            if (mode === "pipeline" && this.shown === null) this.loadDrawing(cx);
            cx.notify();
          })
          .child(label)));
  }

  // The steps a grant from a board gives a task of this project.
  grantSteps() { return this.projects.find((one) => one.name === this.project)?.grantSteps ?? []; }

  // A window rectangle in pane coordinates, for what the pane draws over itself.
  local(rect) {
    const origin = this.origin ?? { x: 0, y: 0 };
    return { ...rect, x: rect.x - origin.x, y: rect.y - origin.y };
  }

  blockView(block, tasks, t) {
    const z = this.zoom;
    const running = tasks.filter((task) => task.state === "running").length;
    const asks = this.shownAsks();
    const asking = tasks.filter((task) => asks.has(task.key)).length;
    const card = block.h >= 40;
    const mark = this.sim.mark(block.id);
    const border = this.editor.rejoining !== null ? t.accent
      : mark === "here" ? t.working : mark === "passed" ? t.done
      : running > 0 ? t.working : tasks.length > 0 ? t.accent : t.border;
    return div().id(`block-${block.id}`).absolute()
      .left(block.x * z).top(block.y * z).w(block.w * z).h(block.h * z)
      .bg(this.selected === block.id ? t.selected : t.surface)
      .border(mark === "here" ? 2 : 1).border_color(border)
      .rounded(card ? 6 : 14).px(6 * z).overflow_hidden()
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => {
        if (this.editor.clickedBlock(block, cx)) return;
        this.select(this.selected === block.id ? null : block.id);
        cx.notify();
      })
      .child(v_flex().size_full().justify_center()
        .child(h_flex().gap(4 * z).text_size(12 * z)
          .child(div().text_color(t.muted).child(block.icon))
          .child(div().font_semibold().truncate().child(block.id))
          .when(mark === "here", (el) => el.child(div().text_color(t.working).child("◆")))
          .when(tasks.length > 0, (el) => el.child(div().text_color(running > 0 ? t.working : t.accent).child(String(tasks.length))))
          .when(asking > 0, (el) => el.child(div().text_color(t.blocked).child(`${asking} ask${asking === 1 ? "" : "s"}`))))
        .when(card, (el) => el.child(div().text_size(10 * z).text_color(t.muted).truncate().child(block.summary))));
  }

  // The selected block: its words, every task standing there, and, while
  // editing, its settings and the wires that leave it.
  detail(t, at) {
    const { drawing } = this.view();
    const block = drawing.blocks.find((one) => one.id === this.selected);
    const node = this.selectedNode();
    if (block === undefined || node === undefined) return div();
    const tasks = at.get(block.id) ?? [];
    return v_flex().id("detail").max_h(320).overflow_y_scrollbar().p(10).gap(4).bg(t.surface).border_t(1).border_color(t.border)
      .child(h_flex().flex_wrap().gap(6).child(div().font_semibold().child(`${block.icon} ${block.id}`)).child(div().text_color(t.muted).child(`${block.kind} · ${block.summary}`)))
      .when(this.editor.on, (el) => el.child(this.editor.settings(t, node)).child(this.editor.exits(t, drawing, node)))
      .when(tasks.length === 0, (el) => el.child(div().text_color(t.dim).child("no task stands here")))
      .children(tasks.slice(0, 50).map((task) => this.taskView(task, t)))
      .when(tasks.length > 50, (el) => el.child(div().text_color(t.dim).child(`and ${tasks.length - 50} more`)));
  }

  // One task at the selected block: its state, its ask and the button that
  // answers it, and the runs it took to get here.
  taskView(task, t) {
    const ask = this.shownAsks().get(task.key);
    return v_flex().gap(1)
      .child(h_flex().gap(8).items_center()
        .child(div().w(70).text_color(stateColor(task.state, t)).child(task.state))
        .child(div().w(80).text_color(t.muted).child(task.key))
        .child(div().flex_1().truncate().child(task.label))
        .when(task.gates.length > 0, (el) => el.child(div().text_color(t.dim).child(`at ${task.gates.map((gate) => gate.step).join(", ")}`)))
        .when(ask !== undefined, (el) => el.child(chip(t, "approve", `approve-${task.key}`, (cx) => this.approve(task.key, cx)))))
      .when(ask !== undefined, (el) => el.child(div().pl(78).text_color(t.blocked).child(ask.detail ?? ask.label)))
      .when(task.runs.length > 0, (el) => el.child(div().pl(78).text_color(t.dim).truncate().child(pathOf(task.runs))));
  }

  scroll(event, cx) {
    const [dx, dy] = event.delta ? [event.delta.x ?? 0, event.delta.y ?? 0] : [0, 0];
    if (event.modifiers?.control || event.modifiers?.platform) { this.zoomBy(dy > 0 ? 1.1 : 1 / 1.1, cx); return; }
    this.fitted = false;
    this.pan = [this.pan[0] + dx, this.pan[1] + dy];
    cx.notify();
  }

  zoomBy(factor, cx) {
    this.fitted = false;
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
    cx.notify();
  }

  // Fits the whole drawing into the pane, which a narrow pane and a zoomed tab both need.
  fit(cx) {
    if (this.size === null || this.shown === null) return;
    const { width, height } = this.view().drawing;
    const room = this.size.width - this.tasks.width();
    this.zoom = Math.min(1, Math.max(FIT_MIN, Math.min(room / width, (this.size.height - 40) / height)));
    this.pan = [0, 0];
    this.fitted = true;
    cx.notify();
  }
}

const problemsView = (t, problems) =>
  v_flex().id("problems").max_h(90).overflow_y_scrollbar().px(10).py(4).gap(2).bg(t.surface).border_b(1).border_color(t.border)
    .child(div().text_color(t.blocked).child("the draft cannot run yet:"))
    .children(problems.map((problem) => div().text_color(t.muted).child(problem)));

// Each block's tasks, by the block foreman says a board draws them on
// (`stands`): a task not yet started at its source, a waiting one at the gate
// in front of its block. Running first, then by key.
const byBlock = (placements) => {
  const at = new Map();
  for (const placement of placements) at.set(placement.stands, [...(at.get(placement.stands) ?? []), placement]);
  for (const tasks of at.values()) tasks.sort((a, b) => (a.state === "running") === (b.state === "running") ? a.key.localeCompare(b.key) : a.state === "running" ? -1 : 1);
  return at;
};

// A task's runs in a line, newest last: the block (or the role, for a run that
// names none), the rung, and how it ended.
const pathOf = (runs) => runs.slice(-8).map((run) =>
  `${run.node ?? run.role}${run.rung === null ? "" : ` on ${run.rung}`}: ${run.open ? "running" : run.ending ?? "not settled"}`)
  .join("  →  ")
  .replace(/^/, runs.length > 8 ? `${runs.length - 8} earlier  →  ` : "");

const stateColor = (state, t) => state === "running" ? t.working : state === "parked" ? t.blocked : state === "ended" || state === "landed" ? t.done : t.muted;
