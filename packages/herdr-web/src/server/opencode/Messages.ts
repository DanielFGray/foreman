// OpenCode's messages as chat entries. They are read from OpenCode's own
// database (table `session_message`, a JSON `data` column per message), by a
// query that picks only what the chat shows: tool outputs alone make a page of
// messages megabytes long. A message or content item of a type the chat does
// not show, or one that does not decode, shows nothing.
import { Array, Match, Option, Schema as S, String } from "effect"
import { type Entry, toolSummary } from "../../shared/Chat.ts"
import { wireTag } from "../../shared/Wire.ts"
import { parseMarkdown } from "../Markdown.ts"
import { quoted } from "./Database.ts"

/**
 * SQL for the newest `limit` messages of `session`, newest first, as one
 * JSON array of `Message`. A tool's `inputs` are the input values a summary
 * is drawn from, best first; OpenCode's tools use these keys.
 */
export const messagesQuery = (session: string, limit: number) => `
select json_group_array(json(message)) from (
  select case type
    when 'user' then json_object('type', type, 'id', id, 'created', data ->> '$.time.created', 'text', data ->> '$.text')
    when 'assistant' then json_object('type', type, 'id', id, 'completed', data ->> '$.time.completed', 'content', json((
      select json_group_array(case item.value ->> '$.type'
        when 'text' then json_object('type', 'text', 'text', item.value ->> '$.text')
        when 'tool' then json_object(
          'type', 'tool', 'id', item.value ->> '$.id', 'name', item.value ->> '$.name', 'status', item.value ->> '$.state.status',
          'inputs', json_array(${Array.map(INPUT_KEYS, (key) => `item.value ->> '$.state.input.${key}'`).join(", ")}))
        else json_object('type', item.value ->> '$.type') end)
      from json_each(data, '$.content') as item)))
    when 'shell' then json_object('type', type, 'id', id, 'command', data ->> '$.command', 'status', data ->> '$.status', 'exit', data -> '$.exit')
    when 'idle' then json_object('type', type, 'id', id, 'created', data ->> '$.time.created')
    when 'compaction' then json_object('type', type, 'id', id, 'status', data ->> '$.status')
    else json_object('type', type) end as message
  from session_message where session_id = ${quoted(session)} order by seq desc limit ${limit})`

/**
 * The chat entries of `messages`, oldest first. A turn's length is the time
 * from the user's message to the last reply the agent completed. The idle
 * message that ends a turn can come much later: OpenCode closes a turn it
 * lost, such as one cut off by a restart, only when it starts again. A turn
 * whose start is not among `messages` shows no length.
 */
export const toEntries = (messages: ReadonlyArray<Message>): ReadonlyArray<Entry> =>
  Array.flatten(
    Array.mapAccum(messages, NO_TURN, (turn, message) =>
      Match.value(message).pipe(
        Match.withReturnType<[Turn, ReadonlyArray<Entry>]>(),
        Match.tagsExhaustive({
          User: ({ id, created, text }) => [
            { asked: Option.some(created), answered: Option.none() },
            String.isEmpty(String.trim(text)) ? [] : [{ _tag: "Prompt", id, text }],
          ],
          Assistant: ({ id, completed, content }) => [
            { ...turn, answered: Option.orElse(completed, () => turn.answered) },
            Array.flatMap(content, (item, index) => contentEntries(`${id}/${index}`, item)),
          ],
          Shell: (shell) => [turn, shellEntries(shell)],
          Idle: ({ id, created }) => [
            NO_TURN,
            Option.toArray(
              Option.map(turn.asked, (from): Entry => ({ _tag: "TurnEnded", id, durationMs: Option.getOrElse(turn.answered, () => created) - from })),
            ),
          ],
          Compacted: ({ id }) => [turn, [{ _tag: "Compacted", id }]],
          Unshown: () => [turn, []],
        }),
      ),
    )[1],
  )

/** When the current turn's user message came, and when the agent last completed a reply in it. */
type Turn = Readonly<{ asked: Option.Option<number>; answered: Option.Option<number> }>

const NO_TURN: Turn = { asked: Option.none(), answered: Option.none() }

// While the model still writes a call, its input is unparsed JSON text, and every key reads null.
const INPUT_KEYS = ["description", "command", "filePath", "path", "pattern", "url", "query", "name"]

const Unshown = S.Struct({ _tag: wireTag("Unshown"), type: S.String })

const ContentItem = S.Union([
  S.Struct({ _tag: wireTag("Text"), type: S.Literal("text"), text: S.String }),
  S.Struct({
    _tag: wireTag("Tool"),
    type: S.Literal("tool"),
    id: S.String,
    name: S.String,
    status: S.Literals(["streaming", "running", "completed", "error"]),
    inputs: S.Array(S.NullOr(S.String)),
  }),
  Unshown,
])
type ContentItem = typeof ContentItem.Type

export const Message = S.Union([
  S.Struct({ _tag: wireTag("User"), type: S.Literal("user"), id: S.String, created: S.Finite, text: S.String }),
  S.Struct({
    _tag: wireTag("Assistant"),
    type: S.Literal("assistant"),
    id: S.String,
    // None while the reply is still being written.
    completed: S.OptionFromNullOr(S.Finite),
    content: S.Array(ContentItem),
  }),
  // A command the user ran in OpenCode's own shell (`!`).
  S.Struct({
    _tag: wireTag("Shell"),
    type: S.Literal("shell"),
    id: S.String,
    command: S.String,
    status: S.Literals(["running", "exited", "timeout", "killed"]),
    exit: S.NullOr(S.Union([S.Finite, S.String])),
  }),
  S.Struct({ _tag: wireTag("Idle"), type: S.Literal("idle"), id: S.String, created: S.Finite }),
  S.Struct({ _tag: wireTag("Compacted"), type: S.Literal("compaction"), id: S.String, status: S.Literal("completed") }),
  Unshown,
])
export type Message = typeof Message.Type

/** What `messagesQuery` prints. */
export const Messages = S.Array(Message)

const contentEntries = (id: string, item: ContentItem): ReadonlyArray<Entry> =>
  Match.valueTags(item, {
    Text: ({ text }): ReadonlyArray<Entry> => (String.isEmpty(String.trim(text)) ? [] : [{ _tag: "Reply", id, blocks: parseMarkdown(text) }]),
    Tool: ({ id: toolUseId, name, status, inputs }): ReadonlyArray<Entry> => [
      { _tag: "Tool", id, toolUseId, name, summary: toolSummary(inputs) },
      ...(status === "completed" || status === "error" ? [result(id, toolUseId, status === "error")] : []),
    ],
    Unshown: () => [],
  })

const shellEntries = ({ id, command, status, exit }: Extract<Message, { _tag: "Shell" }>): ReadonlyArray<Entry> => [
  { _tag: "Tool", id, toolUseId: id, name: "shell", summary: toolSummary([command]) },
  ...(status === "running" ? [] : [result(id, id, status !== "exited" || exit !== 0)]),
]

const result = (id: string, toolUseId: string, isError: boolean): Entry => ({ _tag: "ToolResult", id: `${id}/result`, toolUseId, isError })
