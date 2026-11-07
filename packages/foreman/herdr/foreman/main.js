// The Foreman pane: the project of the shown herdr-app space, as the
// dispatcher last published it in state.json and as foreman draws, ranks and
// records it. Three views, picked in the header (`header.js`):
//
// - Pipeline: the project's pipeline as foreman draws it, the tasks that
//   stand at each block, each gate's mode for this project, and an editor for
//   the project's draft.
// - Tasks: in Board mode (`board.js`), the dispatcher's board columns, with a
//   detail strip for the selected card (`detail.js`); in Graph mode
//   (`tasks.js`), the task graph by what each task waits for.
// - Models (`models.js`): the ladder by level, the available rungs and models, the reviewers and the accounts.
//
// The project is the one foreman uses: the folder name of the main checkout
// the shown space's folder sits in, asked of git, so it holds while no
// dispatcher runs. The pane follows the space when the operator switches.
//
// The drawing is foreman's (`foreman pipeline show <project> --json`, its
// `drawing`): boxes and wire routes in pixels, so this pane lays nothing out.
// It asks for a drawing that runs down when the pane is taller than it is
// wide, and across otherwise, and asks again when the pane's shape flips.
// A mod cannot load foreman's own modules (they need web globals the mod
// engine lacks), and a second copy of the layout here would drift from
// `src/pipeline-layout.ts`. Where each task stands is the dispatcher's placement in
// state.json, with the task's runs so far; a task waiting at an ask is the
// dispatcher's attention row that offers `approve`, which a button here runs.
// A gate shows the mode its step has for this project, which state.json
// publishes (`projects[].steps`), and a click sets the next one with
// `foreman policy set <step> <mode> --project <project>`.
//
// Simulating (`simulate.js`) walks a pretend task through the draft with
// `foreman pipeline trace`, and marks where it stands and the blocks it passed.
// The fleet simulation (`fleet.js`) plays the project's real tasks through the
// draft and the pipeline it runs with `foreman pipeline simulate`, and puts the
// simulated tasks on the drawing in place of the dispatcher's. One of the two
// shows at a time.
//
// Editing (`editor.js`) changes the project's draft, never the pipeline it
// runs: each change is one `foreman pipeline edit`, and `foreman pipeline
// save` checks the draft and makes it the pipeline. A composite instance is
// one block on that drawing; opening it edits its definition through
// `foreman composite edit`. Shift-click while editing picks blocks for
// MakeComposite. foreman owns the drafts, so they outlive this pane.
//
// The pane reads the queue with `foreman queue --project <name> --json` every
// 5 seconds, not from state.json, for the Queue cards' actions and epics. A
// row that newly appears under Landed posts a notification. The pane's only
// own state is the Tasks view's mode, and it never runs `tasks`.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec,
  readTextFile,
  watchFolder,
  theme,
  props,
  home,
  spaces,
  notify,
  settings,
} from "herdr";
import { drawnAt } from "./units.js";
import { Editor } from "./editor.js";
import { Simulator } from "./simulate.js";
import { Fleet } from "./fleet.js";
import { Tasks } from "./tasks.js";
import { Board } from "./board.js";
import { Detail } from "./detail.js";
import { Header } from "./header.js";
import { Models } from "./models.js";
import { Drag } from "./drag.js";
import { chip, wiresLayer } from "./parts.js";
import { byBlock } from "./placements.js";
import { definitionRefusal } from "./definition.js";
import { entrySummary } from "./editor-exits.js";
import { Navigation, same } from "./navigation.js";
import {
  NEXT_MODE,
  TASK_ID,
  newlyLanded,
  projectOfCommonDir,
  refusalOf,
  rowsShownIn,
  touches,
} from "./status.js";

// The state.json version this pane reads; bumped with PUBLISHED_VERSION.
const VERSION = 7;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
// Fit never shrinks the drawing past this, so its words stay legible; a
// narrow pane scrolls across it instead.
const FIT_MIN = 0.75;
// The Tasks view's mode, kept in the mod's own storage.
const TASKS_MODE_KEY = "tasks-mode";
const PENDING = Symbol("pending");

export default class Foreman extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.state = p.state ?? `${home()}/.local/state/foreman/state.json`;
    this.command = p.command ?? ["foreman"];
    this.published = null;
    this.problem = null;
    this.busy = false;
    this.nav = new Navigation();
    this.queue = null;
    this.queueReading = false;
    // The Landed keys at the last reading, or null before the first.
    this.landedKeys = null;
    // Each space folder's project: a name, null for a folder in no checkout,
    // or PENDING while git is asked.
    this.checkouts = new Map();
    // The project the pane last read for, so a switch of space reads again.
    // Undefined before the first read, which a space in no project also needs.
    this.following = undefined;
    this.zoom = 1;
    this.pan = [0, 0];
    this.size = null;
    this.selected = null;
    // Blocks picked for MakeComposite (shift-click while editing).
    this.selection = new Set();
    // The drawing fits the pane until the operator zooms or pans it.
    this.fitted = true;
    this.header = new Header(this);
    this.editor = new Editor(this);
    this.sim = new Simulator(this);
    this.fleet = new Fleet(this);
    this.tasks = new Tasks(this);
    this.board = new Board(this);
    this.detail = new Detail(this);
    this.models = new Models(this);
    // The pane's one drag, which the Tasks board and the Models view use.
    this.drag = new Drag();
    // The pane root's bounds in the window, from the last move over it.
    this.origin = null;
    this.mode = "tasks";
    this.tasksMode = storedTasksMode();
    this.reload(cx);
    this.watching = { state: false, config: false };
    this.watch(cx);
    this.resolveCheckouts(cx);
    // Render runs on every change to herdr's live data and starts no work, so
    // the timer notices a switch of space. A watch that failed is tried again:
    // the state folder does not exist until a dispatcher first publishes.
    cx.timer.every(1000, (cx) => {
      this.resolveCheckouts(cx);
      this.follow(cx);
      cx.notify();
    });
    cx.timer.every(5000, (cx) => {
      this.watch(cx);
      this.loadQueue(cx);
    });
  }

  // What foreman last answered, and the definition it answered for (null for the pipeline).
  get shown() {
    return this.nav.shown;
  }

  get definition() {
    return this.nav.definition;
  }

  // The project of the shown space, or null for a space in no checkout.
  project() {
    const folder = spaces().find((space) => space.active)?.folder;
    const name = folder ? this.checkouts.get(folder) : null;
    return typeof name === "string" ? name : null;
  }

  // Asks git once for each space folder not yet resolved.
  resolveCheckouts(cx) {
    const unresolved = spaces().filter(
      (space) => space.folder && !this.checkouts.has(space.folder),
    );
    if (unresolved.length === 0) return;
    for (const space of unresolved) this.checkouts.set(space.folder, PENDING);
    cx.spawn(async (cx) => {
      for (const space of unresolved) {
        // on: a space on another machine runs git there.
        const result = await exec(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          { cwd: space.folder, on: space.machine },
        );
        this.checkouts.set(
          space.folder,
          result.code === 0 ? projectOfCommonDir(result.stdout.trim()) : null,
        );
      }
      this.follow(cx);
      cx.notify();
    });
  }

  // Drops what was read for the last project and reads for the shown one.
  follow(cx) {
    const project = this.project();
    if (project === this.following) return;
    this.following = project;
    this.nav.go(project === null ? null : { project });
    this.selection = new Set();
    this.selected = null;
    this.queue = null;
    this.problem = null;
    if (this.editor.on) this.editor.toggle(cx);
    if (this.sim.on) this.sim.toggle(cx);
    if (this.fleet.on) this.fleet.toggle(cx);
    this.tasks.clear();
    this.detail.clear();
    this.loadQueue(cx);
    this.loadView(cx);
  }

  // Reads what the shown view draws from foreman.
  loadView(cx) {
    if (this.mode === "pipeline" && this.shown === null) this.loadDrawing(cx);
    if (this.mode === "tasks" && this.tasksMode === "graph") this.tasks.load(cx);
    if (this.mode === "models") this.models.load(cx);
  }

  show(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.drag.pressedAnywhere();
    this.loadView(cx);
    cx.notify();
  }

  showTasks(tasksMode, cx) {
    this.tasksMode = tasksMode;
    try {
      localStorage.setItem(TASKS_MODE_KEY, tasksMode);
    } catch {}
    this.loadView(cx);
    cx.notify();
  }

  // Reads the drawing again when the pipelines, drafts or policy file
  // changes, and the published file when the dispatcher publishes. Both live
  // in folders herdr can watch. The task graph is read again on both: grants
  // live in the policy file, and a publish follows each change to the tasks.
  //
  // Each folder has one loop, and its flag says whether it runs, so the timer
  // restarts only the loop that failed. Every loop holds one host task while it
  // waits, and herdr fails every host call once a runtime holds 1024.
  watch(cx) {
    const stateFolder = this.state.slice(0, this.state.lastIndexOf("/"));
    if (!this.watching.state) {
      this.watching.state = true;
      cx.spawn(async (cx) => {
        try {
          for (;;) {
            if (!touches(await watchFolder(stateFolder), stateFolder, this.state)) continue;
            this.reload(cx);
            if (this.tasks.report !== null) this.tasks.load(cx);
          }
        } catch {
          this.watching.state = false;
          this.reload(cx);
        }
      });
    }
    if (!this.watching.config) {
      this.watching.config = true;
      cx.spawn(async (cx) => {
        try {
          for (;;) {
            await watchFolder(`${home()}/.config/foreman`);
            if (this.size !== null && this.shown !== null) this.loadDrawing(cx);
            if (this.tasks.report !== null) this.tasks.load(cx);
          }
        } catch {
          this.watching.config = false;
        }
      });
    }
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(this.state);
      if (text === null) {
        this.published = null;
        cx.notify();
        return;
      }
      try {
        const published = JSON.parse(text);
        if (published.version !== VERSION)
          throw new Error(`state.json is version ${published.version}; this pane reads ${VERSION}`);
        this.announce(published);
        this.published = published;
      } catch (error) {
        this.problem = String(error.message ?? error);
      }
      cx.notify();
    });
  }

  // Posts what the fleet landed since the last reading, in every project.
  announce(published) {
    const landed = published.rows.filter((row) => row.view === "landed");
    const fresh = new Set(
      newlyLanded(
        this.landedKeys,
        landed.map((row) => row.key),
      ),
    );
    for (const row of landed)
      if (fresh.has(row.key))
        notify({ title: `Landed ${row.key}`, body: row.label, level: "success", timeout: 8000 });
    this.landedKeys = new Set(landed.map((row) => row.key));
  }

  // Reads the project's queue, one read at a time.
  loadQueue(cx) {
    const project = this.project();
    if (project === null || this.queueReading) return;
    this.queueReading = true;
    cx.spawn(async (cx) => {
      const result = await this.foreman(["queue", "--project", project, "--json"]);
      this.queueReading = false;
      if (this.project() !== project) {
        this.loadQueue(cx);
        return;
      }
      try {
        this.queue = result.code === 0 ? JSON.parse(result.stdout) : null;
      } catch {
        this.queue = null;
      }
      cx.notify();
    });
  }

  // The shown project's placements, landed tasks and published rows. Each
  // reads the project once, outside its filter: `project()` asks herdr for
  // every space, and a render runs out of time when it asks once per entry.
  placements() {
    const project = this.project();
    return (this.published?.placements ?? []).filter((one) => one.project === project);
  }
  landed() {
    const project = this.project();
    return (this.published?.landed ?? []).filter((one) => one.project === project);
  }
  // A row in no project (an orphaned worker, a spent account, a branch whose
  // task is gone) shows in every project, so no space hides it.
  rows() { return rowsShownIn(this.published?.rows ?? [], this.project()); }
  // The epics being driven, by key: each one's title and how many of its tasks are done.
  epics() {
    return new Map((this.published?.epics ?? []).map((epic) => [epic.key, epic]));
  }

  // Each task's rows by task id: its published rows and its queue row. A
  // row's key may be a workspace label that holds the task id.
  rowsByTask() {
    const byTask = new Map();
    for (const row of [...this.rows(), ...(this.queue ?? [])]) {
      const id = row.view === "quota" ? undefined : row.key.match(TASK_ID)?.[0];
      if (id !== undefined) byTask.set(id, [...(byTask.get(id) ?? []), row]);
    }
    return byTask;
  }

  // The asks the drawing shows: none while it shows simulated tasks.
  shownAsks() {
    if (this.fleet.on) return new Map();
    return new Map(
      this.rows()
        .filter((row) => row.actions.includes("approve"))
        .map((row) => [row.key, row]),
    );
  }

  // The shown project as state.json publishes it.
  projectInfo() {
    const project = this.project();
    return this.published?.projects.find((one) => one.name === project);
  }

  // The steps a grant from a board gives a task of this project.
  grantSteps() {
    return this.projectInfo()?.grantSteps ?? [];
  }

  loadDrawing(cx) {
    const project = this.project();
    if (project === null) {
      this.problem = "this space is in no git checkout, so it has no project";
      cx.notify();
      return;
    }
    // One read at a time: a burst of changes to the config folder reads once
    // more after the read under way, not once per change. Each read is a
    // foreman process that takes a second of CPU.
    const sent = this.nav.request();
    if (sent === null) return;
    const args =
      sent.definition === undefined
        ? ["pipeline", "show", sent.project, "--json", "--flow", this.flow()]
        : ["composite", "show", sent.definition, "--json", "--flow", this.flow()];
    let answered = false;
    this.ask(
      args,
      cx,
      () => {
        answered = true;
      },
      (cx) => {
        if (this.nav.settle(sent, answered)) this.loadDrawing(cx);
      },
      sent,
    );
  }

  // Sends one change to the draft. foreman answers the new reading, and the
  // block the change added, which the pane then selects. A definition draft
  // goes through `foreman composite edit`.
  change(change, cx) {
    const of = this.nav.reading.target;
    const args =
      of.definition === undefined
        ? [
            "pipeline",
            "edit",
            of.project,
            JSON.stringify(change),
            "--json",
            "--flow",
            this.flow(),
          ]
        : [
            "composite",
            "edit",
            of.definition,
            JSON.stringify(change),
            "--json",
            "--flow",
            this.flow(),
          ];
    this.ask(
      args,
      cx,
      (shown, cx) => {
        if (shown.added !== null && shown.added !== undefined) this.select(shown.added, cx);
        this.selection = new Set();
      },
      undefined,
      of,
    );
  }

  // Opens a composite definition for editing through `foreman composite edit`.
  // The drawing shown stays until the definition reads, and a failed read
  // leaves the pane on the drawing it had (see loadDrawing).
  openDefinition(name, cx) {
    const refusal = definitionRefusal(name, this.shown?.choices);
    if (refusal !== null) {
      this.problem = refusal;
      cx.notify();
      return;
    }
    this.nav.go({ project: this.nav.target.project, definition: name });
    this.loadDrawing(cx);
  }

  // Leaves the definition and shows the project's pipeline again.
  closeDefinition(cx) {
    this.nav.go({ project: this.nav.target.project });
    this.loadDrawing(cx);
  }

  // Runs a foreman command that changes something, shows its refusal if it
  // refuses, and then calls `after` either way.
  act(args, cx, after) {
    this.busy = true;
    this.problem = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const result = await this.foreman(args);
      this.busy = false;
      if (result.code !== 0) this.problem = refusalOf(result);
      after(result.code === 0, cx);
    });
  }

  // Runs `foreman approve <task>`. The dispatcher starts the step on its next
  // tick and publishes, and the watch reads the file again then.
  approve(key, cx) {
    this.act(["approve", key], cx, (_done, cx) => cx.notify());
  }

  // Runs save or discard on the project's pipeline draft, or on the open
  // composite definition draft. A refusal changed nothing, so the draft stays
  // on screen with the refusal above it: a reading would clear the refusal it answers.
  finish(verb, cx) {
    const of = this.nav.reading.target;
    const args =
      of.definition === undefined
        ? ["pipeline", verb, of.project]
        : ["composite", verb, of.definition];
    this.act(args, cx, (done, cx) => {
      if (!done) {
        cx.notify();
        return;
      }
      if (verb === "save" && this.editor.on) this.editor.toggle(cx);
      this.loadDrawing(cx);
    });
  }

  // Runs a foreman command that answers a reading, and takes the reading.
  // `then` takes a reading; `after` runs once the command ends, however it
  // ended, a host call that failed included.
  ask(args, cx, then = () => {}, after = () => {}, of = this.nav.target) {
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.foreman(args);
        if (result.code !== 0) {
          this.problem = refusalOf(result);
          return;
        }
        try {
          const shown = JSON.parse(result.stdout);
          const before = this.nav.shown === null ? undefined : this.selectedNode();
          const from = this.nav.reading?.target;
          if (!this.nav.answer(of, shown)) return;
          this.problem = null;
          this.showing(shown, before, same(from ?? null, of), cx);
          then(shown, cx);
        } catch (error) {
          this.problem = String(error.message ?? error);
        }
      } finally {
        this.busy = false;
        cx.notify();
        after(cx);
      }
    });
  }

  foreman(args) {
    const [cmd, ...rest] = this.command;
    return exec(cmd, [...rest, ...args]);
  }

  // Takes a reading of the pipeline or a definition, and drops a pick that names a block the drawing lacks.
  // `sameTarget` is false when the reading is of another pipeline or
  // definition than the last: a pick or selection of the last one means nothing here.
  showing(shown, before, sameTarget, cx) {
    if (!sameTarget) {
      this.selection = new Set();
      this.editor.abandon();
    }
    if (
      this.selected !== null &&
      (!sameTarget || !this.view().drawing.blocks.some((block) => block.id === this.selected))
    )
      this.select(null, cx);
    else this.editor.follow(before, this.selectedNode(), cx);
    if (this.fitted) this.fit(cx);
    // A change to the draft can change every step after it.
    if (this.definition === null) {
      if (this.sim.on) this.sim.run(cx);
      if (this.fleet.on) this.fleet.run(cx);
    }
  }

  // What the drawing shows: a definition while one is open, else the draft
  // while one is open, else the pipeline the project runs.
  view() {
    if (this.definition !== null) return this.shown;
    return this.shown.draft ?? this.shown;
  }

  // The way the drawing should run in this pane: down a column, across a row.
  flow() {
    return this.size !== null && this.size.height > this.size.width ? "down" : "across";
  }

  select(id, cx) {
    this.selected = id;
    if (id === null) this.selection = new Set();
    this.editor.load(this.selectedNode(), cx);
  }

  // Shift-click while editing adds or drops a block in the MakeComposite selection.
  selectToggle(id, cx) {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.selected = id;
    this.editor.load(this.selectedNode(), cx);
  }

  selectedNode() {
    return this.selected === null
      ? undefined
      : this.view().pipeline.nodes.find((node) => node.id === this.selected);
  }

  render(cx) {
    const t = theme();
    // The frame herdr's Files and Changes panels draw, since this pane shares their stack.
    const root = v_flex()
      .id("root")
      .relative()
      .size_full()
      .rounded(10)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .text_size(12)
      .text_color(t.foreground)
      .on_mouse_down("left", () => this.drag.pressedAnywhere())
      .on_mouse_move((event, cx) => {
        this.origin = this.drawn(event.bounds);
        if (this.drag.moved(this.drawn(event.position))) cx.notify();
      })
      .on_mouse_up("left", (event, cx) => {
        const target = this.drag.released();
        if (target?.run != null) target.run(cx);
        cx.notify();
      })
      .on_size_change((size, cx) => {
        const before = this.size === null ? null : this.flow();
        this.size = this.drawn(size);
        if (this.mode === "pipeline" && this.flow() !== before) this.loadDrawing(cx);
        else if (this.fitted) this.fit(cx);
        cx.notify();
      })
      .child(this.header.view(t));
    if (this.mode === "tasks")
      return root
        .child(this.tasksSwitch(t))
        .child(this.tasksMode === "board" ? this.board.view(t) : this.tasks.view(t));
    if (this.mode === "models") return root.child(this.models.view(t));
    if (this.shown === null)
      return root.child(
        div()
          .p(12)
          .text_color(t.muted)
          .child(this.problem === null ? "reading the pipeline…" : ""),
      );
    const { drawing } = this.view();
    const draft = this.shown.draft;
    const at = byBlock(this.fleet.placements() ?? this.placements(), drawing.blocks);
    const editing = this.editor.on;
    const draftProblems = this.definition === null ? (draft?.problems ?? []) : [];
    return root
      .child(this.toolbar(t, at))
      .when(editing, (el) => el.child(this.editor.toolbar(t)))
      .when(this.definition === null && this.sim.on, (el) => el.child(this.sim.toolbar(t)))
      .when(this.definition === null && this.fleet.on, (el) => el.child(this.fleet.toolbar(t)))
      .when(draftProblems.length > 0, (el) => el.child(problemsView(t, draftProblems)))
      .when(this.problem !== null, (el) => el.child(problemsView(t, [this.problem])))
      .child(
        div()
          .id("drawing")
          .relative()
          .flex_1()
          .w_full()
          .min_h(0)
          .overflow_hidden()
          .on_scroll_wheel((event, cx) => this.scroll(event, cx))
          .child(
            div()
              .absolute()
              .left(this.pan[0])
              .top(this.pan[1])
              .w(drawing.width * this.zoom)
              .h(drawing.height * this.zoom)
              .child(wiresLayer(drawing, this.zoom, t))
              .children(
                drawing.blocks.map((block) => this.blockView(block, at.get(block.id) ?? [], t)),
              )
              .when(editing, (el) =>
                el.children(drawing.wires.map((wire, index) => this.editor.plus(wire, index, t))),
              ),
          ),
      )
      .when(this.selected !== null, (el) => el.child(this.blockDetail(t, at)));
  }

  // The Board / Graph switch inside the Tasks view.
  tasksSwitch(t) {
    return h_flex()
      .flex_none()
      .px(10)
      .py(4)
      .gap(4)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .children(
        [
          ["board", "Board"],
          ["graph", "Graph"],
        ].map(([mode, label]) =>
          div()
            .id(`tasks-${mode}`)
            .px(6)
            .rounded(4)
            .border(1)
            .border_color(this.tasksMode === mode ? t.accent : t.border)
            .text_color(this.tasksMode === mode ? t.accent : t.foreground)
            .hover((s) => s.bg(t.hover))
            .on_click((_event, cx) => {
              if (this.tasksMode !== mode) this.showTasks(mode, cx);
            })
            .child(label),
        ),
      );
  }

  // The bar over the drawing: which pipeline or definition it is, and its tools.
  toolbar(t, at) {
    const problems = this.shown.problems ?? [];
    const placed = [...at.values()].reduce((sum, tasks) => sum + tasks.length, 0);
    const draftOpen = this.shown.draft !== null;
    if (this.definition !== null) {
      return h_flex()
        .flex_wrap()
        .px(10)
        .py(6)
        .gap_x(10)
        .gap_y(4)
        .items_center()
        .bg(t.chrome)
        .border_b(1)
        .border_color(t.border)
        .child(div().text_color(t.accent).child(`definition ${this.definition}`))
        .child(chip(t, "back to pipeline", "close-definition", (cx) => this.closeDefinition(cx)))
        .when(draftOpen, (el) =>
          el
            .child(div().text_color(t.accent).child("showing the draft"))
            .child(chip(t, "save", "save", (cx) => this.finish("save", cx)))
            .child(chip(t, "discard", "discard", (cx) => this.finish("discard", cx))),
        )
        .child(
          chip(t, this.editor.on ? "stop editing" : "edit", "edit", (cx) => {
            this.editor.toggle(cx);
            cx.notify();
          }),
        )
        .child(div().flex_1())
        .child(chip(t, "−", "zoom-out", (cx) => this.zoomBy(1 / 1.2, cx)))
        .child(
          div()
            .text_color(t.muted)
            .child(`${Math.round(this.zoom * 100)}%`),
        )
        .child(chip(t, "+", "zoom-in", (cx) => this.zoomBy(1.2, cx)))
        .child(chip(t, "fit", "zoom-fit", (cx) => this.fit(cx)));
    }
    return h_flex()
      .flex_wrap()
      .px(10)
      .py(6)
      .gap_x(10)
      .gap_y(4)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(
        div()
          .text_color(t.muted)
          .child(this.shown.drawn ? "its own pipeline" : "the standard pipeline"),
      )
      .child(
        div()
          .text_color(t.muted)
          .child(
            `${placed} task${placed === 1 ? "" : "s"} ${this.fleet.on ? "simulated" : "placed"}`,
          ),
      )
      .when(problems.length > 0, (el) =>
        el.child(
          div()
            .text_color(t.blocked)
            .child(`${problems.length} problem${problems.length === 1 ? "" : "s"}`),
        ),
      )
      .when(draftOpen, (el) =>
        el
          .child(div().text_color(t.accent).child("showing the draft"))
          .child(chip(t, "save", "save", (cx) => this.finish("save", cx)))
          .child(chip(t, "discard", "discard", (cx) => this.finish("discard", cx))),
      )
      .child(
        chip(t, this.editor.on ? "stop editing" : "edit", "edit", (cx) => {
          this.editor.toggle(cx);
          cx.notify();
        }),
      )
      .child(
        chip(t, this.sim.on ? "stop simulating" : "simulate", "simulate", (cx) => {
          if (this.fleet.on) this.fleet.toggle(cx);
          this.sim.toggle(cx);
        }),
      )
      .child(
        chip(t, this.fleet.on ? "stop the fleet" : "fleet", "fleet", (cx) => {
          if (this.sim.on) this.sim.toggle(cx);
          this.fleet.toggle(cx);
        }),
      )
      .child(div().flex_1())
      .child(chip(t, "−", "zoom-out", (cx) => this.zoomBy(1 / 1.2, cx)))
      .child(
        div()
          .text_color(t.muted)
          .child(`${Math.round(this.zoom * 100)}%`),
      )
      .child(chip(t, "+", "zoom-in", (cx) => this.zoomBy(1.2, cx)))
      .child(chip(t, "fit", "zoom-fit", (cx) => this.fit(cx)));
  }

  // A point, size or bounds herdr-app reported, in the lengths the
  // pane draws (`units.js`).
  drawn(measured) {
    return drawnAt(measured, settings().zoom ?? 1);
  }

  // A window rectangle in pane coordinates, for what the pane draws over itself.
  local(rect) {
    const origin = this.origin ?? { x: 0, y: 0 };
    return { ...rect, x: rect.x - origin.x, y: rect.y - origin.y };
  }

  // A gate's mode chip: the mode its step has for this project, as state.json
  // publishes it. A click sets the next mode for this project only.
  gateMode(block, t) {
    const node = this.view().pipeline.nodes.find((one) => one.id === block.id);
    const mode = node?.kind === "gate" ? this.projectInfo()?.steps[node.step] : undefined;
    if (mode === undefined) return null;
    const tone = mode === "on" ? t.working : mode === "ask" ? t.blocked : t.muted;
    return div()
      .id(`gate-mode-${block.id}`)
      .flex_none()
      .px(4 * this.zoom)
      .rounded(4)
      .border(1)
      .border_color(tone)
      .text_color(tone)
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => {
        cx.stop_propagation();
        this.act(
          ["policy", "set", node.step, NEXT_MODE[mode], "--project", this.project()],
          cx,
          (_done, cx) => cx.notify(),
        );
      })
      .child(mode);
  }

  blockView(block, tasks, t) {
    const z = this.zoom;
    const running = tasks.filter((task) => task.state === "running").length;
    const asks = this.shownAsks();
    const asking = tasks.filter((task) => asks.has(task.key)).length;
    const card = block.h >= 40;
    const mark = this.definition === null ? this.sim.mark(block.id) : null;
    const gate = this.definition === null ? this.gateMode(block, t) : null;
    const picked = this.selection.has(block.id);
    const border =
      this.editor.rejoining !== null
        ? t.accent
        : picked
          ? t.accent
          : mark === "here"
            ? t.working
            : mark === "passed"
              ? t.done
              : running > 0
                ? t.working
                : tasks.length > 0
                  ? t.accent
                  : t.border;
    return div()
      .id(`block-${block.id}`)
      .absolute()
      .left(block.x * z)
      .top(block.y * z)
      .w(block.w * z)
      .h(block.h * z)
      .bg(this.selected === block.id || picked ? t.selected : t.surface)
      .border(mark === "here" || picked ? 2 : 1)
      .border_color(border)
      .rounded(card ? 6 : 14)
      .px(6 * z)
      .overflow_hidden()
      .hover((s) => s.bg(t.hover))
      .on_click((event, cx) => {
        if (this.editor.clickedBlock(block, cx)) return;
        if (this.editor.on && event.modifiers?.shift === true) {
          this.selectToggle(block.id, cx);
          cx.notify();
          return;
        }
        this.selection = new Set();
        this.select(this.selected === block.id ? null : block.id, cx);
        cx.notify();
      })
      .child(
        v_flex()
          .size_full()
          .justify_center()
          .child(
            h_flex()
              .gap(4 * z)
              .text_size(12 * z)
              .child(div().text_color(t.muted).child(block.icon))
              .child(div().font_semibold().truncate().child(block.id))
              .when(gate !== null, (el) => el.child(gate))
              .when(mark === "here", (el) => el.child(div().text_color(t.working).child("◆")))
              .when(tasks.length > 0, (el) =>
                el.child(
                  div()
                    .text_color(running > 0 ? t.working : t.accent)
                    .child(String(tasks.length)),
                ),
              )
              .when(asking > 0, (el) =>
                el.child(
                  div()
                    .text_color(t.blocked)
                    .child(`${asking} ask${asking === 1 ? "" : "s"}`),
                ),
              ),
          )
          .when(card, (el) =>
            el.child(
              div()
                .text_size(10 * z)
                .text_color(t.muted)
                .truncate()
                .child(entrySummary(block)),
            ),
          ),
      );
  }

  // The selected block: its words, every task standing there, and, while
  // editing, its settings and the wires that leave it.
  blockDetail(t, at) {
    const { drawing } = this.view();
    const block = drawing.blocks.find((one) => one.id === this.selected);
    const node = this.selectedNode();
    if (block === undefined || node === undefined) return div();
    const tasks = at.get(block.id) ?? [];
    const body = v_flex()
      .p(10)
      .gap(4)
      .child(
        h_flex()
          .flex_wrap()
          .gap(6)
          .child(div().font_semibold().child(`${block.icon} ${block.id}`))
          .child(div().text_color(t.muted).child(`${block.kind} · ${block.summary}`)),
      )
      .when(this.editor.on, (el) =>
        el.child(this.editor.settings(t, node)).child(this.editor.exits(t, drawing, node)),
      )
      .when(tasks.length === 0, (el) =>
        el.child(div().text_color(t.dim).child("no task stands here")),
      )
      .children(tasks.slice(0, 50).map((task) => this.taskView(task, t)))
      .when(tasks.length > 50, (el) =>
        el.child(
          div()
            .text_color(t.dim)
            .child(`and ${tasks.length - 50} more`),
        ),
      );
    const panel = (el) => el.bg(t.surface).border_t(1).border_color(t.border);
    const text = this.editor.on ? this.editor.instructionsView(t, node) : null;
    if (text === null)
      return panel(v_flex().id("detail").max_h(320).overflow_y_scrollbar().child(body));
    // An agent being edited: its instructions and prompt beside its settings, at a height they can fill.
    return panel(
      h_flex()
        .flex_none()
        .h(360)
        .child(v_flex().id("detail").flex_1().h_full().overflow_y_scrollbar().child(body))
        .child(div().flex_1().h_full().p(10).border_l(1).border_color(t.border).child(text)),
    );
  }

  // One task at the selected block: its state, its ask and the button that
  // answers it, and the runs it took to get here.
  taskView(task, t) {
    const ask = this.shownAsks().get(task.key);
    return v_flex()
      .gap(1)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().w(70).text_color(stateColor(task.state, t)).child(task.state))
          .child(div().w(80).text_color(t.muted).child(task.key))
          .child(div().flex_1().truncate().child(task.label))
          .when(task.gates.length > 0, (el) =>
            el.child(
              div()
                .text_color(t.dim)
                .child(`at ${task.gates.map((gate) => gate.step).join(", ")}`),
            ),
          )
          .when(ask !== undefined, (el) =>
            el.child(chip(t, "approve", `approve-${task.key}`, (cx) => this.approve(task.key, cx))),
          ),
      )
      .when(ask !== undefined, (el) =>
        el.child(
          div()
            .pl(78)
            .text_color(t.blocked)
            .child(ask.detail ?? ask.label),
        ),
      )
      .when(task.runs.length > 0, (el) =>
        el.child(div().pl(78).text_color(t.dim).truncate().child(pathOf(task.runs))),
      );
  }

  scroll(event, cx) {
    const delta = this.drawn(event.delta);
    const [dx, dy] = delta ? [delta.x ?? 0, delta.y ?? 0] : [0, 0];
    if (event.modifiers?.control || event.modifiers?.platform) {
      this.zoomBy(dy > 0 ? 1.1 : 1 / 1.1, cx);
      return;
    }
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
    this.zoom = Math.min(
      1,
      Math.max(FIT_MIN, Math.min(this.size.width / width, (this.size.height - 80) / height)),
    );
    this.pan = [0, 0];
    this.fitted = true;
    cx.notify();
  }
}

const storedTasksMode = () => {
  try {
    return localStorage.getItem(TASKS_MODE_KEY) === "graph" ? "graph" : "board";
  } catch {
    return "board";
  }
};

const problemsView = (t, problems) =>
  v_flex()
    .id("problems")
    .max_h(90)
    .overflow_y_scrollbar()
    .px(10)
    .py(4)
    .gap(2)
    .bg(t.surface)
    .border_b(1)
    .border_color(t.border)
    .child(div().text_color(t.blocked).child("the draft cannot run yet:"))
    .children(problems.map((problem) => div().text_color(t.muted).child(problem)));

// A task's runs in a line, newest last: the block (or the role, for a run that
// names none), the rung, and how it ended.
const pathOf = (runs) =>
  runs
    .slice(-8)
    .map(
      (run) =>
        `${run.node ?? run.role}${run.rung === null ? "" : ` on ${run.rung}`}: ${run.open ? "running" : (run.ending ?? "not settled")}`,
    )
    .join("  →  ")
    .replace(/^/, runs.length > 8 ? `${runs.length - 8} earlier  →  ` : "");

const stateColor = (state, t) =>
  state === "running"
    ? t.working
    : state === "parked" || state === "gone"
      ? t.blocked
      : state === "ended" || state === "landed"
        ? t.done
        : t.muted;
