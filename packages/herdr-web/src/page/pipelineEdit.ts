// The Pipeline editor's edits, as messages the page can carry, and the pure
// step that applies one to the draft. Every change to the pipeline itself is
// foreman's `pipeline-edit`; this module adds what the editor has picked, and
// keeps that pick pointing at a block that still exists.
import { Option, Schema as S } from "effect"
import type { Pipeline } from "foreman/pipeline"
import { INSERTABLE, type Insertable } from "foreman/pipeline-belt"
import { applyChange, PipelineChange } from "foreman/pipeline-edit"

export { type WireRef } from "foreman/pipeline-edit"

/** A change the operator makes to the draft, or to what the editor has picked. */
export const PipelineEdit = S.Union([
  S.TaggedStruct("Select", { id: S.Option(S.String) }),
  /** Picks the kind of block that the next "+" on a belt puts there, or drops the pick. */
  S.TaggedStruct("PickKind", { kind: S.Option(S.Literals(INSERTABLE)) }),
  ...PipelineChange.members,
])
export type PipelineEdit = typeof PipelineEdit.Type

/** What an edit changes: the draft, the block picked, and the kind of block a "+" puts on a belt. */
export interface Drafting {
  readonly draft: Pipeline
  readonly selected: Option.Option<string>
  readonly placing: Option.Option<Insertable>
}

/** A refused change leaves the draft as it was; a change that adds a block picks it and drops the palette's pick. */
export const applyEdit = (now: Drafting, edit: PipelineEdit): Drafting => {
  switch (edit._tag) {
    case "Select":
      return { ...now, selected: edit.id }
    case "PickKind":
      return { ...now, placing: edit.kind }
    default: {
      const result = applyChange(now.draft, edit)
      if (result._tag === "Refused") return now
      return result.added === undefined
        ? settled({ ...now, draft: result.pipeline })
        : { draft: result.pipeline, selected: Option.some(result.added), placing: Option.none() }
    }
  }
}

/** A pick that names a block the draft no longer has is dropped. */
const settled = (now: Drafting): Drafting => ({
  ...now,
  selected: Option.filter(now.selected, (id) => now.draft.nodes.some((node) => node.id === id)),
})
