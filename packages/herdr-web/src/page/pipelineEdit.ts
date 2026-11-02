// The Pipeline editor's edits, as messages the page can carry, and the pure
// step that applies one to the draft. Every change to the pipeline itself is
// foreman's `pipeline-belt`; this module only picks which one an edit calls and
// keeps the editor's selection pointing at a block that still exists.
import { Option, Schema as S } from "effect"
import type { Pipeline, PipelineNode } from "foreman/pipeline"
import { addRoute, addSource, configure, INSERTABLE, insertOn, rejoin, remove, removeRoute, swapEnd } from "foreman/pipeline-belt"
import { FOREMAN_STEPS } from "../shared/Foreman.ts"

/** One way out of a block, as `pipeline-belt` names it: `next`, a router's `else`, or route `n`. */
export const WirePort = S.Union([S.Literals(["next", "else"]), S.Int])

export const WireRef = S.Struct({ from: S.String, port: WirePort })
export type WireRef = typeof WireRef.Type

/** What a block does, as `configure` takes it. */
export const BlockSetting = S.Union([
  S.Struct({ filter: S.String }),
  S.Struct({ step: S.Literals(FOREMAN_STEPS) }),
  S.Struct({ role: S.Literals(["author", "review"]), model: S.String, slots: S.UndefinedOr(S.Int) }),
  S.Struct({ route: S.Int, when: S.String }),
  S.Struct({ command: S.String }),
])

/** A change the operator makes to the draft, or to what the editor has picked. */
export const PipelineEdit = S.Union([
  S.TaggedStruct("Select", { id: S.Option(S.String) }),
  /** Opens or closes the choice of block to put on a wire. */
  S.TaggedStruct("PickWire", { wire: S.Option(WireRef) }),
  S.TaggedStruct("InsertOn", { wire: WireRef, kind: S.Literals(INSERTABLE) }),
  S.TaggedStruct("Remove", { id: S.String }),
  S.TaggedStruct("AddRoute", { router: S.String, when: S.String }),
  S.TaggedStruct("RemoveRoute", { router: S.String, index: S.Int }),
  S.TaggedStruct("Rejoin", { wire: WireRef, to: S.String }),
  S.TaggedStruct("AddSource", { filter: S.String }),
  S.TaggedStruct("SwapEnd", { id: S.String }),
  S.TaggedStruct("Configure", { id: S.String, setting: BlockSetting }),
])
export type PipelineEdit = typeof PipelineEdit.Type

/** What an edit changes: the draft, the block picked, and the wire a new block is being chosen for. */
export interface Drafting {
  readonly draft: Pipeline
  readonly selected: Option.Option<string>
  readonly inserting: Option.Option<WireRef>
}

export const applyEdit = (now: Drafting, edit: PipelineEdit): Drafting => {
  const { draft } = now
  switch (edit._tag) {
    case "Select":
      return { ...now, selected: edit.id }
    case "PickWire":
      return { ...now, inserting: edit.wire }
    case "InsertOn": {
      const inserted = insertOn(draft, edit.wire, edit.kind)
      return settled({ draft: inserted.pipeline, selected: inserted.id === "" ? now.selected : Option.some(inserted.id), inserting: Option.none() })
    }
    case "Remove":
      return settled({ ...now, draft: remove(draft, edit.id) })
    case "AddRoute":
      return settled({ ...now, draft: addRoute(draft, edit.router, edit.when) })
    case "RemoveRoute":
      return settled({ ...now, draft: removeRoute(draft, edit.router, edit.index) })
    case "Rejoin":
      return settled({ ...now, draft: Option.getOrElse(rejoin(draft, edit.wire, edit.to), () => draft) })
    case "AddSource": {
      const added = addSource(draft, edit.filter)
      return settled({ ...now, draft: added.pipeline, selected: added.id === "" ? now.selected : Option.some(added.id) })
    }
    case "SwapEnd":
      return settled({ ...now, draft: swapEnd(draft, edit.id) })
    case "Configure":
      return { ...now, draft: configure(draft, edit.id, edit.setting) }
  }
}

/** The picks that name a block or wire the draft no longer has are dropped. */
const settled = (now: Drafting): Drafting => ({
  draft: now.draft,
  selected: Option.filter(now.selected, (id) => now.draft.nodes.some((node) => node.id === id)),
  inserting: Option.filter(now.inserting, (wire) => now.draft.nodes.some((node) => node.id === wire.from)),
})

/** Whether the draft differs from what is saved. */
export const isDirty = (saved: Pipeline, draft: Pipeline): boolean => JSON.stringify(saved) !== JSON.stringify(draft)

/** A block's settings in a few words, for its card. */
export const summaryOf = (node: PipelineNode): string => {
  switch (node.kind) {
    case "source":
      return node.filter === "" ? "every task" : node.filter
    case "router":
      return node.routes.length === 1 ? "1 route" : `${node.routes.length} routes`
    case "gate":
      return `holds for ${node.step}`
    case "agent":
      return `${node.role} · ${node.model}${node.slots === undefined ? "" : ` ×${node.slots}`}`
    case "check":
      return node.command === "" ? "names no command" : `runs ${node.command}`
    case "land":
      return "merges"
    case "park":
      return "waits for you"
  }
}
