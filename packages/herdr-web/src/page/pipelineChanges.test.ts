import { Option, Schema as S } from "effect"
import { Pipeline, STANDARD_PIPELINE } from "foreman/pipeline"
import { describe, expect, it } from "vitest"
import { changesOf } from "./pipelineChanges.ts"
import { applyEdit, type Drafting, type PipelineEdit } from "./pipelineEdit.ts"

const edited = (pipeline: Pipeline, ...edits: ReadonlyArray<PipelineEdit>): Pipeline =>
  edits.reduce((now: Drafting, change) => applyEdit(now, change), { draft: pipeline, selected: Option.none(), placing: Option.none() }).draft

const inserted = (kind: "gate" | "agent" | "check" | "router") => {
  const draft = edited(STANDARD_PIPELINE, { _tag: "InsertOn", wire: { from: "author", port: "exit:done" }, kind })
  const id = draft.nodes.find((node) => !STANDARD_PIPELINE.nodes.some((old) => old.id === node.id))!.id
  return { draft, id }
}

describe("changesOf", () => {
  it("says nothing of a draft equal to the saved pipeline", () => {
    expect(changesOf(STANDARD_PIPELINE, STANDARD_PIPELINE)).toEqual([])
  })

  // A decoded agent holds `slots` before `next`; `configure` rebuilds it with `slots` last, so its JSON text changes while its settings do not.
  it("says nothing of a block rebuilt with the same settings", () => {
    const saved = S.decodeSync(Pipeline)({
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "author" },
        { kind: "agent", id: "author", role: "author", model: "ladder", slots: 2, exits: [{ name: "done", to: "land" }, { name: "already-done", to: "land" }] },
        { kind: "land", id: "land" },
      ],
    })
    const rebuilt = edited(saved, { _tag: "Configure", id: "author", setting: { kind: "agent", role: "author", model: "ladder", slots: 2 } })
    expect(JSON.stringify(rebuilt)).not.toEqual(JSON.stringify(saved))
    expect(changesOf(saved, rebuilt)).toEqual([])
  })

  it("tells an added block once, with where it stands, and not the wire it was put on", () => {
    const { draft, id } = inserted("check")
    const named = edited(draft, { _tag: "Configure", id, setting: { kind: "check", command: "bun test" } })
    expect(changesOf(STANDARD_PIPELINE, named)).toEqual([`added check ${id} (runs bun test) after author done`])
  })

  it("tells a removed block once, and not the wires that close the gap", () => {
    expect(changesOf(STANDARD_PIPELINE, edited(STANDARD_PIPELINE, { _tag: "Remove", id: "review-gate" }))).toEqual(["removed gate review-gate"])
  })

  it("tells a changed setting with its old and new value", () => {
    const draft = edited(STANDARD_PIPELINE, { _tag: "Configure", id: "author", setting: { kind: "agent", role: "author", model: "opus", slots: 2 } })
    expect(changesOf(STANDARD_PIPELINE, draft)).toEqual(["changed author's model from 'ladder' to 'opus'", "changed author's slots from no cap to '2'"])
  })

  it("tells a land made a done", () => {
    expect(changesOf(STANDARD_PIPELINE, edited(STANDARD_PIPELINE, { _tag: "SwapEnd", id: "land" }))).toEqual(["made land a done"])
  })

  it("tells a removed first route as one removal, not as every later route changed", () => {
    const draft = edited(STANDARD_PIPELINE, { _tag: "RemoveRoute", router: "retry", index: 0 })
    expect(changesOf(STANDARD_PIPELINE, draft)).toEqual(["removed route 1 ('failed') from retry"])
  })

  it("tells an added route and a changed route filter", () => {
    const draft = edited(STANDARD_PIPELINE, { _tag: "AddRoute", router: "retry", when: "size>=3" }, { _tag: "Configure", id: "retry", setting: { kind: "router", route: 1, when: "attempts>=2" } })
    expect(changesOf(STANDARD_PIPELINE, draft)).toEqual(["changed retry's route 2 filter from 'attempts>=1' to 'attempts>=2'", "added route 3 ('size>=3') to retry"])
  })

  it("tells a wire pointed at another block", () => {
    const { draft: saved, id } = inserted("gate")
    const rejoined = edited(saved, { _tag: "Rejoin", wire: { from: "climb", port: "next" }, to: id })
    expect(changesOf(saved, rejoined)).toEqual([`climb next now runs to ${id}`])
  })

  it("has a line for every edit that changes the draft", () => {
    const { draft: withGate, id } = inserted("gate")
    const edits: ReadonlyArray<readonly [Pipeline, PipelineEdit]> = [
      [STANDARD_PIPELINE, { _tag: "InsertOn", wire: { from: "queue", port: "next" }, kind: "agent" }],
      [STANDARD_PIPELINE, { _tag: "InsertOn", wire: { from: "retry", port: 0 }, kind: "router" }],
      [STANDARD_PIPELINE, { _tag: "Remove", id: "author" }],
      [STANDARD_PIPELINE, { _tag: "AddRoute", router: "retry", when: "" }],
      [STANDARD_PIPELINE, { _tag: "RemoveRoute", router: "retry", index: 1 }],
      [withGate, { _tag: "Rejoin", wire: { from: "climb", port: "next" }, to: id }],
      [STANDARD_PIPELINE, { _tag: "AddSource", filter: "label:bug" }],
      [STANDARD_PIPELINE, { _tag: "SwapEnd", id: "land" }],
      [STANDARD_PIPELINE, { _tag: "Configure", id: "queue", setting: { kind: "source", filter: "-label:question" } }],
      [STANDARD_PIPELINE, { _tag: "Configure", id: "start", setting: { kind: "gate", step: "review" } }],
    ]
    for (const [saved, change] of edits) {
      const draft = edited(saved, change)
      expect(draft, change._tag).not.toEqual(saved)
      expect(changesOf(saved, draft).length, change._tag).toBeGreaterThan(0)
    }
  })
})
