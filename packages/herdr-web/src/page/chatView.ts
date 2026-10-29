// Draws an agent's chat: prompts, replies as Markdown, and folded tool calls.
// Every string from the transcript goes in as a text child, never as markup.
import { Array, Duration, Match, Option, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Block, Entry, Inline } from "../shared/Chat.ts"
import { foldEntries, type Item, type Step } from "./chat.ts"

export const chatView = <M>(entries: ReadonlyArray<Entry>, h: HtmlBuilder<M>): Html =>
  // The outer element is a reversed flex column, so it opens at the newest entry.
  h.div(
    [h.Class("chat")],
    [
      h.div(
        [],
        Array.match(foldEntries(entries), {
          onEmpty: () => [h.p([h.Class("note")], ["No conversation yet."])],
          onNonEmpty: (items) => Array.map(items, (item) => itemView(item, h)),
        }),
      ),
    ],
  )

const itemView = <M>(item: Item, h: HtmlBuilder<M>): Html =>
  h.keyed("div")(
    item.id,
    [h.Class(itemClass(item))],
    Match.valueTags(item, {
      Prompt: ({ text }) => [h.p([], [text])],
      Command: ({ name, args }) => [h.code([], [`${name} ${args}`.trim()])],
      Reply: ({ blocks }) => Array.map(blocks, (block) => blockView(block, h)),
      Work: ({ steps }) => [workView(steps, h)],
      TurnEnded: ({ durationMs }) => [`turn took ${Duration.format(Duration.seconds(Math.round(durationMs / 1000)))}`],
      Compacted: () => ["earlier turns were compacted"],
    }),
  )

const itemClass = (item: Item) =>
  Match.valueTags(item, {
    Prompt: () => "bubble user",
    Command: () => "bubble user",
    Reply: () => "bubble agent",
    Work: () => "work",
    TurnEnded: () => "mark",
    Compacted: () => "mark",
  })

/** A turn's work as one line that opens to every step: the count, any failures, and the latest call. */
const workView = <M>(steps: Array.NonEmptyReadonlyArray<Step>, h: HtmlBuilder<M>): Html => {
  const calls = Array.filter(steps, (step) => step._tag === "Call")
  const notes = steps.length - calls.length
  const failed = Array.filter(calls, ({ outcome }) => outcome === "failed").length
  return h.details(
    [],
    [
      h.summary(
        [],
        [
          h.span([h.Class("count")], [counted(calls.length, "tool"), ...(notes > 0 ? [`, ${counted(notes, "note")}`] : [])]),
          ...(failed > 0 ? [h.span([h.Class("failed")], [`${failed} failed`])] : []),
          ...Option.match(Array.last(calls), {
            onNone: () => [],
            onSome: ({ name, summary }) => [h.span([h.Class("last")], [String.isEmpty(summary) ? name : `${name}: ${summary}`])],
          }),
        ],
      ),
      h.ol(
        [],
        Array.map(steps, (step) =>
          Match.valueTags(step, {
            Call: ({ id, name, summary, outcome }) => h.keyed("li")(id, [h.Class(outcome)], [h.b([], [name]), ` ${summary}`]),
            Note: ({ id, blocks }) => h.keyed("li")(id, [h.Class("note")], Array.map(blocks, (block) => blockView(block, h))),
          }),
        ),
      ),
    ],
  )
}

const counted = (count: number, noun: string) => (count === 1 ? `1 ${noun}` : `${count} ${noun}s`)

// MARKDOWN

const blockView = <M>(block: Block, h: HtmlBuilder<M>): Html =>
  Match.valueTags(block, {
    Paragraph: ({ inlines }) => h.p([], inlinesView(inlines, h)),
    Heading: ({ depth, inlines }) => (depth <= 2 ? h.h3 : h.h4)([], inlinesView(inlines, h)),
    CodeBlock: ({ lang, text }) =>
      h.pre(
        [h.Class("code"), ...Option.match(lang, { onNone: () => [], onSome: (name) => [h.Title(name)] })],
        [h.code([], [text])],
      ),
    List: ({ isOrdered, items }) =>
      (isOrdered ? h.ol : h.ul)(
        [],
        Array.map(items, (item) => h.li([], Array.map(item, (child) => blockView(child, h)))),
      ),
    Quote: ({ blocks }) => h.blockquote([], Array.map(blocks, (child) => blockView(child, h))),
    Table: ({ rows }) =>
      h.div(
        [h.Class("table")],
        [
          h.table(
            [],
            Array.map(rows, (row, index) =>
              h.tr([], Array.map(row, (cell) => (index === 0 ? h.th : h.td)([], inlinesView(cell, h)))),
            ),
          ),
        ],
      ),
    Rule: () => h.hr([]),
  })

const inlinesView = <M>(inlines: ReadonlyArray<Inline>, h: HtmlBuilder<M>): ReadonlyArray<Html | string> =>
  Array.map(inlines, (inline) => inlineView(inline, h))

const inlineView = <M>(inline: Inline, h: HtmlBuilder<M>): Html | string =>
  Match.valueTags(inline, {
    Text: ({ text }) => text,
    Code: ({ text }) => h.code([], [text]),
    Strong: ({ children }) => h.strong([], inlinesView(children, h)),
    Emphasis: ({ children }) => h.em([], inlinesView(children, h)),
    Delete: ({ children }) => h.del([], inlinesView(children, h)),
    Link: ({ href, children }) =>
      h.a([h.Href(href), h.Target("_blank"), h.Rel("noopener noreferrer")], inlinesView(children, h)),
    Break: () => h.br([]),
  })
