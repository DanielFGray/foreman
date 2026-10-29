// An agent's conversation as the page shows it: what the user asked, what the
// agent answered (as Markdown, already parsed), and the tools it ran. The
// bridge builds these from the agent's own transcript.
import { type Option, Schema } from "effect"

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

/** One thing in the conversation, in transcript order. `id` is the transcript line's uuid. */
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

/** What the chat call streams: the recent entries first (`Reset`), then each batch of new ones. */
export const ChatUpdate = Schema.Union([
  Schema.TaggedStruct("Reset", { entries: Schema.Array(Entry) }),
  Schema.TaggedStruct("Appended", { entries: Schema.Array(Entry) }),
])
export type ChatUpdate = typeof ChatUpdate.Type
