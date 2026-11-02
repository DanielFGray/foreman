import { Option } from "effect"
import { type Pipeline, STANDARD_PIPELINE } from "foreman/pipeline"
import { expect, test } from "vitest"
import { applyEdit, type Drafting, summaryOf } from "./pipelineEdit.ts"

const from = (draft: Pipeline, selected = Option.none<string>()): Drafting => ({ draft, selected, placing: Option.none() })

test("an inserted block is picked and the palette's pick is dropped", () => {
  const wire = { from: "queue", port: "next" as const }
  const picked = applyEdit(from(STANDARD_PIPELINE), { _tag: "PickKind", kind: Option.some("gate") })
  expect(picked.placing).toEqual(Option.some("gate"))
  const inserted = applyEdit(picked, { _tag: "InsertOn", wire, kind: "gate" })
  expect(inserted.draft.nodes).toHaveLength(STANDARD_PIPELINE.nodes.length + 1)
  expect(Option.map(inserted.selected, (id) => id.startsWith("gate-"))).toEqual(Option.some(true))
  expect(inserted.placing).toEqual(Option.none())
})

test("removing the picked block drops the pick", () => {
  const removed = applyEdit(from(STANDARD_PIPELINE, Option.some("start")), { _tag: "Remove", id: "start" })
  expect(removed.draft.nodes.some((node) => node.id === "start")).toBe(false)
  expect(removed.selected).toEqual(Option.none())
})

test("a rejoin that would loop leaves the draft as it was", () => {
  const looped = applyEdit(from(STANDARD_PIPELINE), { _tag: "Rejoin", wire: { from: "land-gate", port: "next" }, to: "queue" })
  expect(looped.draft).toEqual(STANDARD_PIPELINE)
})

test("a card says what its block does in a few words", () => {
  expect(summaryOf({ kind: "source", id: "q", filter: "", next: "x" })).toBe("every task")
  expect(summaryOf({ kind: "agent", id: "a", role: "author", model: "ladder", slots: 2, next: "x" })).toBe("author · ladder ×2")
})
