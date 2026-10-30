import { describe, expect, test } from "vitest"
import { Array, Option } from "effect"
import { type Entry, modelName } from "../../shared/Chat.ts"
import { parseMarkdown } from "./Markdown.ts"
import { decodeLine, newestModel, splitLines } from "./Transcript.ts"

// Lines shaped like Claude Code's own (fields trimmed to the ones that matter).
const user = (content: unknown, extra: object = {}) =>
  JSON.stringify({ type: "user", uuid: "u1", isSidechain: false, message: { role: "user", content }, ...extra })
const assistant = (block: object, extra: object = {}) =>
  JSON.stringify({ type: "assistant", uuid: "a1", isSidechain: false, message: { role: "assistant", content: [block] }, ...extra })

const bytes = (text: string) => new TextEncoder().encode(text)

describe("splitLines", () => {
  test("returns complete lines and keeps a partial last line for the next read", () => {
    const first = splitLines(new Uint8Array(), bytes('{"a":1}\n{"b":'))
    expect(first.lines).toEqual(['{"a":1}'])
    expect(splitLines(first.rest, bytes("2}\n")).lines).toEqual(['{"b":2}'])
  })

  test("keeps a multibyte character that a read cut in two", () => {
    const line = bytes('{"t":"ü"}\n')
    const cut = line.indexOf(0xc3) + 1
    const first = splitLines(new Uint8Array(), line.subarray(0, cut))
    expect(first.lines).toEqual([])
    expect(splitLines(first.rest, line.subarray(cut)).lines).toEqual(['{"t":"ü"}'])
  })
})

describe("decodeLine", () => {
  test("a typed prompt", () => {
    expect(decodeLine(user("deploy the backend"))).toEqual([{ _tag: "Prompt", id: "u1/0", text: "deploy the backend" }])
  })

  test("a slash command", () => {
    const text = "<command-message>go-forth</command-message>\n<command-name>/go-forth</command-name>\n<command-args>now</command-args>"
    expect(decodeLine(user(text))).toEqual([{ _tag: "Command", id: "u1/0", name: "/go-forth", args: "now" }])
  })

  test("skips meta, sidechain, compact-summary and local-command lines", () => {
    expect(decodeLine(user("hidden", { isMeta: true }))).toEqual([])
    expect(decodeLine(user("subagent", { isSidechain: true }))).toEqual([])
    expect(decodeLine(user("This session is being continued", { isCompactSummary: true }))).toEqual([])
    expect(decodeLine(user("<local-command-stdout>ok</local-command-stdout>"))).toEqual([])
  })

  test("skips an api-request-blob, which repeats a turn with the same role", () => {
    expect(decodeLine(JSON.stringify({ type: "api-request-blob", message: { role: "user", content: "again" } }))).toEqual([])
  })

  test("a tool call with its summary, and its result", () => {
    const call = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "bun test", description: "Run the tests" } }
    expect(decodeLine(assistant(call))).toEqual([
      { _tag: "Tool", id: "a1/0", toolUseId: "toolu_1", name: "Bash", summary: "Run the tests" },
    ])
    expect(decodeLine(user([{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "boom" }]))).toEqual([
      { _tag: "ToolResult", id: "u1/0", toolUseId: "toolu_1", isError: true },
    ])
  })

  test("a reply as parsed Markdown; thinking is not shown", () => {
    expect(decodeLine(assistant({ type: "text", text: "**done**" }))).toEqual([
      { _tag: "Reply", id: "a1/0", blocks: [{ _tag: "Paragraph", inlines: [{ _tag: "Strong", children: [{ _tag: "Text", text: "done" }] }] }] },
    ])
    expect(decodeLine(assistant({ type: "thinking", thinking: "hmm" }))).toEqual([])
  })

  test("turn end and compaction", () => {
    expect(decodeLine(JSON.stringify({ type: "system", subtype: "turn_duration", uuid: "s1", durationMs: 1500 }))).toEqual([
      { _tag: "TurnEnded", id: "s1", durationMs: 1500 },
    ])
    expect(decodeLine(JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "s2" }))).toEqual([
      { _tag: "Compacted", id: "s2" },
    ])
  })

  test("a line that is not JSON shows nothing", () => {
    expect(decodeLine("{not json")).toEqual([])
  })
})

// One real line of each kind, from Claude Code's own transcripts, with every
// string replaced by a placeholder named after its key.
describe("decodeLine on real transcript lines", async () => {
  const fixture = new Uint8Array(await Bun.file(`${import.meta.dirname}/fixtures/transcript.jsonl`).arrayBuffer())
  const { lines, rest } = splitLines(new Uint8Array(), fixture)
  const id = expect.any(String)
  const expected: ReadonlyArray<readonly [string, ReadonlyArray<Entry>]> = [
    ["prompt", [{ _tag: "Prompt", id, text: "<content>" }]],
    ["command", [{ _tag: "Command", id, name: "/<name>", args: "<args>" }]],
    ["local command output", []],
    ["meta", []],
    ["compact summary", []],
    ["tool result", [{ _tag: "ToolResult", id, toolUseId: id, isError: false }]],
    ["failed tool result", [{ _tag: "ToolResult", id, toolUseId: id, isError: true }]],
    ["reply", [{ _tag: "Reply", id, blocks: [{ _tag: "Paragraph", inlines: [{ _tag: "Text", text: "<text>" }] }] }]],
    ["tool use", [{ _tag: "Tool", id, toolUseId: id, name: "Bash", summary: "<description>" }]],
    ["thinking", []],
    ["sidechain", []],
    ["turn end", [{ _tag: "TurnEnded", id, durationMs: expect.any(Number) }]],
    ["compaction", [{ _tag: "Compacted", id }]],
    ["away summary", []],
    ["request blob, text", []],
    ["request blob, tool result", []],
    ["request blob, tool use", []],
    ["api-request", []],
    ["attachment", []],
    ["last-prompt", []],
    ["permission-mode", []],
    ["ai-title", []],
    ["queue-operation", []],
    ["file-history-snapshot", []],
    ["prompt sent during a turn", [{ _tag: "Prompt", id, text: "<prompt>" }]],
    ["task notification sent during a turn", []],
  ]

  test("the fixture splits into one line per kind", () => {
    expect(lines.length).toBe(expected.length)
    expect(rest.length).toBe(0)
  })

  Array.forEach(expected, ([kind, entries], index) =>
    test(kind, () => {
      expect(decodeLine(lines[index] ?? "")).toEqual(entries)
    }),
  )
})

describe("parseMarkdown", () => {
  test("raw HTML stays text", () => {
    expect(parseMarkdown('<img src=x onerror="alert(1)">')).toEqual([
      { _tag: "Paragraph", inlines: [{ _tag: "Text", text: '<img src=x onerror="alert(1)">' }] },
    ])
  })

  test("a javascript: link loses its target; an https link keeps it", () => {
    expect(parseMarkdown("[x](javascript:alert(1)) [y](https://example.com/)")).toEqual([
      {
        _tag: "Paragraph",
        inlines: [
          { _tag: "Text", text: "x" },
          { _tag: "Text", text: " " },
          { _tag: "Link", href: "https://example.com/", children: [{ _tag: "Text", text: "y" }] },
        ],
      },
    ])
  })

  test("code blocks keep their language; tables keep their cells", () => {
    expect(parseMarkdown("```ts\nconst a = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |")).toEqual([
      { _tag: "CodeBlock", lang: Option.some("ts"), text: "const a = 1" },
      {
        _tag: "Table",
        rows: [
          [[{ _tag: "Text", text: "a" }], [{ _tag: "Text", text: "b" }]],
          [[{ _tag: "Text", text: "1" }], [{ _tag: "Text", text: "2" }]],
        ],
      },
    ])
  })
})

describe("newestModel", () => {
  const reply = (model: string, extra: object = {}) => assistant({ type: "text", text: "hi" }, { message: { role: "assistant", model, content: [] }, ...extra })

  test("is the model of the last reply of the main conversation", () => {
    const lines = [reply("claude-sonnet-5-5"), reply("claude-opus-5-5"), user("next"), reply("claude-haiku-5-5", { isSidechain: true })]
    expect(newestModel(lines, Option.none())).toEqual(Option.some("claude-opus-5-5"))
  })

  test("is the model `/model` switched to, before any reply from it", () => {
    const switched = user("<local-command-stdout>Set model to `Haiku 5.5` for this session only</local-command-stdout>")
    expect(newestModel([reply("claude-opus-5-5"), switched], Option.none())).toEqual(Option.some("Haiku 5.5"))
  })

  test("keeps the model read before when the lines hold no reply, or only Claude Code's own notices", () => {
    expect(newestModel([user("hi"), reply("<synthetic>")], Option.some("claude-opus-5-5"))).toEqual(Option.some("claude-opus-5-5"))
  })
})

test("a model id reads as its family and version", () => {
  expect(
    Array.map(
      ["claude-opus-5-5", "claude-opus-5-5[1m]", "anthropic/claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022", "claude-sonnet-4", "gpt-5.6"],
      modelName,
    ),
  ).toEqual(["Opus 5.5", "Opus 5.5", "Sonnet 5.5", "Haiku 4.5", "Sonnet 3.5", "Sonnet 4", "gpt-5.6"])
})
