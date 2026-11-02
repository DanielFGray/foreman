// The panels that float over the pipeline drawing: the palette of blocks the
// operator puts on a belt, the ladder's rungs, and the unsaved changes that
// Save will write. Each closes and opens again, and the viewer's choice is kept
// in this browser (`closedPanels`). They take none of the drawing's width.
import { Array, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { INSERTABLE } from "foreman/pipeline-belt"
import { type ForemanPage, Message, PIPELINE_PANELS, type PipelinePanel, type PipelineView, RungList } from "./model.ts"
import { KIND_ICON } from "./pipelineEdit.ts"
import { edit } from "./pipelinePage.ts"

type Editing = Extract<PipelineView, { _tag: "Editing" }>

const TITLE: Record<PipelinePanel, string> = { blocks: "Blocks", ladder: "Ladder", changes: "Changes" }

/** The open panels over the drawing, in a fixed order. */
export const panelsView = (editing: Editing, page: ForemanPage, changes: ReadonlyArray<string>, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Array.flatMap(PIPELINE_PANELS, (panel) => {
    if (page.closedPanels.includes(panel)) return []
    switch (panel) {
      case "blocks":
        return [panelView(panel, blocksView(editing, h), h)]
      case "ladder":
        return [panelView(panel, ladderView(page.rungs, h), h)]
      case "changes":
        return [panelView(panel, changesView(changes, h), h)]
    }
  })

/** One switch per panel in the toolbar, pressed while the panel is open. */
export const panelTogglesView = (page: ForemanPage, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Array.map(PIPELINE_PANELS, (panel) => {
    const isOpen = !page.closedPanels.includes(panel)
    return h.button(
      [h.Type("button"), h.Class(isOpen ? "chip on" : "chip"), h.AriaPressed(isOpen ? "true" : "false"), h.OnClick(Message.ToggledPipelinePanel({ panel }))],
      [TITLE[panel]],
    )
  })

const panelView = (panel: PipelinePanel, body: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(`pipeline-panel pipeline-${panel}`), h.AriaLabel(TITLE[panel])],
    [
      h.div(
        [h.Class("pipeline-panel-head")],
        [
          h.h4([], [TITLE[panel]]),
          h.button([h.Type("button"), h.Class("pipeline-remove"), h.AriaLabel(`close the ${TITLE[panel]} panel`), h.OnClick(Message.ToggledPipelinePanel({ panel }))], ["✕"]),
        ],
      ),
      ...body,
    ],
  )

/**
 * The kinds of block the operator puts on a belt, from `INSERTABLE`, and a new
 * source. Picking a kind shows a "+" on every belt; a source needs no belt, so
 * it is added at once.
 */
const blocksView = (editing: Editing, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.div(
    [h.Class("pipeline-kinds")],
    [
      ...Array.map(INSERTABLE, (kind) => {
        const isPicked = Option.contains(editing.placing, kind)
        return h.button(
          [
            h.Type("button"),
            h.Class(isPicked ? "chip on" : "chip"),
            h.AriaPressed(isPicked ? "true" : "false"),
            h.OnClick(edit({ _tag: "PickKind", kind: isPicked ? Option.none() : Option.some(kind) })),
          ],
          [`${KIND_ICON[kind]} ${kind}`],
        )
      }),
      h.button([h.Type("button"), h.Class("chip"), h.OnClick(edit({ _tag: "AddSource", filter: "" }))], [`${KIND_ICON.source} Add source`]),
    ],
  ),
  h.p(
    [h.Class("note")],
    [Option.match(editing.placing, { onNone: () => "Pick a block, then a + on a belt.", onSome: (kind) => `Pick a + on a belt to put the ${kind} there.` })],
  ),
]

/** The rungs cheapest first, each with its state; a disabled rung is dimmed, since no task is dispatched to it. */
const ladderView = (rungs: RungList, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  RungList.match(rungs, {
    Loading: () => [h.p([h.Class("note")], ["Reading the ladder…"])],
    Unlisted: ({ reason }) => [h.p([h.Class("note error")], [reason])],
    Listed: ({ rungs }) => [
      h.ol(
        [h.Class("pipeline-rungs"), h.AriaLabel("Rungs")],
        Array.map(rungs, ({ rung, state }) =>
          h.li([h.Class(state === "disabled" ? "off" : "")], [h.span([h.Class("pipeline-rung")], [rung]), h.span([h.Class("note")], [state])]),
        ),
      ),
    ],
  })

const changesView = (changes: ReadonlyArray<string>, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Array.isReadonlyArrayNonEmpty(changes)
    ? [h.p([h.Class("note")], ["Save writes these changes:"]), h.ul([h.Class("pipeline-changes-list"), h.AriaLabel("Unsaved changes")], Array.map(changes, (line) => h.li([], [line])))]
    : [h.p([h.Class("note")], ["No changes since the last save."])]
