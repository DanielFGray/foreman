import { describe, expect, test } from "bun:test"
import type { Entry } from "../shared/Chat.ts"
import { foldEntries, type Item } from "./chat.ts"

const prompt = (id: string): Entry => ({ _tag: "Prompt", id, text: id })
const tool = (id: string, toolUseId: string): Entry => ({ _tag: "Tool", id, toolUseId, name: "Bash", summary: id })
const result = (toolUseId: string, isError: boolean): Entry => ({ _tag: "ToolResult", id: `r-${toolUseId}`, toolUseId, isError })
const reply = (id: string): Entry => ({ _tag: "Reply", id, blocks: [] })
const ended = (id: string): Entry => ({ _tag: "TurnEnded", id, durationMs: 1000 })

/** Each item as its tag and id; a Work item lists its steps. */
const outline = (items: ReadonlyArray<Item>) =>
  items.map((item) => (item._tag === "Work" ? item.steps.map((step) => `${step._tag}:${step.id}`) : `${item._tag}:${item.id}`))

describe("foldEntries", () => {
  test("folds a turn's work into one item and keeps its last reply as the answer", () => {
    const turn = [prompt("p"), tool("a", "t1"), result("t1", false), reply("r1"), tool("b", "t2"), reply("r2"), ended("e")]
    expect(outline(foldEntries(turn))).toEqual(["Prompt:p", ["Call:a", "Note:r1", "Call:b"], "Reply:r2", "TurnEnded:e"])
  })

  test("marks each call with its result, or running while it has none", () => {
    const [, work] = foldEntries([prompt("p"), tool("a", "t1"), result("t1", true), tool("b", "t2")])
    expect(work).toMatchObject({ steps: [{ outcome: "failed" }, { outcome: "running" }] })
  })

  test("a turn still working after its latest reply has no answer yet", () => {
    expect(outline(foldEntries([prompt("p"), reply("r1"), tool("a", "t1")]))).toEqual(["Prompt:p", ["Note:r1", "Call:a"]])
  })

  test("a compaction inside a turn stays where it happened", () => {
    const compacted: Entry = { _tag: "Compacted", id: "c" }
    expect(outline(foldEntries([prompt("p"), tool("a", "t1"), compacted, tool("b", "t2")]))).toEqual([
      "Prompt:p",
      ["Call:a"],
      "Compacted:c",
      ["Call:b"],
    ])
  })

  test("each prompt starts a turn; entries before the first prompt form one too", () => {
    expect(outline(foldEntries([tool("a", "t1"), reply("r0"), prompt("p"), reply("r1")]))).toEqual([
      ["Call:a"],
      "Reply:r0",
      "Prompt:p",
      "Reply:r1",
    ])
  })
})
