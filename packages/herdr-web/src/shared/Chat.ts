// An agent's conversation as the page shows it: what the user asked, what the
// agent answered (as Markdown, already parsed), and the tools it ran. The
// bridge builds these from the agent's own transcript.
import { Array, Match, Option, pipe, Schema as S, String } from "effect"

// MARKDOWN
// A small Markdown vocabulary the page draws with its own elements. Raw HTML
// in agent text arrives as Text, so the page never inserts markup.

export type Inline =
  | Readonly<{ _tag: "Text"; text: string }>
  | Readonly<{ _tag: "Code"; text: string }>
  | Readonly<{ _tag: "Strong"; children: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "Emphasis"; children: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "Delete"; children: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "Link"; href: string; children: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "Break" }>

const InlineRef = S.suspend((): S.Codec<Inline> => Inline)

export const Inline: S.Codec<Inline> = S.Union([
  S.TaggedStruct("Text", { text: S.String }),
  S.TaggedStruct("Code", { text: S.String }),
  S.TaggedStruct("Strong", { children: S.Array(InlineRef) }),
  S.TaggedStruct("Emphasis", { children: S.Array(InlineRef) }),
  S.TaggedStruct("Delete", { children: S.Array(InlineRef) }),
  S.TaggedStruct("Link", { href: S.String, children: S.Array(InlineRef) }),
  S.TaggedStruct("Break", {}),
])

export type Block =
  | Readonly<{ _tag: "Paragraph"; inlines: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "Heading"; depth: number; inlines: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "CodeBlock"; lang: Option.Option<string>; text: string }>
  | Readonly<{ _tag: "List"; isOrdered: boolean; items: ReadonlyArray<ReadonlyArray<Block>> }>
  | Readonly<{ _tag: "Quote"; blocks: ReadonlyArray<Block> }>
  | Readonly<{ _tag: "Table"; rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Inline>>> }>
  | Readonly<{ _tag: "Rule" }>

type BlockEncoded =
  | Readonly<{ _tag: "Paragraph"; inlines: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "Heading"; depth: number; inlines: ReadonlyArray<Inline> }>
  | Readonly<{ _tag: "CodeBlock"; lang?: string; text: string }>
  | Readonly<{ _tag: "List"; isOrdered: boolean; items: ReadonlyArray<ReadonlyArray<BlockEncoded>> }>
  | Readonly<{ _tag: "Quote"; blocks: ReadonlyArray<BlockEncoded> }>
  | Readonly<{ _tag: "Table"; rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Inline>>> }>
  | Readonly<{ _tag: "Rule" }>

const BlockRef = S.suspend((): S.Codec<Block, BlockEncoded> => Block)

export const Block: S.Codec<Block, BlockEncoded> = S.Union([
  S.TaggedStruct("Paragraph", { inlines: S.Array(Inline) }),
  S.TaggedStruct("Heading", { depth: S.Int, inlines: S.Array(Inline) }),
  S.TaggedStruct("CodeBlock", { lang: S.OptionFromOptionalKey(S.String), text: S.String }),
  S.TaggedStruct("List", { isOrdered: S.Boolean, items: S.Array(S.Array(BlockRef)) }),
  S.TaggedStruct("Quote", { blocks: S.Array(BlockRef) }),
  S.TaggedStruct("Table", { rows: S.Array(S.Array(S.Array(Inline))) }),
  S.TaggedStruct("Rule", {}),
])

// ENTRY

/** One thing in the conversation, in order. `id` is unique within the conversation. */
export const Entry = S.Union([
  /** What the user typed. */
  S.TaggedStruct("Prompt", { id: S.String, text: S.String }),
  /** A slash command the user ran, such as `/go-forth`. */
  S.TaggedStruct("Command", { id: S.String, name: S.String, args: S.String }),
  /** Text the agent wrote to the user. */
  S.TaggedStruct("Reply", { id: S.String, blocks: S.Array(Block) }),
  /** A tool the agent ran: its name and a one-line description of what it did. */
  S.TaggedStruct("Tool", { id: S.String, toolUseId: S.String, name: S.String, summary: S.String }),
  /** The outcome of a Tool, matched by `toolUseId`. */
  S.TaggedStruct("ToolResult", { id: S.String, toolUseId: S.String, isError: S.Boolean }),
  /** The agent finished a turn, after `durationMs`. */
  S.TaggedStruct("TurnEnded", { id: S.String, durationMs: S.Finite }),
  /** The conversation was compacted; earlier entries are summarized. */
  S.TaggedStruct("Compacted", { id: S.String }),
])
export type Entry = typeof Entry.Type

/** A Tool entry's summary: the first line of the first nonempty value, such as a command's description or a file's path. */
export const toolSummary = (values: ReadonlyArray<string | null | undefined>) =>
  pipe(
    Array.getSomes(Array.map(values, Option.fromNullishOr)),
    Array.findFirst(String.isNonEmpty),
    Option.flatMap((value) => Array.head(String.split(value, "\n"))),
    Option.map((line) => line.slice(0, SUMMARY_LENGTH)),
    Option.getOrElse(() => ""),
  )

const SUMMARY_LENGTH = 160

/**
 * What the chat call streams: the recent entries first (`Reset`), then each
 * batch of new ones. An agent that changes entries in place, such as a reply
 * it still writes, sends a whole `Reset` again.
 */
export const ChatUpdate = S.Union([
  S.TaggedStruct("Reset", { entries: S.Array(Entry) }),
  S.TaggedStruct("Appended", { entries: S.Array(Entry) }),
])
export type ChatUpdate = typeof ChatUpdate.Type

// QUESTION

/** One answer the agent offers; pressing `number` picks it. */
export const Choice = S.Struct({ number: S.Int, label: S.String, detail: S.OptionFromOptionalKey(S.String) })
export type Choice = typeof Choice.Type

/**
 * A question the agent waits on, as its menu shows it: a permission to run a
 * tool, or a question with set answers. The menu itself is its identity, since
 * the status stays the same from one question of a series to the next.
 * `ownAnswer` is the number of the choice that takes a typed answer instead.
 */
export const Question = S.Struct({ text: S.String, choices: S.Array(Choice), ownAnswer: S.OptionFromOptionalKey(S.Int) })
export type Question = typeof Question.Type

/** An answer to a question: one of its choices, or text of the user's own. */
export const Answer = S.Union([S.TaggedStruct("Picked", { choice: S.Int }), S.TaggedStruct("Typed", { text: S.String })])
export type Answer = typeof Answer.Type

// INPUT BOX
// Claude Code's own input box, read from its screen. A suggested prompt is
// drawn faint in an empty box; only the screen's styles tell it from text the
// user typed in the terminal.

export const InputBox = S.Union([
  /** The screen shows no input box: another program, or a dialog over it. */
  S.TaggedStruct("Absent", {}),
  S.TaggedStruct("Empty", {}),
  /** The prompt Claude Code suggests next; a paste replaces it. */
  S.TaggedStruct("Suggestion", { text: S.String }),
  /** Text typed into the box; a paste would join it. Claude Code's own line breaks read as typed ones. */
  S.TaggedStruct("Draft", { text: S.String }),
  /**
   * Text in the box that the screen shows only in part: a paste Claude Code
   * folded into a placeholder, or a box taller than the screen. `text` is
   * what shows.
   */
  S.TaggedStruct("Partial", { text: S.String }),
])
export type InputBox = typeof InputBox.Type

/** The text typed into the box, as it shows; none when there is no box. A suggestion is no text. */
export const typedText = (box: InputBox): Option.Option<string> =>
  Match.valueTags(box, {
    Absent: () => Option.none(),
    Empty: () => Option.some(""),
    Suggestion: () => Option.some(""),
    Draft: ({ text }) => Option.some(text),
    Partial: ({ text }) => Option.some(text),
  })

/**
 * Whether two texts of the box are the same text. The box wraps a long line
 * where it likes, so the screen shows breaks and indents the text does not
 * have: only the characters that are not whitespace count.
 */
export const sameTyped = (one: string, other: string) => one.replace(/\s/g, "") === other.replace(/\s/g, "")

// MODEL

/**
 * A model id as people name it: `claude-opus-5-5[1m]` is "Opus 5.5", and the
 * older `claude-3-5-sonnet-20241022` is "Sonnet 3.5". A provider before a
 * slash, as in OpenCode's `opencode-go/deepseek-v4-pro`, names no part of
 * the model, so it is dropped. An id of another form stays as it is, after
 * its provider.
 */
export const modelName = (id: string): string => {
  const model = String.replace(/^[^/]+\//, "")(id)
  const [head, ...rest] = String.split(String.replace(/\[.*\]$/, "")(model), "-")
  const words = Array.filter(rest, (token) => /^[a-z]+$/.test(token))
  // A date suffix has eight digits; a version part has one or two.
  const version = Array.filter(rest, (token) => /^\d{1,2}$/.test(token))
  return Option.match(
    Option.filter(Array.head(words), () => head === "claude" && words.length === 1 && Array.isArrayNonEmpty(version)),
    { onNone: () => model, onSome: (word) => `${String.capitalize(word)} ${version.join(".")}` },
  )
}
