// An agent's conversation as the page shows it: what the user asked, what the
// agent answered (as Markdown, already parsed), and the tools it ran. The
// bridge builds these from the agent's own transcript.
import { Array, Match, Option, pipe, Schema, String } from "effect"

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

const InlineRef = Schema.suspend((): Schema.Codec<Inline> => Inline)

export const Inline: Schema.Codec<Inline> = Schema.Union([
  Schema.TaggedStruct("Text", { text: Schema.String }),
  Schema.TaggedStruct("Code", { text: Schema.String }),
  Schema.TaggedStruct("Strong", { children: Schema.Array(InlineRef) }),
  Schema.TaggedStruct("Emphasis", { children: Schema.Array(InlineRef) }),
  Schema.TaggedStruct("Delete", { children: Schema.Array(InlineRef) }),
  Schema.TaggedStruct("Link", { href: Schema.String, children: Schema.Array(InlineRef) }),
  Schema.TaggedStruct("Break", {}),
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

const BlockRef = Schema.suspend((): Schema.Codec<Block, BlockEncoded> => Block)

export const Block: Schema.Codec<Block, BlockEncoded> = Schema.Union([
  Schema.TaggedStruct("Paragraph", { inlines: Schema.Array(Inline) }),
  Schema.TaggedStruct("Heading", { depth: Schema.Int, inlines: Schema.Array(Inline) }),
  Schema.TaggedStruct("CodeBlock", { lang: Schema.OptionFromOptionalKey(Schema.String), text: Schema.String }),
  Schema.TaggedStruct("List", { isOrdered: Schema.Boolean, items: Schema.Array(Schema.Array(BlockRef)) }),
  Schema.TaggedStruct("Quote", { blocks: Schema.Array(BlockRef) }),
  Schema.TaggedStruct("Table", { rows: Schema.Array(Schema.Array(Schema.Array(Inline))) }),
  Schema.TaggedStruct("Rule", {}),
])

// ENTRY

/** One thing in the conversation, in order. `id` is unique within the conversation. */
export const Entry = Schema.Union([
  /** What the user typed. */
  Schema.TaggedStruct("Prompt", { id: Schema.String, text: Schema.String }),
  /** A slash command the user ran, such as `/go-forth`. */
  Schema.TaggedStruct("Command", { id: Schema.String, name: Schema.String, args: Schema.String }),
  /** Text the agent wrote to the user. */
  Schema.TaggedStruct("Reply", { id: Schema.String, blocks: Schema.Array(Block) }),
  /** A tool the agent ran: its name and a one-line description of what it did. */
  Schema.TaggedStruct("Tool", { id: Schema.String, toolUseId: Schema.String, name: Schema.String, summary: Schema.String }),
  /** The outcome of a Tool, matched by `toolUseId`. */
  Schema.TaggedStruct("ToolResult", { id: Schema.String, toolUseId: Schema.String, isError: Schema.Boolean }),
  /** The agent finished a turn, after `durationMs`. */
  Schema.TaggedStruct("TurnEnded", { id: Schema.String, durationMs: Schema.Finite }),
  /** The conversation was compacted; earlier entries are summarized. */
  Schema.TaggedStruct("Compacted", { id: Schema.String }),
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
export const ChatUpdate = Schema.Union([
  Schema.TaggedStruct("Reset", { entries: Schema.Array(Entry) }),
  Schema.TaggedStruct("Appended", { entries: Schema.Array(Entry) }),
])
export type ChatUpdate = typeof ChatUpdate.Type

// QUESTION

/** One answer the agent offers; pressing `number` picks it. */
export const Choice = Schema.Struct({ number: Schema.Int, label: Schema.String, detail: Schema.OptionFromOptionalKey(Schema.String) })
export type Choice = typeof Choice.Type

/**
 * A question the agent waits on, as its menu shows it: a permission to run a
 * tool, or a question with set answers. The menu itself is its identity, since
 * the status stays the same from one question of a series to the next.
 * `ownAnswer` is the number of the choice that takes a typed answer instead.
 */
export const Question = Schema.Struct({ text: Schema.String, choices: Schema.Array(Choice), ownAnswer: Schema.OptionFromOptionalKey(Schema.Int) })
export type Question = typeof Question.Type

/** An answer to a question: one of its choices, or text of the user's own. */
export const Answer = Schema.Union([Schema.TaggedStruct("Picked", { choice: Schema.Int }), Schema.TaggedStruct("Typed", { text: Schema.String })])
export type Answer = typeof Answer.Type

// INPUT BOX
// Claude Code's own input box, read from its screen. A suggested prompt is
// drawn faint in an empty box; only the screen's styles tell it from text the
// user typed in the terminal.

export const InputBox = Schema.Union([
  /** The screen shows no input box: another program, or a dialog over it. */
  Schema.TaggedStruct("Absent", {}),
  Schema.TaggedStruct("Empty", {}),
  /** The prompt Claude Code suggests next; a paste replaces it. */
  Schema.TaggedStruct("Suggestion", { text: Schema.String }),
  /** Text typed into the box; a paste would join it. Claude Code's own line breaks read as typed ones. */
  Schema.TaggedStruct("Draft", { text: Schema.String }),
  /**
   * Text in the box that the screen shows only in part: a paste Claude Code
   * folded into a placeholder, or a box taller than the screen. `text` is
   * what shows.
   */
  Schema.TaggedStruct("Partial", { text: Schema.String }),
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
 * older `claude-3-5-sonnet-20241022` is "Sonnet 3.5". An id of another form
 * stays as it is.
 */
export const modelName = (id: string): string => {
  // Anthropic's own provider prefix names the same model.
  const [head, ...rest] = String.split(String.replace(/^anthropic\/|\[.*\]$/g, "")(id), "-")
  const words = Array.filter(rest, (token) => /^[a-z]+$/.test(token))
  // A date suffix has eight digits; a version part has one or two.
  const version = Array.filter(rest, (token) => /^\d{1,2}$/.test(token))
  return Option.match(
    Option.filter(Array.head(words), () => head === "claude" && words.length === 1 && Array.isArrayNonEmpty(version)),
    { onNone: () => id, onSome: (word) => `${String.capitalize(word)} ${version.join(".")}` },
  )
}
