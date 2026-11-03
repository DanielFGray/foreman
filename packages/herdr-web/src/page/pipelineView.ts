// The Pipeline editor's drawing: the draft laid out by foreman's `beltOf` as a
// CSS grid of station cards, with a belt drawn from each block's exit to the
// block it runs to. pipelineLayout.ts sizes the columns and routes the wires, so
// the drawing needs no measuring of the page. The picked block's inspector and
// the panels of pipelinePanels.ts float over the drawing and take none of its width.
import { Array, Option, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { LANDINGS, type PipelineNode } from "foreman/pipeline"
import { type Belt, beltOf, type Cell, rejoin, type Wire } from "foreman/pipeline-belt"
import { besideOf, KIND_ICON, labelWidth, type Layout, layoutOf, PAD, type PlacedWire, type Point, portName, summaryOf } from "foreman/pipeline-layout"
import { FOREMAN_STEPS, type ForemanPlacement } from "../shared/Foreman.ts"
import { badgeView, standingOf, standingView, stoppedView } from "./pipelineStanding.ts"
import { type ForemanPage, Message, type Model, PipelineView } from "./model.ts"
import { changesOf } from "./pipelineChanges.ts"
import { type WireRef } from "./pipelineEdit.ts"
import { edit, problemsFor, RESET_LINE } from "./pipelinePage.ts"
import { panelsView, panelTogglesView } from "./pipelinePanels.ts"

type Editing = Extract<PipelineView, { _tag: "Editing" }>


/** The editor under the Foreman column's heading: a button to open it, or the open editor. */
export const pipelineSectionView = (model: Model, project: Option.Option<string>, h: HtmlBuilder<Message>): Html => {
  const page = model.foremanPage
  return PipelineView.match(page.pipeline, {
    Closed: () =>
      h.div(
        [h.Class("foreman-pipeline-open")],
        [
          ...Option.match(project, { onNone: () => [], onSome: (name) => stoppedView(name, standingOf(model, name).problems, h) }),
          h.button(
            [h.Type("button"), h.Class("chip"), h.Disabled(Option.isNone(project)), h.OnClick(Message.ClickedPipeline())],
            [Option.match(project, { onNone: () => "Pipeline", onSome: (name) => `Pipeline of ${name}` })],
          ),
        ],
      ),
    Loading: ({ project }) => frame(project, model, [h.p([h.Class("note")], ["Reading the pipeline…"])], h),
    Unlisted: ({ project, reason }) => frame(project, model, [h.p([h.Class("note error")], [reason])], h),
    Editing: (editing) => frame(editing.project, model, editorView(editing, page, standingOf(model, editing.project).tasks, h), h),
  })
}

/** The open page: the head, then why the project is stopped if it is, then the body. */
const frame = (project: string, model: Model, body: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
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
      ...stoppedView(project, standingOf(model, project).problems, h),
      ...body,
    ],
  )

const editorView = (editing: Editing, page: ForemanPage, tasks: ReadonlyArray<ForemanPlacement>, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const problems = problemsFor(page, editing)
  const changes = changesOf(editing.saved, editing.draft)
  const belt = beltOf(editing.draft)
  return [
    h.p([h.Class("note")], [editing.drawn ? "This project runs its own pipeline." : "This project runs the standard pipeline."]),
    toolbarView(editing, page, problems, changes, h),
    ...Option.match(editing.refusal, { onNone: () => [], onSome: (reason) => [h.p([h.Class("note error"), h.Role("alert")], [reason])] }),
    h.div(
      [h.Class("pipeline-board")],
      [beltView(belt, editing, tasks, h), ...panelsView(editing, page, changes, h)],
    ),
    ...standingView(belt, tasks, h),
    problemsView(problems, h),
  ]
}

const toolbarView = (editing: Editing, page: ForemanPage, problems: Option.Option<ReadonlyArray<string>>, changes: ReadonlyArray<string>, h: HtmlBuilder<Message>): Html => {
  const canSave = !editing.saving && Option.exists(problems, (found) => found.length === 0)
  const isArmed = Option.contains(page.armed, RESET_LINE)
  return h.div(
    [h.Class("pipeline-toolbar")],
    [
      h.button([h.Type("button"), h.Class("chip on"), h.Disabled(!canSave), h.OnClick(Message.ClickedSavePipeline())], [editing.saving ? "Saving…" : "Save"]),
      h.button([h.Type("button"), h.Class("chip"), h.Disabled(editing.saving || changes.length === 0), h.OnClick(Message.ClickedRevertPipeline())], ["Revert to saved"]),
      h.button(
        [h.Type("button"), h.Class(isArmed ? "chip armed" : "chip"), h.Disabled(editing.saving), h.OnClick(Message.ClickedResetPipeline())],
        [isArmed ? "Reset to the standard pipeline?" : "Reset to the standard pipeline"],
      ),
      ...panelTogglesView(page, h),
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

/** The inspector's width; it floats beside the picked block, so the drawing keeps its own width. */
const INSPECTOR_WIDTH = 300

const beltView = (belt: Belt, editing: Editing, tasks: ReadonlyArray<ForemanPlacement>, h: HtmlBuilder<Message>): Html => {
  const layout = layoutOf(belt, "across")
  return h.div(
    [h.Class("pipeline-scroll")],
    [
      h.div(
        [h.Class("pipeline-belt"), h.Style({ width: `${layout.width}px`, height: `${layout.height}px` })],
        [
          h.svg(
            [h.Class("pipeline-wires"), h.AriaHidden(true), h.Attribute("width", String(layout.width)), h.Attribute("height", String(layout.height))],
            Array.flatMap(layout.wires, ({ points }) => {
              const d = pathOf(points)
              return [
                h.path([h.Class("pipeline-track"), h.Attribute("d", d), h.Attribute("fill", "none")], []),
                h.path([h.Class("pipeline-flow"), h.Attribute("d", d), h.Attribute("fill", "none")], []),
              ]
            }),
          ),
          h.div(
            [
              h.Class("pipeline-grid"),
              h.Style({
                "grid-template-columns": layout.columnTracks.map((size) => `${size}px`).join(" "),
                "grid-template-rows": layout.rowTracks.map((size) => `${size}px`).join(" "),
                padding: `${PAD}px`,
              }),
            ],
            Array.map(belt.cells, (cell) => stationView(cell, layout, editing, tasks, h)),
          ),
          ...Array.flatMap(layout.wires, (placed) => wireControlsView(placed, editing, h)),
          ...Option.match(editing.selected, {
            onNone: () => [],
            onSome: (id) => {
              const cell = belt.cells.find((one) => one.node.id === id)
              const box = layout.boxes.get(id)
              return cell === undefined || box === undefined ? [] : [inspectorView(cell.node, belt, editing, besideOf(box, layout.width, INSPECTOR_WIDTH), h)]
            },
          }),
        ],
      ),
    ],
  )
}

/** A route as an SVG path through its corners, each corner rounded so a belt turns instead of kinking. */
const pathOf = (points: ReadonlyArray<Point>): string => {
  const RADIUS = 8
  return points
    .map(([x, y], index) => {
      const before = points[index - 1]
      const after = points[index + 1]
      if (before === undefined) return `M ${x} ${y}`
      if (after === undefined) return `L ${x} ${y}`
      const r = Math.min(RADIUS, Math.abs(x - before[0]) + Math.abs(y - before[1]), Math.abs(after[0] - x) + Math.abs(after[1] - y)) / 2
      const toward = (a: Point, b: Point): Point => {
        const length = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
        return [a[0] + ((b[0] - a[0]) * r) / length, a[1] + ((b[1] - a[1]) * r) / length]
      }
      const [x0, y0] = toward([x, y], before)
      const [x1, y1] = toward([x, y], after)
      return `L ${x0} ${y0} Q ${x} ${y} ${x1} ${y1}`
    })
    .join(" ")
}

/** A chip says its kind by an icon and one word; a card has the kind above its summary. */
const stationView = (cell: Cell, layout: Layout, editing: Editing, tasks: ReadonlyArray<ForemanPlacement>, h: HtmlBuilder<Message>): Html => {
  const { node } = cell
  const isSelected = Option.contains(editing.selected, node.id)
  const box = layout.boxes.get(node.id)
  const isChip = node.kind === "gate" || node.kind === "router"
  const text = node.kind === "gate" ? node.step : summaryOf(node)
  return h.keyed("button")(
    node.id,
    [
      h.Type("button"),
      h.Class(`pipeline-station ${node.kind}${isChip ? " chip-block" : ""}${isSelected ? " selected" : ""}`),
      h.AriaLabel(`${node.kind} ${node.id}`),
      h.AriaPressed(isSelected ? "true" : "false"),
      h.Title(summaryOf(node)),
      h.Style({
        "grid-column": String(cell.column * 2 + 1),
        "grid-row": String(cell.row * 2 + 1),
        width: `${box?.w ?? 0}px`,
        height: `${box?.h ?? 0}px`,
        "justify-self": "center",
        "align-self": "center",
      }),
      h.Attribute("data-column", String(cell.column)),
      h.Attribute("data-row", String(cell.row)),
      h.OnClick(edit({ _tag: "Select", id: isSelected ? Option.none() : Option.some(node.id) })),
    ],
    [
      ...(isChip
        ? [h.span([h.Class("pipeline-icon")], [KIND_ICON[node.kind]]), h.span([h.Class("pipeline-summary")], [text])]
        : [h.span([h.Class("pipeline-kind")], [`${KIND_ICON[node.kind]} ${node.kind}`]), h.span([h.Class("pipeline-summary")], [text])]),
      ...badgeView(node, tasks, h),
    ],
  )
}

/**
 * The label of a router's route at the middle of the wire's own stretch, and,
 * while a kind of block is picked in the palette, the "+" that puts one there.
 */
const wireControlsView = ({ wire, anchor: [x, y], room }: PlacedWire, editing: Editing, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const ref: WireRef = { from: wire.from, port: wire.port }
  const labelRoom = Math.max(24, Math.min(room - 4, labelWidth(wire.label)))
  return [
    ...(wire.label === ""
      ? []
      : [h.span([h.Class("pipeline-wire-label"), h.Title(wire.label), h.Style({ left: `${x - labelRoom / 2}px`, top: `${y - 23}px`, width: `${labelRoom}px` })], [wire.label])]),
    ...Option.match(editing.placing, {
      onNone: () => [],
      onSome: (kind) => [
        h.button(
          [
            h.Type("button"),
            h.Class("pipeline-add"),
            h.AriaLabel(`put the ${kind} after ${wire.from} on ${portName(wire)}`),
            h.Style({ left: `${x - 8}px`, top: `${y - 8}px` }),
            h.OnClick(edit({ _tag: "InsertOn", wire: ref, kind })),
          ],
          ["+"],
        ),
      ],
    }),
  ]
}

// ── the inspector ──

/** The picked block's settings, floating on the drawing at the point `besideOf` gives, beside the block. */
const inspectorView = (node: PipelineNode, belt: Belt, editing: Editing, [left, top]: Point, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("pipeline-inspector"), h.AriaLabel(`Inspector of ${node.id}`), h.Style({ left: `${left}px`, top: `${top}px`, width: `${INSPECTOR_WIDTH}px` })],
    [
      h.div(
        [h.Class("pipeline-panel-head")],
        [
          h.h4([], [`${node.kind} ${node.id}`]),
          h.button([h.Type("button"), h.Class("pipeline-remove"), h.AriaLabel("close the inspector"), h.OnClick(edit({ _tag: "Select", id: Option.none() }))], ["✕"]),
        ],
      ),
      ...settingsView(node, h),
      ...Array.map(
        belt.wires.filter((wire) => wire.from === node.id),
        (wire) => targetView(wire, editing, h),
      ),
      h.div(
        [h.Class("pipeline-actions")],
        node.kind === "land" || node.kind === "done" || node.kind === "park"
          ? [h.button([h.Type("button"), h.Class("chip"), h.OnClick(edit({ _tag: "SwapEnd", id: node.id }))], [NEXT_END[node.kind]])]
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
      return [field("Filter", textInput("filter", node.filter, (filter) => edit({ _tag: "Configure", id: node.id, setting: { kind: "source", filter } }), h), h)]
    case "gate":
      return [
        field(
          "Step",
          selectInput("step", FOREMAN_STEPS, node.step, (step) => edit({ _tag: "Configure", id: node.id, setting: { kind: "gate", step: step as typeof node.step } }), h),
          h,
        ),
      ]
    case "agent": {
      const change = (setting: { readonly role?: typeof node.role; readonly model?: string; readonly slots?: number | undefined }) =>
        edit({ _tag: "Configure", id: node.id, setting: { kind: "agent", role: node.role, model: node.model, slots: node.slots, ...setting } })
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
        ...Array.map(node.routes, (route, index) =>
          h.div(
            [h.Class("pipeline-route")],
            [
              h.span([h.Class("pipeline-route-name")], [`Route ${index + 1}`]),
              textInput(`route ${index + 1} filter`, route.when, (when) => edit({ _tag: "Configure", id: node.id, setting: { kind: "router", route: index, when } }), h),
              h.button(
                [h.Type("button"), h.Class("pipeline-remove"), h.Title("Remove this route"), h.AriaLabel(`remove route ${index + 1}`), h.OnClick(edit({ _tag: "RemoveRoute", router: node.id, index }))],
                ["✕"],
              ),
            ],
          ),
        ),
        h.button([h.Type("button"), h.Class("chip"), h.OnClick(edit({ _tag: "AddRoute", router: node.id, when: "" }))], ["Add route"]),
      ]
    case "check":
      return [field("Command", textInput("command", node.command, (command) => edit({ _tag: "Configure", id: node.id, setting: { kind: "check", command } }), h), h)]
    case "land":
      return [
        field(
          "How",
          selectInput("how", LANDINGS, node.how ?? "merge", (how) => edit({ _tag: "Configure", id: node.id, setting: { kind: "land", how: Option.getOrElse(Array.findFirst(LANDINGS, (landing) => landing === how), () => "merge" as const) } }), h),
          h,
        ),
      ]
    case "branch":
    case "worktree":
    case "done":
    case "park":
      return []
  }
}

/** What `swapEnd` turns each end into, as its button says. */
const NEXT_END = { land: "Make it a done", done: "Make it a park", park: "Make it a land" } as const

/** A slots field holds a whole number above zero, or nothing for no cap; anything else is no cap too. */
const slotsOf = (text: string): number | undefined => {
  const slots = Number(Str.trim(text))
  return Number.isInteger(slots) && slots > 0 ? slots : undefined
}

/** Targets that create no cycle among forward wires; existing return exits do not prevent a join. */
const targetView = (wire: Wire, editing: Editing, h: HtmlBuilder<Message>): Html => {
  const ref: WireRef = { from: wire.from, port: wire.port }
  const candidates = editing.draft.nodes.filter((node) => node.id === wire.to || Option.isSome(rejoin(editing.draft, ref, node.id)))
  return field(
    wire.label === "" ? "Runs on to" : `${wire.label} runs on to`,
    selectInput(`${portName(wire)} of ${wire.from} runs to`, Array.map(candidates, (node) => node.id), wire.to, (to) => edit({ _tag: "Rejoin", wire: ref, to }), h),
    h,
  )
}
