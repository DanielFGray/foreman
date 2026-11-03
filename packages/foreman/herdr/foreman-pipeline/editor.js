// The pipeline pane's editor: what a click on a "+", a block or an exit asks
// for next, and the settings of the selected block. It holds only what the
// operator is in the middle of; every change goes to the pane's `change`,
// which sends it to foreman, and the choices it offers are foreman's.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { chip, picker, portName } from "./parts.js";

// The ends of a route, in the order `SwapEnd` turns one into the next.
const ENDS = ["land", "done", "park"];

export class Editor {
  constructor(pane) {
    this.pane = pane;
    this.on = false;
    // The wire a "+" was clicked on, the wire waiting for the block it should
    // lead to, and whether a new source's filter is being typed.
    this.inserting = null; this.rejoining = null; this.addingSource = false;
    this.forget();
  }

  toggle() { this.on = !this.on; this.inserting = null; this.rejoining = null; this.addingSource = false; }

  // Drops the inputs of the block that was selected. Each setting keeps one
  // input while its block stays selected, so a reading arriving mid-typing
  // keeps what was typed.
  forget() { this.inputs = new Map(); this.submits = new Map(); }

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
  // block a rewired exit leads to, or a new source's filter.
  toolbar(t) {
    const bar = h_flex().flex_wrap().px(10).py(5).gap_x(8).gap_y(4).items_center().bg(t.surface).border_b(1).border_color(t.border);
    if (this.inserting !== null) {
      const { from, port, to } = this.inserting;
      return bar.child(div().text_color(t.muted).child(`put on ${from} → ${to}:`))
        .children(this.pane.shown.choices.insertable.map((kind) => chip(t, kind, `insert-${kind}`, (cx) => {
          this.inserting = null;
          this.pane.change({ _tag: "InsertOn", wire: { from, port }, kind }, cx);
        })))
        .child(chip(t, "cancel", "insert-cancel", (cx) => { this.inserting = null; cx.notify(); }));
    }
    if (this.rejoining !== null) {
      return bar.child(div().text_color(t.muted).child(`click the block ${this.rejoining.from}'s ${portName(this.rejoining)} should lead to`))
        .child(chip(t, "cancel", "rejoin-cancel", (cx) => { this.rejoining = null; cx.notify(); }));
    }
    if (this.addingSource) {
      return bar.child(this.field(t, { key: "new-source", label: "filter", value: "", placeholder: "a tasks filter; empty takes every task" }, (filter, cx) => {
        this.addingSource = false;
        this.pane.change({ _tag: "AddSource", filter }, cx);
      }))
        .child(chip(t, "cancel", "source-cancel", (cx) => { this.addingSource = false; cx.notify(); }));
    }
    return bar.child(div().text_color(t.muted).child("click + on a wire to put a block there, or a block to change it"))
      .child(chip(t, "+ source", "add-source", (cx) => { this.addingSource = true; cx.notify(); }));
  }

  // The "+" that puts a block on a wire, where foreman's drawing places it.
  plus(wire, index, t) {
    const z = this.pane.zoom;
    const picked = this.inserting !== null && this.inserting.from === wire.from && this.inserting.port === wire.port;
    // 14px at 100%, the size foreman's layout leaves room for.
    return div().id(`plus-${index}`).absolute().left((wire.plus[0] - 7) * z).top((wire.plus[1] - 7) * z).size(14 * z)
      .rounded(7 * z).border(1).border_color(t.accent).bg(picked ? t.accent : t.surface)
      .text_size(10 * z).text_color(picked ? t.canvas : t.accent).flex().items_center().justify_center()
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => { this.inserting = picked ? null : wire; this.rejoining = null; cx.notify(); })
      .child("+");
  }

  // What the selected block does, as `configure` and its neighbours change it.
  settings(t, node) {
    const change = (one, cx) => this.pane.change(one, cx);
    const configure = (setting, cx) => change({ _tag: "Configure", id: node.id, setting }, cx);
    const { choices } = this.pane.shown;
    const box = v_flex().gap(4).py(4);
    const next = ENDS[(ENDS.indexOf(node.kind) + 1) % ENDS.length];
    const actions = h_flex().flex_wrap().gap(6).child(ENDS.includes(node.kind)
      ? chip(t, `turn into a ${next}`, "swap-end", (cx) => change({ _tag: "SwapEnd", id: node.id }, cx))
      : chip(t, "remove block", "remove", (cx) => change({ _tag: "Remove", id: node.id }, cx)));
    switch (node.kind) {
      case "source":
        return box.child(this.field(t, { key: "filter", label: "filter", value: node.filter, placeholder: "empty takes every task" }, (filter, cx) => configure({ filter }, cx))).child(actions);
      case "gate":
        return box.child(picker(t, "step", choices.steps, node.step, (step, cx) => configure({ step }, cx))).child(actions);
      case "agent": {
        // `configure` sets an agent's role, model and slots together.
        const agent = { role: node.role, model: node.model, ...(node.slots === undefined ? {} : { slots: node.slots }) };
        return box
          .child(picker(t, "role", choices.roles, node.role, (role, cx) => configure({ ...agent, role }, cx)))
          .child(this.field(t, { key: "model", label: "model", value: node.model, placeholder: "ladder, above, or a rung's name" }, (model, cx) => configure({ ...agent, model }, cx)))
          .child(this.field(t, { key: "slots", label: "slots", value: node.slots ?? "", placeholder: "how many at once; empty is no limit" }, (text, cx) => {
            const slots = Number.parseInt(text, 10);
            configure({ role: node.role, model: node.model, ...(Number.isInteger(slots) ? { slots } : {}) }, cx);
          }))
          .child(actions);
      }
      case "router":
        return box
          .children(node.routes.map((route, index) => h_flex().gap(6).items_center()
            .child(div().flex_1().child(this.field(t, { key: `when-${index}`, label: `route ${index}`, value: route.when, placeholder: "a tasks filter" }, (when, cx) => configure({ route: index, when }, cx))))
            .child(chip(t, "drop", `drop-route-${index}`, (cx) => change({ _tag: "RemoveRoute", router: node.id, index }, cx)))))
          .child(this.field(t, { key: "new-route", label: "new route", value: "", placeholder: "a tasks filter, then Enter" }, (when, cx) => {
            this.inputs.get(`${this.pane.selected}:new-route`)?.set_value("");
            change({ _tag: "AddRoute", router: node.id, when }, cx);
          }))
          .child(actions);
      case "check":
        return box.child(this.field(t, { key: "command", label: "command", value: node.command, placeholder: "the command that must pass" }, (command, cx) => configure({ command }, cx))).child(actions);
      case "land":
        return box.child(picker(t, "how", choices.landings, node.how ?? "merge", (how, cx) => configure({ how }, cx))).child(actions);
      default:
        return box.child(actions);
    }
  }

  // The wires that leave the selected block, each with a way to point it at another block.
  exits(t, drawing, node) {
    return v_flex().gap(3).pb(4)
      .children(drawing.wires.filter((wire) => wire.from === node.id).map((wire, index) => h_flex().gap(6).items_center()
        .child(div().text_color(t.muted).child(`${portName(wire)} → ${wire.to}`))
        .child(chip(t, "lead elsewhere", `rejoin-${index}`, (cx) => { this.rejoining = wire; this.inserting = null; cx.notify(); }))));
  }

  // A text setting that changes the draft on Enter. The input outlives a
  // render, so its handler reads the latest `onSubmit` rather than the first.
  field(t, { key, label, value, placeholder }, onSubmit) {
    const id = `${this.pane.selected}:${key}`;
    this.submits.set(id, onSubmit);
    let input = this.inputs.get(id);
    if (input === undefined) {
      input = InputState.new({ value: String(value), placeholder });
      input.on("submit", (_event, cx) => this.submits.get(id)?.(input.value(), cx));
      this.inputs.set(id, input);
    }
    return h_flex().gap(6).items_center()
      .child(div().w(64).text_color(t.muted).child(label))
      .child(Input.new(input).flex_1().h(22).px(6).rounded(4).border(1).border_color(t.border).bg(t.canvas).text_size(12).text_color(t.foreground));
  }
}
