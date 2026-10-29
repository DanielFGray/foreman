import { describe, expect, test } from "bun:test"
import type { Entry } from "../shared/Chat.ts"
import { foldEntries } from "./chat.ts"

const tool = (id: string, toolUseId: string): Entry => ({ _tag: "Tool", id, toolUseId, name: "Bash", summary: `run ${id}` })
const result = (toolUseId: string, isError: boolean): Entry => ({ _tag: "ToolResult", id: `r-${toolUseId}`, toolUseId, isError })
const reply = (id: string): Entry => ({ _tag: "Reply", id, blocks: [] })

describe("foldEntries", () => {
  test("folds tool calls in a row into one item, each marked with its result", () => {
    const entries = [tool("a", "t1"), result("t1", false), tool("b", "t2"), result("t2", true), tool("c", "t3")]
    expect(foldEntries(entries)).toEqual([
      {
        _tag: "Tools",
        id: "a",
        calls: [
          { id: "a", name: "Bash", summary: "run a", outcome: "succeeded" },
          { id: "b", name: "Bash", summary: "run b", outcome: "failed" },
          { id: "c", name: "Bash", summary: "run c", outcome: "running" },
        ],
      },
    ])
  })

  test("text between tool calls starts a new fold", () => {
    expect(foldEntries([tool("a", "t1"), reply("r"), tool("b", "t2")]).map(({ _tag, id }) => [_tag, id])).toEqual([
      ["Tools", "a"],
      ["Reply", "r"],
      ["Tools", "b"],
    ])
  })
})
