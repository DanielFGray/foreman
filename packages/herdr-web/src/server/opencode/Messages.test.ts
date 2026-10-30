import { Database } from "bun:sqlite"
import { Array, Option, Schema } from "effect"
import { expect, test } from "vitest"
import { parseMarkdown } from "../Markdown.ts"
import { Messages, messagesQuery, toEntries } from "./Messages.ts"
import { Sessions, sessionsQuery } from "./Session.ts"

// A made-up database with the columns of OpenCode's two tables that the queries read, and its `data` shapes.
const database = () => {
  const db = new Database(":memory:")
  db.run("create table session_v2 (id text primary key, parent_id text, directory text not null, title text, model text)")
  db.run("create table session_message (id text primary key, session_id text not null, type text not null, seq integer not null, data text not null)")
  const session = db.prepare("insert into session_v2 values (?, ?, ?, ?, ?)")
  session.run("ses_a", null, "/work/it's here", "Count the tests", JSON.stringify({ id: "model-one", providerID: "acme", variant: "high" }))
  session.run("ses_b", "ses_a", "/work/it's here", null, null)
  session.run("ses_c", null, "/elsewhere", "Other work", null)
  const message = db.prepare("insert into session_message values (?, 'ses_a', ?, ?, ?)")
  Array.forEach(MESSAGES, ([type, data], index) => message.run(`msg_${index + 1}`, type, index + 1, JSON.stringify(data)))
  return db
}

const MESSAGES: ReadonlyArray<readonly [string, object]> = [
  ["user", { time: { created: 1000 }, text: "Count the tests", files: [], agents: [] }],
  [
    "assistant",
    {
      time: { created: 1100, completed: 2500 },
      agent: "build",
      model: { id: "some-model", providerID: "some-provider" },
      content: [
        { type: "reasoning", text: "Find the test files." },
        { type: "tool", id: "call_1", name: "shell", time: {}, state: { status: "completed", input: { command: "rg -c test", description: "Count test lines" }, content: [{ type: "text", text: "a long output" }] } },
        { type: "tool", id: "call_2", name: "read", time: {}, state: { status: "error", input: { filePath: "/work/missing.ts" }, error: { message: "not found" } } },
        { type: "tool", id: "call_3", name: "edit", time: {}, state: { status: "streaming", input: '{"filePath": "/wo' } },
        { type: "text", text: "There are **12** tests." },
      ],
    },
  ],
  ["synthetic", { time: { created: 1200 }, text: "a reminder the user never sees" }],
  ["shell", { time: { created: 1300 }, shellID: "sh_1", command: "git status\ngit log", status: "exited", exit: 1, output: {} }],
  ["idle", { time: { created: 4000 }, outcome: "succeeded" }],
  ["compaction", { time: { created: 5000 }, status: "completed", reason: "auto", summary: "…" }],
  ["idle", { time: { created: 6000 }, outcome: "succeeded" }],
]

// The one value a query prints, decoded from its JSON.
const printed = <A, I>(schema: Schema.Codec<A, I>, sql: string) => Schema.decodeUnknownSync(Schema.Tuple([Schema.Tuple([Schema.fromJsonString(schema)])]))(database().query(sql).values())[0][0]

test("OpenCode's messages read as the chat's entries, oldest first", () => {
  const messages = printed(Messages, messagesQuery("ses_a", 100))
  expect(toEntries(Array.reverse(messages))).toEqual([
    { _tag: "Prompt", id: "msg_1", text: "Count the tests" },
    { _tag: "Tool", id: "msg_2/1", toolUseId: "call_1", name: "shell", summary: "Count test lines" },
    { _tag: "ToolResult", id: "msg_2/1/result", toolUseId: "call_1", isError: false },
    { _tag: "Tool", id: "msg_2/2", toolUseId: "call_2", name: "read", summary: "/work/missing.ts" },
    { _tag: "ToolResult", id: "msg_2/2/result", toolUseId: "call_2", isError: true },
    { _tag: "Tool", id: "msg_2/3", toolUseId: "call_3", name: "edit", summary: "" },
    { _tag: "Reply", id: "msg_2/4", blocks: parseMarkdown("There are **12** tests.") },
    { _tag: "Tool", id: "msg_4", toolUseId: "msg_4", name: "shell", summary: "git status" },
    { _tag: "ToolResult", id: "msg_4/result", toolUseId: "msg_4", isError: true },
    { _tag: "TurnEnded", id: "msg_5", durationMs: 1500 },
    { _tag: "Compacted", id: "msg_6" },
  ])
})

test("only the newest messages are read", () => {
  const messages = printed(Messages, messagesQuery("ses_a", 2))
  expect(toEntries(Array.reverse(messages))).toEqual([{ _tag: "Compacted", id: "msg_6" }])
})

test("the sessions of a folder are read with their titles, parents and models", () => {
  expect(printed(Sessions, sessionsQuery("/work/it's here"))).toEqual([
    { id: "ses_a", title: Option.some("Count the tests"), parentID: Option.none(), model: Option.some({ id: "model-one", providerID: "acme" }) },
    { id: "ses_b", title: Option.none(), parentID: Option.some("ses_a"), model: Option.none() },
  ])
})
