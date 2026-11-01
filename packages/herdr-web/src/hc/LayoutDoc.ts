// herdr-app's layout: the `herdr-app` document hc keeps on each machine, its
// spaces, their tabs, and each tab's tree of panes. herdr-app reads it again on
// every change, so the bridge edits the layout by writing the document, as the
// window itself does, with the window open or closed. The edits follow
// herdr-app's own rules (src/layout.rs and src/model.rs in herdr-app 0.1.9).
//
// herdr-app publishes no schema for the document, and adds fields to it as it
// grows: a node's look, a mod's props. The bridge types only the fields it
// reads or edits, and carries every other field through as it was, so a write
// never drops what the window wrote.
import { Array, Option, pipe, Schema as S } from "effect"
import type { Direction } from "../shared/Api.ts"
import type { Layout, PaneContent, Space } from "../shared/Fleet.ts"

/** The fields herdr-app owns and the bridge never reads. */
const Rest = [S.Record(S.String, S.Unknown)] as const

/** A node's share of its parent: a weight, or fixed pixels. */
const Size = S.StructWithRest(S.Struct({ weight: S.optionalKey(S.Finite), px: S.optionalKey(S.Finite) }), Rest)
type Size = typeof Size.Type

/** What a block shows: a terminal, a mod, or something else herdr-app draws. */
const Content = S.StructWithRest(S.Struct({ terminal: S.optionalKey(S.String), mod: S.optionalKey(S.String) }), Rest)

export type Node = {
  readonly id?: string
  /** `block`, `row`, `column` or `stack`. */
  readonly type: string
  readonly children?: ReadonlyArray<Node>
  readonly content?: typeof Content.Type
  readonly size?: Size
  /** The child of a stack that shows. */
  readonly active?: string
  /** False when herdr-app must not close it. */
  readonly closable?: boolean
  readonly [key: string]: unknown
}

export const Node: S.Codec<Node> = S.StructWithRest(
  S.Struct({
    id: S.optionalKey(S.String),
    type: S.String,
    children: S.optionalKey(S.Array(S.suspend((): S.Codec<Node> => Node))),
    content: S.optionalKey(Content),
    size: S.optionalKey(Size),
    active: S.optionalKey(S.String),
    closable: S.optionalKey(S.Boolean),
  }),
  Rest,
)

const Tab = S.StructWithRest(S.Struct({ id: S.String, name: S.String, root: Node }), Rest)
type Tab = typeof Tab.Type

const SharedSpace = S.StructWithRest(
  S.Struct({ id: S.String, name: S.String, folder: S.String, tabs: S.Array(Tab) }),
  Rest,
)
type SharedSpace = typeof SharedSpace.Type

export const LayoutDoc = S.StructWithRest(S.Struct({ spaces: S.Array(SharedSpace) }), Rest)
export type LayoutDoc = typeof LayoutDoc.Type

/**
 * The spaces as the page shows them: each tab's tree reduced to its splits
 * and panes. A node or a pane content the page does not know shows as unknown.
 */
export const spacesOf = (doc: LayoutDoc): ReadonlyArray<Space> =>
  Array.map(doc.spaces, ({ id, name, folder, tabs }) => ({
    id,
    name,
    folder,
    tabs: Array.map(tabs, (tab) => ({ id: tab.id, name: tab.name, root: layoutOf(tab.root) })),
  }))

/** A layout without a pane or tab, and the terminals it showed there. */
export type Closed = Readonly<{ doc: LayoutDoc; terminals: ReadonlyArray<string> }>

/**
 * Puts a new terminal pane after `pane`, along `direction`. A parent that
 * already runs that way takes it, and the new pane takes half of the pane's
 * share; else a new container of id `container` takes the pane's place and
 * share, and holds the two. None when no tab holds the pane.
 */
export const split = (doc: LayoutDoc, at: Readonly<{ pane: string; direction: Direction; newPane: string; container: string; terminal: string }>) => {
  const type = at.direction === "right" ? "row" : "column"
  const block: Node = { id: at.newPane, type: "block", content: { terminal: at.terminal } }
  return editTab(doc, at.pane, (tab) => ({ ...tab, root: splitIn(tab.root, at.pane, type, block, at.container) }))
}

/**
 * Takes a pane out of its tab, with the terminals it showed. Its share goes to
 * the pane before it, else the one after; a row or column left with one child
 * gives way to it. A tab left with no pane closes, as `closeTab` does. None
 * when no tab holds the pane, or herdr-app marks it not closable.
 */
export const closePane = (doc: LayoutDoc, pane: string): Option.Option<Closed> =>
  Option.flatMap(findTab(doc, pane), ({ tab }) =>
    Option.flatMap(
      Option.filter(findNode(tab.root, pane), ({ closable }) => closable !== false),
      (node) =>
        Array.length(panesIn(tab.root)) === 1
          ? closeTab(doc, tab.id)
          : Option.map(editTab(doc, pane, (found) => ({ ...found, root: collapse(removeIn(found.root, pane)) })), (edited) => ({
              doc: edited,
              terminals: terminalsIn(node),
            })),
    ),
  )

/**
 * Takes a tab out of its space, with its terminals. None when no space holds
 * the tab, or it is the space's last: that closes the space, which herdr-app
 * does only once the user confirms it in the window.
 */
export const closeTab = (doc: LayoutDoc, tab: string): Option.Option<Closed> =>
  Option.map(
    Array.findFirst(doc.spaces, (space) => space.tabs.length > 1 && Array.some(space.tabs, ({ id }) => id === tab)),
    (space): Closed => {
      const kept = Array.filter(space.tabs, ({ id }) => id !== tab)
      const closed = Array.filter(space.tabs, ({ id }) => id === tab)
      return {
        doc: { ...doc, spaces: Array.map(doc.spaces, (other) => (other.id === space.id ? { ...other, tabs: kept } : other)) },
        terminals: Array.flatMap(closed, ({ root }) => terminalsIn(root)),
      }
    },
  )

/**
 * Adds a tab with one terminal pane at the end of the space. herdr-app puts a
 * new tab after the one its window shows, which only the window knows.
 */
export const newTab = (doc: LayoutDoc, at: Readonly<{ space: string; tab: string; pane: string; terminal: string }>): Option.Option<LayoutDoc> =>
  Option.map(
    Array.findFirst(doc.spaces, ({ id }) => id === at.space),
    () => ({
      ...doc,
      spaces: Array.map(doc.spaces, (space) =>
        space.id === at.space
          ? {
              ...space,
              tabs: Array.append(space.tabs, {
                id: at.tab,
                name: "",
                root: { id: at.tab, type: "row", children: [{ id: at.pane, type: "block", content: { terminal: at.terminal } }] },
              }),
            }
          : space,
      ),
    }),
  )

/** Adds a space at the end, with one tab that holds one terminal pane. */
export const newSpace = (
  doc: LayoutDoc,
  at: Readonly<{ space: string; name: string; folder: string; tab: string; pane: string; terminal: string }>,
): LayoutDoc => ({
  ...doc,
  spaces: Array.append(doc.spaces, {
    id: at.space,
    name: at.name.trim(),
    folder: at.folder,
    tabs: [{ id: at.tab, name: "", root: { id: at.tab, type: "row", children: [{ id: at.pane, type: "block", content: { terminal: at.terminal } }] } }],
  }),
})

/** Names a space; an empty name shows the space by its folder. None when there is no such space. */
export const renameSpace = (doc: LayoutDoc, space: string, name: string): Option.Option<LayoutDoc> =>
  Option.map(
    Array.findFirst(doc.spaces, ({ id }) => id === space),
    () => ({ ...doc, spaces: Array.map(doc.spaces, (one) => (one.id === space ? { ...one, name: name.trim() } : one)) }),
  )

/** Takes a space out, with the terminals of all its tabs. None when there is no such space. */
export const closeSpace = (doc: LayoutDoc, space: string): Option.Option<Closed> =>
  Option.map(
    Array.findFirst(doc.spaces, ({ id }) => id === space),
    (closed): Closed => ({
      doc: { ...doc, spaces: Array.filter(doc.spaces, ({ id }) => id !== space) },
      terminals: Array.flatMap(closed.tabs, ({ root }) => terminalsIn(root)),
    }),
  )

/** Moves a space to where `onto` is now: after it when moving down, before it when moving up. */
export const moveSpace = (doc: LayoutDoc, space: string, onto: string): Option.Option<LayoutDoc> =>
  Option.flatMap(
    Option.all([Array.findFirstIndex(doc.spaces, ({ id }) => id === space), Array.findFirstIndex(doc.spaces, ({ id }) => id === onto)]),
    ([from, to]) =>
      Option.flatMap(Array.get(doc.spaces, from), (moved) =>
        Option.map(Array.insertAt(Array.remove(doc.spaces, from), to, moved), (spaces) => ({ ...doc, spaces })),
      ),
  )

/** The space and tab that hold a node, by its id. */
export const findTab = (doc: LayoutDoc, node: string): Option.Option<Readonly<{ space: SharedSpace; tab: Tab }>> =>
  pipe(
    Array.flatMap(doc.spaces, (space) => Array.map(space.tabs, (tab) => ({ space, tab }))),
    Array.findFirst(({ tab }) => Option.isSome(findNode(tab.root, node))),
  )

/** The terminal a pane shows. */
export const terminalOf = (doc: LayoutDoc, pane: string): Option.Option<string> =>
  Option.flatMap(
    Option.flatMap(findTab(doc, pane), ({ tab }) => findNode(tab.root, pane)),
    ({ content }) => Option.fromUndefinedOr(content?.terminal),
  )

/** A new id as herdr-app makes them: a prefix (`p` pane, `tb` tab, `s` split, `sp` space) and 32 hex digits. */
export const freshId = (prefix: "p" | "tb" | "s" | "sp") => `${prefix}${crypto.randomUUID().replaceAll("-", "")}`

const editTab = (doc: LayoutDoc, node: string, edit: (tab: Tab) => Tab): Option.Option<LayoutDoc> =>
  Option.map(findTab(doc, node), ({ tab }) => ({
    ...doc,
    spaces: Array.map(doc.spaces, (space) => ({ ...space, tabs: Array.map(space.tabs, (other) => (other.id === tab.id ? edit(other) : other)) })),
  }))

const splitIn = (node: Node, target: string, type: string, block: Node, container: string): Node =>
  Option.match(Option.fromUndefinedOr(node.children), {
    onNone: () => node,
    onSome: (children) => ({
      ...node,
      children: Option.match(
        Array.findFirstIndex(children, ({ id }) => id === target),
        {
          onNone: () => Array.map(children, (child) => splitIn(child, target, type, block, container)),
          onSome: (index) =>
            node.type === type
              ? Array.flatMap(children, (child, i) => (i === index ? halved(child, block) : [child]))
              : Array.map(children, (child, i) => (i === index ? wrapped(child, type, block, container) : child)),
        },
      ),
    }),
  })

// The pane keeps half its weight and the new one takes the other half. A pane
// of fixed pixels keeps its pixels, and the new one takes half an even share.
const halved = (pane: Node, block: Node): ReadonlyArray<Node> => {
  const half = { weight: Option.getOrElse(weightOf(pane.size), () => 1) / 2 }
  return [Option.isSome(weightOf(pane.size)) ? { ...pane, size: half } : pane, { ...block, size: half }]
}

/** A container in the pane's place, with the pane's share, that holds the pane and then the new block. */
const wrapped = (pane: Node, type: string, block: Node, container: string): Node => {
  const { size, ...rest } = pane
  const wrapper: Node = { id: container, type, children: [rest, block] }
  return size === undefined ? wrapper : { ...wrapper, size }
}

const removeIn = (node: Node, target: string): Node =>
  Option.match(Option.fromUndefinedOr(node.children), {
    onNone: () => node,
    onSome: (children) =>
      Option.match(
        Array.findFirstIndex(children, ({ id }) => id === target),
        {
          onNone: () => ({ ...node, children: Array.map(children, (child) => removeIn(child, target)) }),
          onSome: (index) => (node.type === "stack" ? removedFromStack(node, children, index) : removedFromLine(node, children, index)),
        },
      ),
  })

// The child that slides into its place, else the last, shows next.
const removedFromStack = (stack: Node, children: ReadonlyArray<Node>, index: number): Node => {
  const left = Array.remove(children, index)
  const next = Option.flatMap(Option.orElse(Array.get(left, index), () => Array.last(left)), ({ id }) => Option.fromUndefinedOr(id))
  const { active: _, ...rest } = stack
  return Option.match(
    Option.filter(next, () => stack.active === children[index]?.id),
    {
      onNone: () => ({ ...stack, children: left }),
      onSome: (active) => ({ ...rest, children: left, active }),
    },
  )
}

// Its share goes back to the neighbor it was split from: the one before it, else the next.
const removedFromLine = (line: Node, children: ReadonlyArray<Node>, index: number): Node => {
  const gone = Option.flatMap(Array.get(children, index), ({ size }) => weightOf(size))
  const heir = Math.max(index - 1, 0)
  return {
    ...line,
    children: Array.map(Array.remove(children, index), (child, i) =>
      Option.match(
        Option.zipWith(gone, i === heir ? weightOf(child.size) : Option.none(), (a, b) => a + b),
        { onNone: () => child, onSome: (weight) => ({ ...child, size: { weight } }) },
      ),
    ),
  }
}

/** A share as a weight: none for fixed pixels, an even share for no size. */
const weightOf = (size: Size | undefined): Option.Option<number> =>
  size === undefined ? Option.some(1) : size.px === undefined ? Option.some(size.weight ?? 1) : Option.none()

// A stack's children are tabs and stay. Elsewhere an emptied row or column
// goes, and one left with one child gives way to it, which takes its share.
const collapse = (node: Node): Node =>
  Option.match(Option.fromUndefinedOr(node.children), {
    onNone: () => node,
    onSome: (children) => {
      const collapsed = Array.map(children, collapse)
      return {
        ...node,
        children: node.type === "stack" ? collapsed : Array.getSomes(Array.map(collapsed, givenWay)),
      }
    },
  })

const givenWay = (child: Node): Option.Option<Node> => {
  if (child.type !== "row" && child.type !== "column") return Option.some(child)
  const children = child.children ?? []
  return Array.match(children, {
    onEmpty: () => Option.none(),
    onNonEmpty: ([only, ...more]) => {
      if (Array.isReadonlyArrayNonEmpty(more)) return Option.some(child)
      const { size: _, ...rest } = only
      return Option.some(child.size === undefined ? rest : { ...rest, size: child.size })
    },
  })
}

const findNode = (node: Node, id: string): Option.Option<Node> =>
  node.id === id ? Option.some(node) : Array.findFirst(node.children ?? [], (child) => findNode(child, id))

const panesIn = (node: Node): ReadonlyArray<Node> => (node.type === "block" ? [node] : Array.flatMap(node.children ?? [], panesIn))

const terminalsIn = (node: Node): ReadonlyArray<string> =>
  Array.flatMap(panesIn(node), ({ content }) => Option.toArray(Option.fromUndefinedOr(content?.terminal)))

const layoutOf = (node: Node): Layout =>
  node.type === "block"
    ? { _tag: "Block", type: "block", id: node.id ?? "", size: sizeOf(node.size), content: contentOf(node.content) }
    : Option.match(Option.fromUndefinedOr(node.children), {
        onNone: (): Layout => ({ _tag: "Unknown", type: node.type }),
        onSome: (children): Layout => ({ _tag: "Split", type: node.type, id: node.id ?? "", size: sizeOf(node.size), children: Array.map(children, layoutOf) }),
      })

const sizeOf = (size: Size | undefined) => Option.map(Option.fromUndefinedOr(size), ({ weight }) => ({ weight: Option.fromUndefinedOr(weight) }))

const contentOf = (content: typeof Content.Type | undefined): PaneContent =>
  content?.terminal !== undefined
    ? { _tag: "Terminal", terminal: content.terminal }
    : content?.mod !== undefined
      ? { _tag: "Mod", mod: content.mod }
      : { _tag: "Unknown" }
