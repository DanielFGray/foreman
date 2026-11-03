// The pipeline pane: one project's pipeline as foreman draws it, with the tasks
// that stand at each block.
//
// The drawing is foreman's (`foreman pipeline show <project> --json`, its
// `drawing`): boxes and wire routes in pixels, so this pane lays nothing out.
// A mod cannot load foreman's own modules (they need web globals the mod
// engine lacks), and a second copy of the layout here would drift from the
// one herdr-web draws. Where each task stands is the dispatcher's placement in
// state.json. The pane writes nothing.
//
// Open it beside the shell with
//   herdr-app do pane.split '{"direction":"right","mod":"foreman-pipeline","props":{"project":"<name>"}}'
// or from the Foreman panel's pipeline button.
import { View, div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, props, home } from "herdr";

// The state.json version this pane reads; bumped with PUBLISHED_VERSION.
const VERSION = 5;
// A block lists this many of its tasks by name, then a count of the rest.
const TASKS_SHOWN = 4;
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
    this.shown = null; this.problem = null; this.placements = [];
    this.zoom = 1; this.pan = [0, 0]; this.size = null; this.selected = null;
    // The drawing fits the pane until the operator zooms or pans it.
    this.fitted = true;
    this.load(cx);
    this.watch(cx);
  }

  // Reads the drawing again when the pipelines file changes, and the
  // standings when the dispatcher publishes. Both live in folders herdr can watch.
  watch(cx) {
    const stateFolder = this.state.slice(0, this.state.lastIndexOf("/"));
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(stateFolder); } catch { return; }
        this.loadPlacements(cx);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(`${home()}/.config/foreman`); } catch { return; }
        this.loadDrawing(cx);
      }
    });
  }

  load(cx) { this.loadDrawing(cx); this.loadPlacements(cx); }

  loadDrawing(cx) {
    if (this.project === null) { this.problem = "open this pane with props {project}"; cx.notify(); return; }
    cx.spawn(async (cx) => {
      const [cmd, ...rest] = this.command;
      const result = await exec(cmd, [...rest, "pipeline", "show", this.project, "--json"]);
      if (result.code !== 0) { this.problem = result.stderr.trim() || `foreman pipeline show exited ${result.code}`; cx.notify(); return; }
      try { this.shown = JSON.parse(result.stdout); this.problem = null; if (this.fitted) this.fit(cx); }
      catch (error) { this.problem = String(error.message ?? error); }
      cx.notify();
    });
  }

  loadPlacements(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(this.state);
      if (text === null) return;
      try {
        const published = JSON.parse(text);
        if (published.version !== VERSION) { this.problem = `state.json is version ${published.version}; this pane reads ${VERSION}`; cx.notify(); return; }
        this.placements = published.placements.filter((placement) => placement.project === this.project);
      } catch {}
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const root = v_flex().id("root").size_full().bg(t.canvas).text_size(12).text_color(t.foreground)
      .on_size_change((size, cx) => { this.size = size; if (this.fitted) this.fit(cx); cx.notify(); });
    if (this.shown === null) return root.p(12).child(div().text_color(t.muted).child(this.problem ?? "reading the pipeline…"));
    const drawing = this.shown.drawing;
    const at = byBlock(this.placements);
    return root
      .child(this.header(t, at))
      .child(div().id("board").relative().flex_1().overflow_hidden()
        .on_scroll_wheel((event, cx) => this.scroll(event, cx))
        .child(div().absolute().left(this.pan[0]).top(this.pan[1]).w(drawing.width * this.zoom).h(drawing.height * this.zoom)
          .child(wiresLayer(drawing, this.zoom, t))
          .children(drawing.blocks.map((block) => this.blockView(block, at.get(block.id) ?? [], t)))))
      .when(this.selected !== null, (el) => el.child(this.detail(t, at)));
  }

  header(t, at) {
    const problems = this.shown.problems ?? [];
    const placed = [...at.values()].reduce((sum, tasks) => sum + tasks.length, 0);
    return h_flex().px(10).py(6).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().font_semibold().child(this.project))
      .child(div().text_color(t.muted).child(this.shown.drawn ? "its own pipeline" : "the standard pipeline"))
      .child(div().text_color(t.muted).child(`${placed} task${placed === 1 ? "" : "s"} placed`))
      .when(problems.length > 0, (el) => el.child(div().text_color(t.blocked).child(`${problems.length} problem${problems.length === 1 ? "" : "s"}`)))
      .child(div().flex_1())
      .when(this.problem !== null, (el) => el.child(div().text_color(t.blocked).truncate().child(this.problem)))
      .child(chip(t, "−", "zoom-out", (cx) => this.zoomBy(1 / 1.2, cx)))
      .child(div().text_color(t.muted).child(`${Math.round(this.zoom * 100)}%`))
      .child(chip(t, "+", "zoom-in", (cx) => this.zoomBy(1.2, cx)))
      .child(chip(t, "fit", "zoom-fit", (cx) => this.fit(cx)));
  }

  blockView(block, tasks, t) {
    const z = this.zoom;
    const running = tasks.filter((task) => task.state === "running").length;
    const card = block.h >= 40;
    return div().id(`block-${block.id}`).absolute()
      .left(block.x * z).top(block.y * z).w(block.w * z).h(block.h * z)
      .bg(this.selected === block.id ? t.selected : t.surface)
      .border(1).border_color(running > 0 ? t.working : tasks.length > 0 ? t.accent : t.border)
      .rounded(card ? 6 : 14).px(6 * z).overflow_hidden()
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => { this.selected = this.selected === block.id ? null : block.id; cx.notify(); })
      .child(v_flex().size_full().justify_center()
        .child(h_flex().gap(4 * z).text_size(12 * z)
          .child(div().text_color(t.muted).child(block.icon))
          .child(div().font_semibold().truncate().child(block.id))
          .when(tasks.length > 0, (el) => el.child(div().text_color(running > 0 ? t.working : t.accent).child(String(tasks.length)))))
        .when(card, (el) => el.child(div().text_size(10 * z).text_color(t.muted).truncate().child(block.summary))));
  }

  // The selected block: its words and every task standing there.
  detail(t, at) {
    const block = this.shown.drawing.blocks.find((one) => one.id === this.selected);
    if (block === undefined) return div();
    const tasks = at.get(block.id) ?? [];
    return v_flex().id("detail").max_h(220).overflow_y_scrollbar().p(10).gap(4).bg(t.surface).border_t(1).border_color(t.border)
      .child(h_flex().gap(6).child(div().font_semibold().child(`${block.icon} ${block.id}`)).child(div().text_color(t.muted).child(`${block.kind} · ${block.summary}`)))
      .when(tasks.length === 0, (el) => el.child(div().text_color(t.dim).child("no task stands here")))
      .children(tasks.slice(0, 50).map((task) => h_flex().gap(8)
        .child(div().w(70).text_color(stateColor(task.state, t)).child(task.state))
        .child(div().w(80).text_color(t.muted).child(task.key))
        .child(div().flex_1().truncate().child(task.label))
        .when(task.gates.length > 0, (el) => el.child(div().text_color(t.dim).child(`at ${task.gates.map((gate) => gate.step).join(", ")}`)))))
      .when(tasks.length > 50, (el) => el.child(div().text_color(t.dim).child(`and ${tasks.length - 50} more`)));
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
    const { width, height } = this.shown.drawing;
    this.zoom = Math.min(1, Math.max(FIT_MIN, Math.min(this.size.width / width, (this.size.height - 40) / height)));
    this.pan = [0, 0];
    this.fitted = true;
    cx.notify();
  }
}

// Each block's tasks, running first, then by key.
const byBlock = (placements) => {
  const at = new Map();
  for (const placement of placements) at.set(placement.node, [...(at.get(placement.node) ?? []), placement]);
  for (const tasks of at.values()) tasks.sort((a, b) => (a.state === "running") === (b.state === "running") ? a.key.localeCompare(b.key) : a.state === "running" ? -1 : 1);
  return at;
};

// Every wire as one stroked path over the whole drawing, with its label at its anchor.
const wiresLayer = (drawing, z, t) => {
  const layer = div().absolute().left(0).top(0).size_full();
  const paths = drawing.wires.map((wire) => {
    const [first, ...rest] = wire.points;
    let path = PathBuilder.stroke(1.5).move_to(first[0] * z, first[1] * z);
    for (const [x, y] of rest) path = path.line_to(x * z, y * z);
    return window.paint_path(path.build(), t.border).absolute().left(0).top(0).size_full();
  });
  const labels = drawing.wires.filter((wire) => wire.label !== "").map((wire) =>
    div().absolute().left(wire.anchor[0] * z - 40 * z).top(wire.anchor[1] * z - 14 * z).w(80 * z)
      .text_size(10 * z).text_color(t.muted).flex().justify_center().child(wire.label));
  return layer.children([...paths, ...labels]);
};

const chip = (t, label, id, onClick) =>
  div().id(id).px(6).rounded(4).border(1).border_color(t.border).hover((s) => s.bg(t.hover))
    .on_click((_event, cx) => onClick(cx)).child(label);

const stateColor = (state, t) => state === "running" ? t.working : state === "parked" ? t.blocked : state === "ended" ? t.done : t.muted;
