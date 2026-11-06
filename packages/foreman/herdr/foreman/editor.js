// The Pipeline view's editor: what a click on a "+", a block or an exit asks
// for next, and the settings of the selected block. It holds only what the
// operator is in the middle of; every change goes to the pane's `change`,
// which sends it to foreman, and the choices it offers are foreman's.
//
// The mod engine creates text inputs only in `init` or an event handler, never
// while drawing, so the editor makes one input per kind of text setting when
// the pane starts, fills them when a block is selected, and reads the selected
// block when Enter is pressed in one.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor as TextEditor } from "gpui-base";
import { chip, picker, portName } from "./parts.js";
import { FIELDS, changedSettings, instructionsOf, settingsOf } from "./editor-settings.js";
import {
  QUEUE,
  chargeChange,
  emptyChange,
  exitRows,
  instanceExitRows,
  returnChange,
} from "./editor-exits.js";

// The ends of a route, in the order `SwapEnd` turns one into the next.
const ENDS = ["land", "done", "park"];

export class Editor {
  // Runs in the pane's `init`, the one place besides a handler that may make inputs.
  constructor(pane) {
    this.pane = pane;
    this.on = false;
    // The wire a "+" was clicked on, the wire waiting for the block it should
    // lead to, whether a new source's filter is being typed, and the router
    // route whose filter the `when` input holds, and the exit whose name the
    // `exitName` input holds.
    this.inserting = null;
    this.rejoining = null;
    this.addingSource = false;
    this.route = null;
    this.exit = null;
    this.inputs = {};
    for (const [key, field] of Object.entries(FIELDS)) {
      const input = InputState.new({ placeholder: field.placeholder });
      input.on("submit", (_event, cx) => this.submit(key, input.value(), cx));
      this.inputs[key] = input;
    }
    // The text of the instructions the selected agent reads, named by
    // `instructions`, and the prompt foreman would send from that block, or
    // `promptProblem`, why it has none. `asked` counts the prompt reads, so
    // only the last one sent is shown.
    const text = { language: "markdown", line_numbers: false, folding: false, soft_wrap: true };
    this.text = EditorState.new(text);
    this.promptText = EditorState.new({ ...text, readonly: true });
    this.instructions = null;
    this.promptProblem = null;
    this.asked = 0;
  }

  // Drops what the editor waits for on the drawing it showed: a wire or exit
  // names block ids of that drawing, which mean another block, or none, on
  // the next one.
  abandon() {
    this.inserting = null;
    this.rejoining = null;
    this.addingSource = false;
  }

  // Turns editing on or off. Editing reads the selected agent's instructions
  // and its prompt; reading nothing while it is off spares a foreman run per click.
  toggle(cx) {
    this.on = !this.on;
    this.abandon();
    this.instructions = null;
    this.promptProblem = null;
    this.promptText.set_value("");
    if (this.on) this.read(this.pane.selectedNode(), cx);
  }

  // Fills the inputs from the block just selected.
  load(node, cx) {
    this.route = null;
    this.exit = null;
    for (const [key, value] of settingsOf(node)) this.inputs[key].set_value(value);
    this.instructions = null;
    this.promptProblem = null;
    this.promptText.set_value("");
    this.read(node, cx);
  }

  // Refills the inputs whose settings a reading changed under them. The
  // instructions text is read again only when the block reads other
  // instructions, so text the operator has not saved stays; the prompt is
  // read again after every reading, since any change can change it.
  follow(before, after, cx) {
    for (const [key, value] of changedSettings(before, after)) this.inputs[key].set_value(value);
    if (instructionsOf(after) !== (this.instructions ?? undefined)) this.read(after, cx);
    else this.preview(after, cx);
  }

  // Reads the text of the instructions `node` reads into its box, then its prompt.
  read(node, cx) {
    const name = instructionsOf(node);
    this.instructions = name ?? null;
    if (!this.on || name === undefined) return;
    cx.spawn(async (cx) => {
      const result = await this.pane.foreman(["pipeline", "instructions", name]);
      if (this.instructions !== name) return;
      // A name with no file yet starts empty; save writes it.
      this.text.set_value(result.code === 0 ? result.stdout.replace(/\n$/, "") : "");
      this.preview(node, cx);
      cx.notify();
    });
  }

  // Reads the prompt foreman would send from agent block `node` of the draft
  // the pane shows (the project's, or the open definition's).
  preview(node, cx) {
    if (!this.on || instructionsOf(node) === undefined) return;
    const args = this.pane.nav.promptArgs(node.id);
    if (args === null) return;
    const asked = ++this.asked;
    cx.spawn(async (cx) => {
      const result = await this.pane.foreman(args);
      if (asked !== this.asked) return;
      this.promptProblem = result.code === 0 ? null : (result.stderr || result.stdout).trim();
      this.promptText.set_value(result.code === 0 ? result.stdout : "");
      cx.notify();
    });
  }

  // Writes the box as the instructions the selected agent reads, which
  // the next dispatch of every block reading them sends.
  saveText(node, cx) {
    const name = instructionsOf(node);
    this.pane.act(["pipeline", "instructions", name, this.text.value()], cx, (done, cx) => {
      if (done) this.preview(node, cx);
      cx.notify();
    });
  }

  // Enter in a text setting: the change it makes to the selected block, or the new source.
  submit(key, value, cx) {
    const change = (one) => this.pane.change(one, cx);
    if (key === "newSource") {
      this.addingSource = false;
      this.inputs.newSource.set_value("");
      change({ _tag: "AddSource", filter: value });
      return;
    }
    if (key === "compositeName") {
      const ids = [...this.pane.selection];
      this.inputs.compositeName.set_value("");
      this.pane.selection = new Set();
      if (ids.length > 0 && value !== "") change({ _tag: "MakeComposite", ids, name: value });
      return;
    }
    const node = this.pane.selectedNode();
    if (node === undefined) return;
    const configure = (setting) =>
      change({ _tag: "Configure", id: node.id, setting: { kind: node.kind, ...setting } });
    // `configure` sets an agent's role, model and slots together.
    const agent = {
      role: node.role,
      model: node.model,
      ...(node.slots === undefined ? {} : { slots: node.slots }),
    };
    switch (key) {
      case "filter":
        return configure({ filter: value });
      case "command":
        return configure({ command: value });
      case "onto":
        return configure({
          how: node.how ?? "merge",
          onto: value.trim() === "" ? undefined : value.trim(),
        });
      case "model":
        return configure({ ...agent, model: value });
      case "slots": {
        const slots = Number.parseInt(value, 10);
        return configure({
          role: node.role,
          model: node.model,
          ...(Number.isInteger(slots) ? { slots } : {}),
        });
      }
      case "when":
        if (this.route !== null) configure({ route: this.route, when: value });
        return;
      case "newRoute":
        this.inputs.newRoute.set_value("");
        return change({ _tag: "AddRoute", router: node.id, when: value });
      case "exitName": {
        if (this.exit === null) return;
        const name = this.exit;
        this.exit = null;
        return change({ _tag: "RenameExit", id: node.id, name, to: value });
      }
      case "newExit":
        this.inputs.newExit.set_value("");
        return change({ _tag: "AddExit", id: node.id, name: value });
    }
  }

  // A click on a block while an exit waits for where it should lead. Answers
  // whether the editor took the click.
  clickedBlock(block, cx) {
    if (this.rejoining === null) return false;
    const { from, port } = this.rejoining;
    this.rejoining = null;
    this.pane.change({ _tag: "Rejoin", wire: { from, port }, to: block.id }, cx);
    return true;
  }

  // What editing asks for now: a kind for the wire a "+" was clicked on, the
  // block a rewired exit leads to, a MakeComposite name, or a new source's filter.
  toolbar(t) {
    const bar = h_flex()
      .flex_wrap()
      .px(10)
      .py(5)
      .gap_x(8)
      .gap_y(4)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border);
    if (this.inserting !== null) {
      const { from, port, to } = this.inserting;
      const { insertable = [], composites = [] } = this.pane.shown.choices;
      return bar
        .child(div().text_color(t.muted).child(`put on ${from} → ${to}:`))
        .children(
          insertable.map((kind) =>
            chip(t, kind, `insert-${kind}`, (cx) => {
              this.inserting = null;
              this.pane.change({ _tag: "InsertOn", wire: { from, port }, kind }, cx);
            }),
          ),
        )
        .children(
          composites.map((name) =>
            chip(t, name, `insert-composite-${name}`, (cx) => {
              this.inserting = null;
              this.pane.change(
                { _tag: "InsertOn", wire: { from, port }, kind: "composite", of: name },
                cx,
              );
            }),
          ),
        )
        .child(
          chip(t, "cancel", "insert-cancel", (cx) => {
            this.inserting = null;
            cx.notify();
          }),
        );
    }
    if (this.rejoining !== null) {
      const outs = this.pane.shown.choices?.outs ?? [];
      return bar
        .child(
          div()
            .text_color(t.muted)
            .child(
              `click the block ${this.rejoining.from}'s ${portName(this.rejoining)} should lead to`,
            ),
        )
        .children(
          outs.map((exit) =>
            chip(t, `out:${exit.name}`, `rejoin-out-${exit.id}`, (cx) => {
              const wire = this.rejoining;
              this.rejoining = null;
              this.pane.change(
                {
                  _tag: "Rejoin",
                  wire: { from: wire.from, port: wire.port },
                  to: `out:${exit.id}`,
                },
                cx,
              );
            }),
          ),
        )
        .child(
          chip(t, "cancel", "rejoin-cancel", (cx) => {
            this.rejoining = null;
            cx.notify();
          }),
        );
    }
    if (this.addingSource) {
      return bar.child(div().flex_1().child(this.field(t, "newSource"))).child(
        chip(t, "cancel", "source-cancel", (cx) => {
          this.addingSource = false;
          cx.notify();
        }),
      );
    }
    if (this.pane.selection.size > 0 && this.pane.definition === null) {
      return bar
        .child(
          div()
            .text_color(t.muted)
            .child(`make a composite of ${[...this.pane.selection].join(", ")}:`),
        )
        .child(div().flex_1().child(this.field(t, "compositeName")))
        .child(
          chip(t, "cancel", "composite-cancel", (cx) => {
            this.pane.selection = new Set();
            this.inputs.compositeName.set_value("");
            cx.notify();
          }),
        );
    }
    return bar
      .child(
        div()
          .text_color(t.muted)
          .child(
            this.pane.definition === null
              ? "click + on a wire to put a block there, shift-click blocks to make a composite, or a block to change it"
              : "click + on a wire to put a block there, or a block to change it",
          ),
      )
      .when(this.pane.definition === null, (el) =>
        el.child(
          chip(t, "+ source", "add-source", (cx) => {
            this.addingSource = true;
            this.inputs.newSource.focus();
            cx.notify();
          }),
        ),
      );
  }

  // The "+" that puts a block on a wire, where foreman's drawing places it.
  plus(wire, index, t) {
    const z = this.pane.zoom;
    const picked =
      this.inserting !== null &&
      this.inserting.from === wire.from &&
      this.inserting.port === wire.port;
    // 14px at 100%, the size foreman's layout leaves room for.
    return div()
      .id(`plus-${index}`)
      .absolute()
      .left((wire.plus[0] - 7) * z)
      .top((wire.plus[1] - 7) * z)
      .size(14 * z)
      .rounded(7 * z)
      .border(1)
      .border_color(t.accent)
      .bg(picked ? t.accent : t.surface)
      .text_size(10 * z)
      .text_color(picked ? t.canvas : t.accent)
      .flex()
      .items_center()
      .justify_center()
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => {
        this.inserting = picked ? null : wire;
        this.rejoining = null;
        cx.notify();
      })
      .child("+");
  }

  // What the selected block does, as `configure` and its neighbours change it.
  settings(t, node) {
    const change = (one, cx) => this.pane.change(one, cx);
    const configure = (setting, cx) =>
      change({ _tag: "Configure", id: node.id, setting: { kind: node.kind, ...setting } }, cx);
    const { choices } = this.pane.shown;
    const box = v_flex().gap(4).py(4);
    const next = ENDS[(ENDS.indexOf(node.kind) + 1) % ENDS.length];
    // An end goes only when no wire enters it, as foreman's `remove` allows.
    const end = ENDS.includes(node.kind);
    const entered = this.pane.view().drawing.wires.some((wire) => wire.to === node.id);
    const actions = h_flex()
      .flex_wrap()
      .gap(6)
      .when(end, (el) =>
        el.child(
          chip(t, `turn into a ${next}`, "swap-end", (cx) =>
            change({ _tag: "SwapEnd", id: node.id }, cx),
          ),
        ),
      )
      .when(!end || !entered, (el) =>
        el.child(
          chip(t, "remove block", "remove", (cx) => change({ _tag: "Remove", id: node.id }, cx)),
        ),
      );
    switch (node.kind) {
      case "source":
        return box.child(this.field(t, "filter")).child(actions);
      case "gate":
        return box
          .child(picker(t, "step", choices.steps, node.step, (step, cx) => configure({ step }, cx)))
          .child(actions);
      case "agent": {
        const slots = node.slots === undefined ? {} : { slots: node.slots };
        return box
          .child(
            picker(t, "role", choices.roles, node.role, (role, cx) =>
              configure({ role, model: node.model, ...slots }, cx),
            ),
          )
          .child(this.field(t, "model"))
          .child(this.field(t, "slots"))
          .child(actions);
      }
      case "router":
        return box
          .children(
            node.routes.map((route, index) =>
              h_flex()
                .gap(6)
                .items_center()
                .child(div().w(64).text_color(t.muted).child(`route ${index}`))
                .child(
                  div()
                    .id(`route-${index}`)
                    .flex_1()
                    .truncate()
                    .px(6)
                    .rounded(4)
                    .border(1)
                    .border_color(this.route === index ? t.accent : t.border)
                    .hover((s) => s.bg(t.hover))
                    .on_click((_event, cx) => {
                      this.route = index;
                      this.inputs.when.set_value(route.when);
                      this.inputs.when.focus();
                      cx.notify();
                    })
                    .child(route.when),
                )
                .child(
                  chip(t, "drop", `drop-route-${index}`, (cx) => {
                    this.route = null;
                    change({ _tag: "RemoveRoute", router: node.id, index }, cx);
                  }),
                ),
            ),
          )
          .when(this.route !== null, (el) => el.child(this.field(t, "when", `route ${this.route}`)))
          .child(this.field(t, "newRoute"))
          .child(actions);
      case "check":
        return box.child(this.field(t, "command")).child(actions);
      case "land":
        // `configure` sets a land's how and onto together; an empty onto clears it.
        return box
          .child(
            picker(t, "how", choices.landings, node.how ?? "merge", (how, cx) =>
              configure({ how, onto: node.onto }, cx),
            ),
          )
          .child(this.field(t, "onto"))
          .child(actions);
      case "composite":
        return box
          .child(div().text_color(t.muted).child(`of ${node.of}`))
          .child(
            h_flex()
              .flex_wrap()
              .gap(6)
              .child(
                chip(t, "open definition", "open-definition", (cx) =>
                  this.pane.openDefinition(node.of, cx),
                ),
              )
              .child(
                chip(t, "unpack", "unpack", (cx) => change({ _tag: "Unpack", id: node.id }, cx)),
              )
              .child(
                chip(t, "remove block", "remove", (cx) =>
                  change({ _tag: "Remove", id: node.id }, cx),
                ),
              ),
          )
          .children(
            Object.entries(node.set ?? {}).map(([name, value]) =>
              h_flex()
                .gap(6)
                .items_center()
                .child(div().w(64).text_color(t.muted).child(name))
                .child(div().flex_1().truncate().child(String(value))),
            ),
          );
      default:
        return box.child(actions);
    }
  }

  // The ways out of the selected block, each with a way to point it at another
  // block. An agent's or a check's exits are listed from the block itself, so a
  // return to the queue, which the drawing has no wire for, is listed too.
  exits(t, drawing, node) {
    if (node.kind === "agent" || node.kind === "check") return this.exitList(t, node);
    if (node.kind === "composite") return this.instanceExits(t, drawing, node);
    return v_flex()
      .gap(3)
      .pb(4)
      .children(
        drawing.wires
          .filter((wire) => wire.from === node.id)
          .map((wire, index) =>
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .text_color(t.muted)
                  .child(`${portName(wire)} → ${wire.to}`),
              )
              .child(
                chip(t, "lead elsewhere", `rejoin-${index}`, (cx) => {
                  this.rejoining = wire;
                  this.inserting = null;
                  cx.notify();
                }),
              ),
          ),
      );
  }

  // A composite instance's exits by the definition's names, each with a way to
  // lead it elsewhere or return it to the queue. Inserting an instance sends
  // every exit after the first to the queue, and the drawing has no wire there.
  instanceExits(t, drawing, node) {
    const block = drawing.blocks.find((one) => one.id === node.id);
    return v_flex()
      .gap(3)
      .pb(4)
      .children(
        instanceExitRows(block).map((row, index) =>
          h_flex()
            .id(`instance-exit-${index}`)
            .flex_wrap()
            .gap(6)
            .items_center()
            .child(
              div()
                .text_color(t.muted)
                .child(row.returns ? `${row.name} → back to the queue` : `${row.name} → ${row.to}`),
            )
            .child(
              chip(t, "lead elsewhere", `rejoin-${index}`, (cx) => {
                this.rejoining = { from: node.id, port: row.port, label: row.name };
                this.inserting = null;
                cx.notify();
              }),
            )
            .when(!row.returns, (el) =>
              el.child(
                chip(t, "return to the queue", `return-${index}`, (cx) =>
                  this.pane.change(returnChange(node, row.port), cx),
                ),
              ),
            ),
        ),
      );
  }

  // An agent's or a check's exits: where each leads, the rung it charges, what
  // an author's empty branch on it means, and the changes it takes. A check's
  // exits keep their names.
  exitList(t, node) {
    const change = (one, cx) => this.pane.change(one, cx);
    return v_flex()
      .gap(3)
      .pb(4)
      .children(
        exitRows(node).map((row, index) => {
          const port = { from: node.id, port: `exit:${row.name}`, label: row.name };
          // The row's id keeps each row's picker ids apart.
          return h_flex()
            .id(`exit-row-${index}`)
            .flex_wrap()
            .gap(6)
            .items_center()
            .child(
              div()
                .id(`exit-${index}`)
                .px(6)
                .rounded(4)
                .border(1)
                .border_color(this.exit === row.name ? t.accent : t.border)
                .when(!row.fixed, (el) =>
                  el
                    .hover((s) => s.bg(t.hover))
                    .on_click((_event, cx) => {
                      this.exit = row.name;
                      this.inputs.exitName.set_value(row.name);
                      this.inputs.exitName.focus();
                      cx.notify();
                    }),
                )
                .child(row.name),
            )
            .child(
              div()
                .text_color(t.muted)
                .child(row.returns ? "→ back to the queue" : `→ ${row.to}`),
            )
            .child(
              picker(t, "charges", row.charges, row.fails, (choice, cx) =>
                change(chargeChange(node, row.name, choice), cx),
              ),
            )
            .when(row.empties.length > 0, (el) =>
              el.child(
                picker(t, "empty branch", row.empties, row.empty, (choice, cx) =>
                  change(emptyChange(node, row.name, choice), cx),
                ),
              ),
            )
            .child(
              chip(t, "lead elsewhere", `rejoin-${index}`, (cx) => {
                this.rejoining = port;
                this.inserting = null;
                cx.notify();
              }),
            )
            .when(!row.returns, (el) =>
              el.child(
                chip(t, "return to the queue", `return-${index}`, (cx) =>
                  change(
                    { _tag: "Rejoin", wire: { from: node.id, port: port.port }, to: QUEUE },
                    cx,
                  ),
                ),
              ),
            )
            .when(!row.fixed, (el) =>
              el.child(
                chip(t, "remove exit", `remove-exit-${index}`, (cx) => {
                  if (this.exit === row.name) this.exit = null;
                  change({ _tag: "RemoveExit", id: node.id, name: row.name }, cx);
                }),
              ),
            );
        }),
      )
      .when(this.exit !== null, (el) => el.child(this.field(t, "exitName", `rename ${this.exit}`)))
      .when(node.kind === "agent", (el) => el.child(this.field(t, "newExit")));
  }

  // An agent's instructions, which "save text" writes, and the prompt foreman
  // would send from the block, read again after each change and each save.
  // Each scrolls in its own box, so it fills the height it is given. Nothing
  // for another kind of block.
  instructionsView(t, node) {
    const name = instructionsOf(node);
    if (name === undefined) return null;
    const box = (state) =>
      TextEditor.new(state)
        .flex_1()
        .min_h(0)
        .rounded(4)
        .border(1)
        .border_color(t.border)
        .bg(t.canvas);
    return v_flex()
      .size_full()
      .gap(4)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().text_color(t.muted).child(`instructions ${name}.md`))
          .child(chip(t, "save text", "save-text", (cx) => this.saveText(node, cx))),
      )
      .child(box(this.text))
      .child(
        div()
          .text_color(this.promptProblem === null ? t.muted : t.blocked)
          .child(this.promptProblem ?? "the prompt this block sends a pretend task"),
      )
      .child(box(this.promptText));
  }

  // A text setting, which changes the draft when Enter is pressed in it.
  field(t, key, label = FIELDS[key].label) {
    return h_flex()
      .gap(6)
      .items_center()
      .child(div().w(64).text_color(t.muted).child(label))
      .child(
        Input.new(this.inputs[key])
          .flex_1()
          .h(22)
          .px(6)
          .rounded(4)
          .border(1)
          .border_color(t.border)
          .bg(t.canvas)
          .text_size(12)
          .text_color(t.foreground),
      );
  }
}
