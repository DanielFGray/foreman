// Parses an agent's Markdown into the page's own vocabulary (Chat.Block).
// Agent text is untrusted: raw HTML becomes literal text, and a link keeps
// its target only when the scheme is http, https or mailto.
import { Array, Match, Option, pipe } from "effect"
import type { PhrasingContent, RootContent } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { gfm } from "micromark-extension-gfm"
import type { Block, Inline } from "../../shared/Chat.ts"

export const parseMarkdown = (text: string): ReadonlyArray<Block> =>
  toBlocks(fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }).children)

const toBlocks = (nodes: ReadonlyArray<RootContent>): ReadonlyArray<Block> => Array.flatMap(nodes, toBlock)

const toBlock = (node: RootContent): ReadonlyArray<Block> =>
  Match.value(node).pipe(
    Match.withReturnType<ReadonlyArray<Block>>(),
    Match.discriminatorsExhaustive("type")({
      paragraph: ({ children }) => [{ _tag: "Paragraph", inlines: toInlines(children) }],
      heading: ({ depth, children }) => [{ _tag: "Heading", depth, inlines: toInlines(children) }],
      code: ({ lang, value }) => [{ _tag: "CodeBlock", lang: Option.fromNullishOr(lang), text: value }],
      list: ({ ordered, children }) => [
        { _tag: "List", isOrdered: ordered === true, items: Array.map(children, (item) => toBlocks(item.children)) },
      ],
      listItem: ({ children }) => toBlocks(children),
      blockquote: ({ children }) => [{ _tag: "Quote", blocks: toBlocks(children) }],
      table: ({ children }) => [
        { _tag: "Table", rows: Array.map(children, (row) => Array.map(row.children, (cell) => toInlines(cell.children))) },
      ],
      thematicBreak: () => [{ _tag: "Rule" }],
      html: ({ value }) => [{ _tag: "Paragraph", inlines: [{ _tag: "Text", text: value }] }],
      // Inline nodes only appear inside the blocks above.
      text: () => [],
      inlineCode: () => [],
      strong: () => [],
      emphasis: () => [],
      delete: () => [],
      link: () => [],
      linkReference: () => [],
      image: () => [],
      imageReference: () => [],
      break: () => [],
      footnoteReference: () => [],
      // Link definitions, footnote bodies and frontmatter carry nothing to show.
      definition: () => [],
      footnoteDefinition: () => [],
      yaml: () => [],
      tableRow: () => [],
      tableCell: () => [],
    }),
  )

const toInlines = (nodes: ReadonlyArray<PhrasingContent>): ReadonlyArray<Inline> => Array.flatMap(nodes, toInline)

const toInline = (node: PhrasingContent): ReadonlyArray<Inline> =>
  Match.value(node).pipe(
    Match.withReturnType<ReadonlyArray<Inline>>(),
    Match.discriminatorsExhaustive("type")({
      text: ({ value }) => [{ _tag: "Text", text: value }],
      inlineCode: ({ value }) => [{ _tag: "Code", text: value }],
      strong: ({ children }) => [{ _tag: "Strong", children: toInlines(children) }],
      emphasis: ({ children }) => [{ _tag: "Emphasis", children: toInlines(children) }],
      delete: ({ children }) => [{ _tag: "Delete", children: toInlines(children) }],
      link: ({ url, children }) => linked(url, toInlines(children)),
      image: ({ url, alt }) => linked(url, [{ _tag: "Text", text: alt ?? url }]),
      linkReference: ({ children }) => toInlines(children),
      imageReference: ({ alt }) => [{ _tag: "Text", text: alt ?? "" }],
      break: () => [{ _tag: "Break" }],
      html: ({ value }) => [{ _tag: "Text", text: value }],
      footnoteReference: ({ identifier }) => [{ _tag: "Text", text: `[^${identifier}]` }],
    }),
  )

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"])

const linked = (url: string, children: ReadonlyArray<Inline>): ReadonlyArray<Inline> =>
  pipe(
    Option.liftThrowable(() => new URL(url))(),
    Option.filter(({ protocol }) => SAFE_SCHEMES.has(protocol)),
    Option.match({
      onNone: () => children,
      onSome: ({ href }) => [{ _tag: "Link", href, children }],
    }),
  )

