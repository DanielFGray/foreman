// The Pipeline editor's drawing: the draft laid out by foreman's `beltOf` as a
// CSS grid of station cards, with a wire drawn from each block's exit to the
// block it runs to. Cell and gap sizes are fixed, so a wire's ends follow from
// the cell's column and row without measuring the page.
import { Array, Option, Result, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PipelineNode } from "foreman/pipeline"
import { type Belt, beltOf, type Cell, rejoin, type Wire } from "foreman/pipeline-belt"
import { FOREMAN_STEPS } from "../shared/Foreman.ts"
import { type ForemanPage, Message, type Model, PipelineView } from "./model.ts"
import { isDirty, type PipelineEdit, summaryOf, type WireRef } from "./pipelineEdit.ts"
import { problemsFor, RESET_LINE } from "./pipelinePage.ts"

type Editing = Extract<PipelineView, { _tag: "Editing" }>

const CELL_W = 150
const CELL_H = 64
const GAP_X = 72
const GAP_Y = 32
const PAD = 8
/** How far apart the exits of a block with several wires sit on its right edge. */
const EXIT_STEP = 22

/** The editor under the Foreman column's heading: a button to open it, or the open editor. */
export const pipelineSectionView = (model: Model, project: Option.Option<string>, h: HtmlBuilder<Message>): Html => {
  const page = model.foremanPage
  return PipelineView.match(page.pipeline, {
    Closed: () =>
      h.div(
        [h.Class("foreman-pipeline-open")],
        [
          h.button(
            [h.Type("button"), h.Class("chip"), h.Disabled(Option.isNone(project)), h.OnClick(Message.ClickedPipeline())],
            [Option.match(project, { onNone: () => "Pipeline", onSome: (name) => `Pipeline of ${name}` })],
          ),
        ],
      ),
    Loading: ({ project }) => frame(project, [h.p([h.Class("note")], ["Reading the pipeline…"])], h),
    Unlisted: ({ project, reason }) => frame(project, [h.p([h.Class("note error")], [reason])], h),
    Editing: (editing) => frame(editing.project, editorView(editing, page, h), h),
  })
}

const frame = (project: string, body: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("pipeline"), h.AriaLabel("Pipeline")],
    [
      h.div(
        [h.Class("pipeline-head")],
        [
          h.h3([], [`Pipeline of ${project}`]),
          h.button([h.Type("button"), h.Class("chip"), h.AriaLabel("close the pipeline"), h.OnClick(Message.ClosedPipeline())], ["Close"]),
        ],
      ),
      ...body,
    ],
  )

const editorView = (editing: Editing, page: ForemanPage, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const problems = problemsFor(page, editing)
  const belt = beltOf(editing.draft)
  return [
    h.p([h.Class("note")], [editing.drawn ? "This project runs its own pipeline." : "This project runs the standard pipeline."]),
    toolbarView(editing, page, problems, h),
    ...Option.match(editing.refusal, { onNone: () => [], onSome: (reason) => [h.p([h.Class("note error"), h.Role("alert")], [reason])] }),
    beltView(belt, editing, h),
    problemsView(problems, h),
    ...Option.match(editing.selected, {
      onNone: () => [],
      onSome: (id) => {
        const cell = belt.cells.find((one) => one.node.id === id)
        return cell === undefined ? [] : [inspectorView(cell.node, belt, editing, h)]
      },
    }),
  ]
}

const edit = (change: PipelineEdit): Message => Message.EditedPipeline({ edit: change })

const toolbarView = (editing: Editing, page: ForemanPage, problems: Option.Option<ReadonlyArray<string>>, h: HtmlBuilder<Message>): Html => {
  const canSave = !editing.saving && Option.exists(problems, (found) => found.length === 0)
  const isArmed = Option.contains(page.armed, RESET_LINE)
  return h.div(
    [h.Class("pipeline-toolbar")],
    [
      h.button([h.Type("button"), h.Class("chip"), h.OnClick(edit({ _tag: "AddSource", filter: "" }))], ["Add source"]),
      h.button([h.Type("button"), h.Class("chip on"), h.Disabled(!canSave), h.OnClick(Message.ClickedSavePipeline())], [editing.saving ? "Saving…" : "Save"]),
      h.button([h.Type("button"), h.Class("chip"), h.Disabled(editing.saving || !isDirty(editing.saved, editing.draft)), h.OnClick(Message.ClickedRevertPipeline())], ["Revert to saved"]),
      h.button(
        [h.Type("button"), h.Class(isArmed ? "chip armed" : "chip"), h.Disabled(editing.saving), h.OnClick(Message.ClickedResetPipeline())],
        [isArmed ? "Reset to the standard pipeline?" : "Reset to the standard pipeline"],
      ),
    ],
  )
}

const problemsView = (problems: Option.Option<ReadonlyArray<string>>, h: HtmlBuilder<Message>): Html =>
  Option.match(problems, {
    onNone: () => h.p([h.Class("note")], ["Reading the ladder…"]),
    onSome: (found) =>
      Array.isReadonlyArrayNonEmpty(found)
        ? h.ul([h.Class("pipeline-problems"), h.AriaLabel("Problems")], Array.map(found, (problem) => h.li([], [problem])))
        : h.p([h.Class("note")], ["The pipeline can run."]),
  })

// ── the drawing ──

const columnX = (column: number) => PAD + column * (CELL_W + GAP_X)
const rowY = (row: number) => PAD + row * (CELL_H + GAP_Y)

/** Where a wire leaves its block and where it enters the next. Blocks with several wires spread their exits. */
const endsOf = (belt: Belt, wire: Wire): { readonly out: readonly [number, number]; readonly into: readonly [number, number] } | undefined => {
  const from = belt.cells.find((cell) => cell.node.id === wire.from)
  const to = belt.cells.find((cell) => cell.node.id === wire.to)
  if (from === undefined || to === undefined) return undefined
  const siblings = belt.wires.filter((other) => other.from === wire.from)
  const at = siblings.findIndex((other) => other.port === wire.port)
  return {
    out: [columnX(from.column) + CELL_W, rowY(from.row) + CELL_H / 2 + (at - (siblings.length - 1) / 2) * EXIT_STEP],
    into: [columnX(to.column), rowY(to.row) + CELL_H / 2],
  }
}

const portName = (wire: Pick<Wire, "port">): string => (typeof wire.port === "number" ? `route ${wire.port + 1}` : wire.port)

const beltView = (belt: Belt, editing: Editing, h: HtmlBuilder<Message>): Html => {
  const width = PAD * 2 + belt.columns * CELL_W + Math.max(0, belt.columns - 1) * GAP_X
  const height = PAD * 2 + belt.rows * CELL_H + Math.max(0, belt.rows - 1) * GAP_Y
  const wires = Array.filterMap(belt.wires, (wire) => {
    const ends = endsOf(belt, wire)
    return ends === undefined ? Result.failVoid : Result.succeed({ wire, ...ends })
  })
  return h.div(
    [h.Class("pipeline-scroll")],
    [
      h.div(
        [h.Class("pipeline-belt"), h.Style({ width: `${width}px`, height: `${height}px` })],
        [
          h.svg(
            [h.Class("pipeline-wires"), h.AriaHidden(true), h.Attribute("width", String(width)), h.Attribute("height", String(height))],
            Array.map(wires, ({ out, into }) =>
              h.path([h.Class("pipeline-wire"), h.Attribute("d", curve(out, into)), h.Attribute("fill", "none")], []),
            ),
          ),
          h.div(
            [
              h.Class("pipeline-grid"),
              h.Style({
                "grid-template-columns": `repeat(${belt.columns}, ${CELL_W}px)`,
                "grid-template-rows": `repeat(${belt.rows}, ${CELL_H}px)`,
                "column-gap": `${GAP_X}px`,
                "row-gap": `${GAP_Y}px`,
                padding: `${PAD}px`,
              }),
            ],
            Array.map(belt.cells, (cell) => stationView(cell, editing, h)),
          ),
          ...Array.flatMap(wires, ({ wire, out }) => wireControlsView(wire, out, editing, h)),
        ],
      ),
    ],
  )
}

const curve = ([x0, y0]: readonly [number, number], [x1, y1]: readonly [number, number]): string => {
  const bend = Math.max(GAP_X / 2, (x1 - x0) / 2)
  return `M ${x0} ${y0} C ${x0 + bend} ${y0}, ${x1 - bend} ${y1}, ${x1} ${y1}`
}

const stationView = (cell: Cell, editing: Editing, h: HtmlBuilder<Message>): Html => {
  const { node } = cell
  const isSelected = Option.contains(editing.selected, node.id)
  return h.keyed("button")(
    node.id,
    [
      h.Type("button"),
      h.Class(`pipeline-station ${node.kind}${isSelected ? " selected" : ""}`),
      h.AriaLabel(`${node.kind} ${node.id}`),
      h.AriaPressed(isSelected ? "true" : "false"),
      h.Style({ "grid-column": String(cell.column + 1), "grid-row": String(cell.row + 1) }),
      h.Attribute("data-column", String(cell.column)),
      h.Attribute("data-row", String(cell.row)),
      h.OnClick(edit({ _tag: "Select", id: isSelected ? Option.none() : Option.some(node.id) })),
    ],
    [h.span([h.Class("pipeline-kind")], [node.kind]), h.span([h.Class("pipeline-summary")], [summaryOf(node)])],
  )
}

/** The "+" on a wire, the choice of block it opens, and the label of a router's route. */
const wireControlsView = (wire: Wire, [x, y]: readonly [number, number], editing: Editing, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const ref: WireRef = { from: wire.from, port: wire.port }
  const isOpen = Option.exists(editing.inserting, (open) => open.from === ref.from && open.port === ref.port)
  const at = { left: `${x + 4}px`, top: `${y - 11}px` }
  return [
    ...(wire.label === "" ? [] : [h.span([h.Class("pipeline-wire-label"), h.Title(wire.label), h.Style({ left: `${x + 2}px`, top: `${y - 24}px` })], [wire.label])]),
    h.button(
      [
        h.Type("button"),
        h.Class(isOpen ? "pipeline-add on" : "pipeline-add"),
        h.AriaLabel(`add a block after ${wire.from} on ${portName(wire)}`),
        h.AriaExpanded(isOpen),
        h.Style(at),
        h.OnClick(edit({ _tag: "PickWire", wire: isOpen ? Option.none() : Option.some(ref) })),
      ],
      ["+"],
    ),
    ...(isOpen
      ? [
          h.div(
            [h.Class("pipeline-insert"), h.Style({ left: `${x + 4}px`, top: `${y + 12}px` })],
            Array.map(["gate", "agent", "router"] as const, (kind) =>
              h.button([h.Type("button"), h.Class("chip"), h.AriaLabel(`put a ${kind} on the wire`), h.OnClick(edit({ _tag: "InsertOn", wire: ref, kind }))], [kind]),
            ),
          ),
        ]
      : []),
  ]
}

// ── the inspector ──

const inspectorView = (node: PipelineNode, belt: Belt, editing: Editing, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("pipeline-inspector"), h.AriaLabel(`Inspector of ${node.id}`)],
    [
      h.h4([], [`${node.kind} ${node.id}`]),
      ...settingsView(node, h),
      ...Array.map(
        belt.wires.filter((wire) => wire.from === node.id),
        (wire) => targetView(wire, editing, h),
      ),
      h.div(
        [h.Class("pipeline-actions")],
        node.kind === "land" || node.kind === "park"
          ? [h.button([h.Type("button"), h.Class("chip"), h.OnClick(edit({ _tag: "SwapEnd", id: node.id }))], [node.kind === "land" ? "Make it a park" : "Make it a land"])]
          : [h.button([h.Type("button"), h.Class("chip"), h.OnClick(edit({ _tag: "Remove", id: node.id }))], ["Remove block"])],
      ),
    ],
  )

const field = (label: string, control: Html, h: HtmlBuilder<Message>): Html => h.label([h.Class("pipeline-field")], [h.span([], [label]), control])

const textInput = (label: string, value: string, toMessage: (value: string) => Message, h: HtmlBuilder<Message>): Html =>
  h.input([h.Type("text"), h.Value(value), h.AriaLabel(label), h.Class("pipeline-input"), h.OnInput(toMessage)])

const selectInput = (label: string, options: ReadonlyArray<string>, value: string, toMessage: (value: string) => Message, h: HtmlBuilder<Message>): Html =>
  h.select(
    [h.AriaLabel(label), h.Class("pipeline-input"), h.OnChange(toMessage)],
    Array.map(options, (option) => h.option([h.Value(option), h.Selected(option === value)], [option])),
  )

/** The settings a block of this kind has, which `configure` changes. */
const settingsView = (node: PipelineNode, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  switch (node.kind) {
    case "source":
      return [field("Filter", textInput("filter", node.filter, (filter) => edit({ _tag: "Configure", id: node.id, setting: { filter } }), h), h)]
    case "gate":
      return [
        field(
          "Step",
          selectInput("step", FOREMAN_STEPS, node.step, (step) => edit({ _tag: "Configure", id: node.id, setting: { step: step as typeof node.step } }), h),
          h,
        ),
      ]
    case "agent": {
      const change = (setting: { readonly role?: typeof node.role; readonly model?: string; readonly slots?: number | undefined }) =>
        edit({ _tag: "Configure", id: node.id, setting: { role: node.role, model: node.model, slots: node.slots, ...setting } })
      return [
        field("Role", selectInput("role", ["author", "review"], node.role, (role) => change({ role: role as typeof node.role }), h), h),
        field("Model", textInput("model", node.model, (model) => change({ model }), h), h),
        field(
          "Slots",
          textInput("slots", node.slots === undefined ? "" : String(node.slots), (text) => change({ slots: slotsOf(text) }), h),
          h,
        ),
      ]
    }
    case "router":
      return [
        ...Array.flatMap(node.routes, (route, index) => [
          field(
            `Route ${index + 1} when`,
            textInput(`route ${index + 1} filter`, route.when, (when) => edit({ _tag: "Configure", id: node.id, setting: { route: index, when } }), h),
            h,
          ),
          h.button(
            [h.Type("button"), h.Class("chip"), h.AriaLabel(`remove route ${index + 1}`), h.OnClick(edit({ _tag: "RemoveRoute", router: node.id, index }))],
            ["Remove route"],
          ),
        ]),
        h.button([h.Type("button"), h.Class("chip"), h.OnClick(edit({ _tag: "AddRoute", router: node.id, when: "" }))], ["Add route"]),
      ]
    case "land":
    case "park":
      return []
  }
}

/** A slots field holds a whole number above zero, or nothing for no cap; anything else is no cap too. */
const slotsOf = (text: string): number | undefined => {
  const slots = Number(Str.trim(text))
  return Number.isInteger(slots) && slots > 0 ? slots : undefined
}

/** Where a wire goes, as a list of the blocks it may be rejoined to; `rejoin` refuses the ones that would loop. */
const targetView = (wire: Wire, editing: Editing, h: HtmlBuilder<Message>): Html => {
  const ref: WireRef = { from: wire.from, port: wire.port }
  const candidates = editing.draft.nodes.filter((node) => node.id === wire.to || Option.isSome(rejoin(editing.draft, ref, node.id)))
  return field(
    wire.label === "" ? "Runs on to" : `${wire.label} runs on to`,
    selectInput(`${portName(wire)} of ${wire.from} runs to`, Array.map(candidates, (node) => node.id), wire.to, (to) => edit({ _tag: "Rejoin", wire: ref, to }), h),
    h,
  )
}
