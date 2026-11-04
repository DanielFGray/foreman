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
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { chip, picker, portName } from "./parts.js";
import { FIELDS, changedSettings, settingsOf } from "./editor-settings.js";

// The ends of a route, in the order `SwapEnd` turns one into the next.
const ENDS = ["land", "done", "park"];


export class Editor {
  // Runs in the pane's `init`, the one place besides a handler that may make inputs.
  constructor(pane) {
    this.pane = pane;
    this.on = false;
    // The wire a "+" was clicked on, the wire waiting for the block it should
    // lead to, whether a new source's filter is being typed, and the router
    // route whose filter the `when` input holds.
    this.inserting = null; this.rejoining = null; this.addingSource = false; this.route = null;
    this.inputs = {};
    for (const [key, field] of Object.entries(FIELDS)) {
      const input = InputState.new({ placeholder: field.placeholder });
      input.on("submit", (_event, cx) => this.submit(key, input.value(), cx));
      this.inputs[key] = input;
    }
  }

  toggle() { this.on = !this.on; this.inserting = null; this.rejoining = null; this.addingSource = false; }

  // Fills the inputs from the block just selected.
  load(node) {
    this.route = null;
    for (const [key, value] of settingsOf(node)) this.inputs[key].set_value(value);
  }

  // Refills the inputs whose settings a reading changed under them.
  follow(before, after) {
    for (const [key, value] of changedSettings(before, after)) this.inputs[key].set_value(value);
  }

  // Enter in a text setting: the change it makes to the selected block, or the new source.
  submit(key, value, cx) {
    const change = (one) => this.pane.change(one, cx);
    if (key === "newSource") { this.addingSource = false; this.inputs.newSource.set_value(""); change({ _tag: "AddSource", filter: value }); return; }
    const node = this.pane.selectedNode();
    if (node === undefined) return;
    const configure = (setting) => change({ _tag: "Configure", id: node.id, setting: { kind: node.kind, ...setting } });
    // `configure` sets an agent's role, model and slots together.
    const agent = { role: node.role, model: node.model, ...(node.slots === undefined ? {} : { slots: node.slots }) };
    switch (key) {
      case "filter": return configure({ filter: value });
      case "command": return configure({ command: value });
      case "model": return configure({ ...agent, model: value });
      case "slots": {
        const slots = Number.parseInt(value, 10);
        return configure({ role: node.role, model: node.model, ...(Number.isInteger(slots) ? { slots } : {}) });
      }
      case "when": if (this.route !== null) configure({ route: this.route, when: value }); return;
      case "newRoute": this.inputs.newRoute.set_value(""); return change({ _tag: "AddRoute", router: node.id, when: value });
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
      return bar.child(div().flex_1().child(this.field(t, "newSource")))
        .child(chip(t, "cancel", "source-cancel", (cx) => { this.addingSource = false; cx.notify(); }));
    }
    return bar.child(div().text_color(t.muted).child("click + on a wire to put a block there, or a block to change it"))
      .child(chip(t, "+ source", "add-source", (cx) => { this.addingSource = true; this.inputs.newSource.focus(); cx.notify(); }));
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
    const configure = (setting, cx) => change({ _tag: "Configure", id: node.id, setting: { kind: node.kind, ...setting } }, cx);
    const { choices } = this.pane.shown;
    const box = v_flex().gap(4).py(4);
    const next = ENDS[(ENDS.indexOf(node.kind) + 1) % ENDS.length];
    // An end goes only when no wire enters it, as foreman's `remove` allows.
    const end = ENDS.includes(node.kind);
    const entered = this.pane.view().drawing.wires.some((wire) => wire.to === node.id);
    const actions = h_flex().flex_wrap().gap(6)
      .when(end, (el) => el.child(chip(t, `turn into a ${next}`, "swap-end", (cx) => change({ _tag: "SwapEnd", id: node.id }, cx))))
      .when(!end || !entered, (el) => el.child(chip(t, "remove block", "remove", (cx) => change({ _tag: "Remove", id: node.id }, cx))));
    switch (node.kind) {
      case "source":
        return box.child(this.field(t, "filter")).child(actions);
      case "gate":
        return box.child(picker(t, "step", choices.steps, node.step, (step, cx) => configure({ step }, cx))).child(actions);
      case "agent": {
        const slots = node.slots === undefined ? {} : { slots: node.slots };
        return box
          .child(picker(t, "role", choices.roles, node.role, (role, cx) => configure({ role, model: node.model, ...slots }, cx)))
          .child(this.field(t, "model"))
          .child(this.field(t, "slots"))
          .child(actions);
      }
      case "router":
        return box
          .children(node.routes.map((route, index) => h_flex().gap(6).items_center()
            .child(div().w(64).text_color(t.muted).child(`route ${index}`))
            .child(div().id(`route-${index}`).flex_1().truncate().px(6).rounded(4).border(1)
              .border_color(this.route === index ? t.accent : t.border).hover((s) => s.bg(t.hover))
              .on_click((_event, cx) => { this.route = index; this.inputs.when.set_value(route.when); this.inputs.when.focus(); cx.notify(); })
              .child(route.when))
            .child(chip(t, "drop", `drop-route-${index}`, (cx) => { this.route = null; change({ _tag: "RemoveRoute", router: node.id, index }, cx); }))))
          .when(this.route !== null, (el) => el.child(this.field(t, "when", `route ${this.route}`)))
          .child(this.field(t, "newRoute"))
          .child(actions);
      case "check":
        return box.child(this.field(t, "command")).child(actions);
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

  // A text setting, which changes the draft when Enter is pressed in it.
  field(t, key, label = FIELDS[key].label) {
    return h_flex().gap(6).items_center()
      .child(div().w(64).text_color(t.muted).child(label))
      .child(Input.new(this.inputs[key]).flex_1().h(22).px(6).rounded(4).border(1).border_color(t.border).bg(t.canvas).text_size(12).text_color(t.foreground));
  }
}
