// Claude Code's transcript (`<session>.jsonl`, one JSON object per line) as
// chat entries. Lines are chosen by their top-level `type`: `api-request-blob`
// lines repeat whole turns with the same message roles, so choosing by role
// would show every turn twice. Claude Code writes one content block per line,
// so each block becomes its own entry and no lines need merging.
import { Array, Match, Option, pipe, Schema, String } from "effect"
import type { Entry } from "../../shared/Chat.ts"
import { wireTag } from "../../shared/Wire.ts"
import { parseMarkdown } from "./Markdown.ts"

/** The chat entries one transcript line holds; none for a line the chat does not show or cannot read. */
export const decodeLine = (line: string): ReadonlyArray<Entry> =>
  Option.match(decodeTranscriptLine(line), { onNone: () => [], onSome: toEntries })

/**
 * Splits bytes read from the transcript into complete lines, and the bytes
 * after the last newline, which wait for the rest of their line. A newline
 * byte never occurs inside a multibyte UTF-8 character, so splitting before
 * decoding is safe.
 */
export const splitLines = (pending: Uint8Array, chunk: Uint8Array) => {
  const bytes = new Uint8Array(pending.length + chunk.length)
  bytes.set(pending)
  bytes.set(chunk, pending.length)
  const end = bytes.lastIndexOf(NEWLINE)
  return {
    lines: Array.filter(String.split(decoder.decode(bytes.subarray(0, Math.max(end, 0))), "\n"), String.isNonEmpty),
    rest: bytes.slice(end + 1),
  }
}

const NEWLINE = 0x0a
const decoder = new TextDecoder()

// LINE

/** The tool inputs a summary is drawn from; Claude Code's tools use these keys. */
const ToolInput = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  file_path: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
})
type ToolInput = typeof ToolInput.Type

const Unshown = Schema.Struct({ _tag: wireTag("Unshown"), type: Schema.String })

const UserBlock = Schema.Union([
  Schema.Struct({ _tag: wireTag("Text"), type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    _tag: wireTag("ToolResult"),
    type: Schema.Literal("tool_result"),
    tool_use_id: Schema.String,
    is_error: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  }),
  Unshown,
])
type UserBlock = typeof UserBlock.Type

const AssistantBlock = Schema.Union([
  Schema.Struct({ _tag: wireTag("Text"), type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ _tag: wireTag("ToolUse"), type: Schema.Literal("tool_use"), id: Schema.String, name: Schema.String, input: ToolInput }),
  Unshown,
])
type AssistantBlock = typeof AssistantBlock.Type

const Flag = Schema.optionalKey(Schema.NullOr(Schema.Boolean))

const TranscriptLine = Schema.Union([
  Schema.Struct({
    _tag: wireTag("User"),
    type: Schema.Literal("user"),
    uuid: Schema.String,
    isSidechain: Flag,
    isMeta: Flag,
    isCompactSummary: Flag,
    message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(UserBlock)]) }),
  }),
  Schema.Struct({
    _tag: wireTag("Assistant"),
    type: Schema.Literal("assistant"),
    uuid: Schema.String,
    isSidechain: Flag,
    message: Schema.Struct({ content: Schema.Array(AssistantBlock) }),
  }),
  // A prompt the user sends while the agent works waits in a queue, and
  // reaches the transcript as this attachment instead of a user line.
  // Notifications from background tasks and other agents queue the same way
  // without humanTurn.
  Schema.Struct({
    _tag: wireTag("QueuedPrompt"),
    type: Schema.Literal("attachment"),
    uuid: Schema.String,
    isSidechain: Flag,
    attachment: Schema.Struct({ type: Schema.Literal("queued_command"), prompt: Schema.String, humanTurn: Schema.Literal(true) }),
  }),
  Schema.Struct({
    _tag: wireTag("TurnEnded"),
    type: Schema.Literal("system"),
    subtype: Schema.Literal("turn_duration"),
    uuid: Schema.String,
    durationMs: Schema.Finite,
  }),
  Schema.Struct({
    _tag: wireTag("Compacted"),
    type: Schema.Literal("system"),
    subtype: Schema.Literal("compact_boundary"),
    uuid: Schema.String,
  }),
  Unshown,
])
type TranscriptLine = typeof TranscriptLine.Type

const decodeTranscriptLine = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptLine))

// ENTRIES
// One line can hold several blocks, so an entry's id is the line's uuid and
// the block's position.

const toEntries = (line: TranscriptLine): ReadonlyArray<Entry> =>
  Match.value(line).pipe(
    Match.withReturnType<ReadonlyArray<Entry>>(),
    Match.tagsExhaustive({
    User: ({ uuid, isSidechain, isMeta, isCompactSummary, message }) =>
      isSidechain === true || isMeta === true || isCompactSummary === true ? [] : userEntries(uuid, message.content),
    Assistant: ({ uuid, isSidechain, message }) =>
      isSidechain === true
        ? []
        : Array.flatMap(message.content, (block, index) => assistantEntries(`${uuid}/${index}`, block)),
    QueuedPrompt: ({ uuid, isSidechain, attachment }) =>
      isSidechain === true || String.isEmpty(String.trim(attachment.prompt)) ? [] : [{ _tag: "Prompt", id: uuid, text: attachment.prompt }],
    TurnEnded: ({ uuid, durationMs }) => [{ _tag: "TurnEnded", id: uuid, durationMs }],
    Compacted: ({ uuid }) => [{ _tag: "Compacted", id: uuid }],
    Unshown: () => [],
    }),
  )

const userEntries = (uuid: string, content: string | ReadonlyArray<UserBlock>): ReadonlyArray<Entry> =>
  Array.flatMap(String.isString(content) ? [textBlock(content)] : content, (block, index) =>
    userBlockEntries(`${uuid}/${index}`, block),
  )

const textBlock = (text: string): UserBlock => ({ _tag: "Text", type: "text", text })

const userBlockEntries = (id: string, block: UserBlock): ReadonlyArray<Entry> =>
  Match.value(block).pipe(
    Match.withReturnType<ReadonlyArray<Entry>>(),
    Match.tagsExhaustive({
    Text: ({ text }) => typedText(id, text),
    ToolResult: ({ tool_use_id, is_error }) => [{ _tag: "ToolResult", id, toolUseId: tool_use_id, isError: is_error === true }],
    Unshown: () => [],
    }),
  )

// Claude Code writes a slash command as tagged text in a user line, and the
// command's local output the same way.
const typedText = (id: string, text: string): ReadonlyArray<Entry> =>
  Option.match(tagContent(text, "command-name"), {
    onSome: (name) => [{ _tag: "Command", id, name, args: Option.getOrElse(tagContent(text, "command-args"), () => "") }],
    onNone: () => (String.startsWith("<local-command-")(text) || String.isEmpty(String.trim(text)) ? [] : [{ _tag: "Prompt", id, text }]),
  })

const tagContent = (text: string, tag: string) =>
  pipe(
    String.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))(text),
    Option.flatMap((found) => Array.get(found, 1)),
    Option.map(String.trim),
  )

const assistantEntries = (id: string, block: AssistantBlock): ReadonlyArray<Entry> =>
  Match.value(block).pipe(
    Match.withReturnType<ReadonlyArray<Entry>>(),
    Match.tagsExhaustive({
    Text: ({ text }) => (String.isEmpty(String.trim(text)) ? [] : [{ _tag: "Reply", id, blocks: parseMarkdown(text) }]),
    ToolUse: ({ id: toolUseId, name, input }) => [{ _tag: "Tool", id, toolUseId, name, summary: summarize(input) }],
    Unshown: () => [],
    }),
  )

const SUMMARY_LENGTH = 160

/** The first line of the most telling input, such as a Bash command's description or a Read's file path. */
const summarize = (input: ToolInput) =>
  pipe(
    [input.description, input.command, input.file_path, input.pattern, input.url, input.query, input.prompt],
    Array.map(Option.fromUndefinedOr),
    Array.getSomes,
    Array.findFirst(String.isNonEmpty),
    Option.flatMap((value) => Array.head(String.split(value, "\n"))),
    Option.map((line) => line.slice(0, SUMMARY_LENGTH)),
    Option.getOrElse(() => ""),
  )

// MODEL

/** The model of the newest reply among `lines`, or `before` when they hold none. */
export const newestModel = (lines: ReadonlyArray<string>, before: Option.Option<string>) =>
  Option.orElse(Array.last(Array.getSomes(Array.map(lines, modelOfLine))), () => before)

/**
 * The model a line of the main conversation names: the id of the model that
 * wrote a reply, or the name `/model` reports when it switches, such as
 * "Opus 5.5". None for any other line.
 */
const modelOfLine = (line: string): Option.Option<string> =>
  pipe(
    decodeModelLine(line),
    Option.filter(({ isSidechain }) => isSidechain !== true),
    Option.flatMap((one) =>
      one.type === "assistant"
        ? // Claude Code writes its own notices, such as an API error, as replies from "<synthetic>".
          Option.filter(Option.some(one.message.model), (model) => !String.startsWith("<")(model))
        : Option.flatMap(String.match(/<local-command-stdout>Set model to `([^`]+)`/)(one.message.content), (found) => Array.get(found, 1)),
    ),
  )

const ModelLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("assistant"), isSidechain: Flag, message: Schema.Struct({ model: Schema.String }) }),
  Schema.Struct({ type: Schema.Literal("user"), isSidechain: Flag, message: Schema.Struct({ content: Schema.String }) }),
])
const decodeModelLine = Schema.decodeUnknownOption(Schema.fromJsonString(ModelLine))
