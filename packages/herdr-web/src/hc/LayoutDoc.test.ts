import { describe, expect, test } from "vitest"
import { Option, Schema } from "effect"
import { closePane, closeSpace, closeTab, LayoutDoc, moveSpace, newSpace, newTab, type Node, renameSpace, spacesOf, split } from "./LayoutDoc.ts"

const decode = Schema.decodeUnknownSync(LayoutDoc)
const encode = Schema.encodeSync(LayoutDoc)

const pane = (id: string, size?: Node["size"]): Node => {
  const block: Node = { id, type: "block", content: { terminal: `t-${id}` } }
  return size === undefined ? block : { ...block, size }
}

const docWith = (root: Node, more: Partial<Node> = {}): LayoutDoc =>
  decode({ spaces: [{ id: "w1", name: "", folder: "/src", tabs: [{ id: "tb1", name: "", root: { ...root, ...more } }] }] })

const rootOf = (doc: Option.Option<LayoutDoc>) => Option.map(doc, ({ spaces }) => spaces[0]?.tabs[0]?.root)

const withSecondTab = (doc: LayoutDoc): LayoutDoc => ({
  ...doc,
  spaces: doc.spaces.map((space) => ({
    ...space,
    tabs: [...space.tabs, { id: "tb2", name: "", root: { id: "tb2", type: "row", children: [pane("b")] } }],
  })),
})

describe("LayoutDoc", () => {
  test("keeps the fields herdr-app adds that the bridge does not know", () => {
    const wire = {
      spaces: [
        {
          id: "w1",
          name: "web",
          folder: "/src",
          color: "teal",
          tabs: [
            {
              id: "tb1",
              name: "",
              root: {
                id: "tb1",
                type: "row",
                gap: 4,
                children: [
                  { id: "p1", type: "block", content: { terminal: "t1" }, border: { width: 1 } },
                  { id: "p2", type: "block", content: { mod: "board", props: { file: "x" } }, size: { px: 300 } },
                ],
              },
            },
          ],
        },
      ],
      version: 3,
    }
    expect(encode(decode(wire))).toEqual(wire)
  })

  // Hand-written: no herdr-app command makes a stack, and the other shapes are
  // ones herdr-app may add.
  test("shows the page a tree with nodes, contents and sizes it does not know", () => {
    const doc = docWith({
      type: "stack",
      id: "s1",
      children: [
        { type: "block", id: "p1", content: { terminal: "t1" }, size: { fixed: 20 } },
        { type: "block", id: "p2", content: { mod: "board", props: { file: "x" } } },
        { type: "block", id: "p3", content: { url: "https://example.com" } },
        { type: "browser", id: "p4" },
      ],
    })
    expect(spacesOf(doc)[0]?.tabs[0]?.root).toEqual({
      _tag: "Split",
      type: "stack",
      id: "s1",
      size: Option.none(),
      children: [
        { _tag: "Block", type: "block", id: "p1", size: Option.some({ weight: Option.none() }), content: { _tag: "Terminal", terminal: "t1" } },
        { _tag: "Block", type: "block", id: "p2", size: Option.none(), content: { _tag: "Mod", mod: "board" } },
        { _tag: "Block", type: "block", id: "p3", size: Option.none(), content: { _tag: "Unknown" } },
        { _tag: "Unknown", type: "browser" },
      ],
    })
  })

  test("a split along the parent's way halves the pane's share", () => {
    const doc = docWith({ id: "r", type: "row", children: [pane("a", { weight: 0.5 }), pane("b", { weight: 0.5 })] })
    expect(rootOf(split(doc, { pane: "a", direction: "right", newPane: "n", container: "s", terminal: "tn" }))).toEqual(
      Option.some({
        id: "r",
        type: "row",
        children: [pane("a", { weight: 0.25 }), { id: "n", type: "block", content: { terminal: "tn" }, size: { weight: 0.25 } }, pane("b", { weight: 0.5 })],
      }),
    )
  })

  test("a split across the parent's way wraps the pane, which gives its share to the wrapper", () => {
    const doc = docWith({ id: "r", type: "row", children: [pane("a", { weight: 0.5 }), pane("b", { weight: 0.5 })] })
    expect(rootOf(split(doc, { pane: "b", direction: "down", newPane: "n", container: "s", terminal: "tn" }))).toEqual(
      Option.some({
        id: "r",
        type: "row",
        children: [
          pane("a", { weight: 0.5 }),
          { id: "s", type: "column", size: { weight: 0.5 }, children: [pane("b"), { id: "n", type: "block", content: { terminal: "tn" } }] },
        ],
      }),
    )
  })

  test("closing a pane gives its share to the one before it, and a container left with one child gives way to it", () => {
    const doc = docWith({
      id: "r",
      type: "row",
      children: [pane("a", { weight: 0.5 }), { id: "s", type: "column", size: { weight: 0.5 }, children: [pane("b"), pane("c")] }],
    })
    const closed = closePane(doc, "c")
    expect(Option.map(closed, ({ terminals }) => terminals)).toEqual(Option.some(["t-c"]))
    expect(rootOf(Option.map(closed, ({ doc }) => doc))).toEqual(
      Option.some({ id: "r", type: "row", children: [pane("a", { weight: 0.5 }), pane("b", { weight: 0.5 })] }),
    )
  })

  test("closing the first pane gives its share to the next", () => {
    const doc = docWith({ id: "r", type: "row", children: [pane("a", { weight: 0.25 }), pane("b", { weight: 0.25 }), pane("c", { weight: 0.5 })] })
    expect(rootOf(Option.map(closePane(doc, "a"), ({ doc }) => doc))).toEqual(
      Option.some({ id: "r", type: "row", children: [pane("b", { weight: 0.5 }), pane("c", { weight: 0.5 })] }),
    )
  })

  test("closing a tab's last pane closes the tab", () => {
    const doc = withSecondTab(docWith({ id: "tb1", type: "row", children: [pane("a")] }))
    expect(Option.map(closePane(doc, "a"), ({ doc, terminals }) => [doc.spaces[0]?.tabs.map(({ id }) => id), terminals])).toEqual(
      Option.some([["tb2"], ["t-a"]]),
    )
  })

  test("a space's last tab stays: closing it would close the space, which herdr-app asks the user to confirm", () => {
    const doc = docWith({ id: "tb1", type: "row", children: [pane("a")] })
    expect(closeTab(doc, "tb1")).toEqual(Option.none())
    expect(closePane(doc, "a")).toEqual(Option.none())
  })

  test("a pane herdr-app marks not closable stays", () => {
    const doc = docWith({ id: "r", type: "row", children: [{ ...pane("a"), closable: false }, pane("b")] })
    expect(closePane(doc, "a")).toEqual(Option.none())
  })

  test("closing a tab leaves the space its other tabs", () => {
    const doc = withSecondTab(docWith({ id: "tb1", type: "row", children: [pane("a")] }))
    expect(Option.map(closeTab(doc, "tb1"), ({ doc, terminals }) => [doc.spaces[0]?.tabs.map(({ id }) => id), terminals])).toEqual(
      Option.some([["tb2"], ["t-a"]]),
    )
  })

  test("a new tab goes at the end of its space, with one pane", () => {
    const doc = docWith({ id: "tb1", type: "row", children: [pane("a")] })
    expect(Option.map(newTab(doc, { space: "w1", tab: "tb2", pane: "p2", terminal: "t2" }), ({ spaces }) => spaces[0]?.tabs[1])).toEqual(
      Option.some({ id: "tb2", name: "", root: { id: "tb2", type: "row", children: [{ id: "p2", type: "block", content: { terminal: "t2" } }] } }),
    )
  })

  test("a space moves to where the target was", () => {
    const doc = decode({ spaces: ["a", "b", "c"].map((id) => ({ id, name: "", folder: "/", tabs: [] })) })
    const order = (moved: Option.Option<LayoutDoc>) => Option.map(moved, ({ spaces }) => spaces.map(({ id }) => id))
    expect(order(moveSpace(doc, "a", "c"))).toEqual(Option.some(["b", "c", "a"]))
    expect(order(moveSpace(doc, "c", "a"))).toEqual(Option.some(["c", "a", "b"]))
  })

  test("a new space goes at the end, with one tab that holds one pane", () => {
    const doc = newSpace(docWith(pane("a")), { space: "sp2", name: " web ", folder: "/src/web", tab: "tb2", pane: "p2", terminal: "t2" })
    expect(doc.spaces[1]).toEqual({
      id: "sp2",
      name: "web",
      folder: "/src/web",
      tabs: [{ id: "tb2", name: "", root: { id: "tb2", type: "row", children: [{ id: "p2", type: "block", content: { terminal: "t2" } }] } }],
    })
  })

  test("a space takes a new name, trimmed", () => {
    expect(Option.map(renameSpace(docWith(pane("a")), "w1", "  api "), ({ spaces }) => spaces[0]?.name)).toEqual(Option.some("api"))
    expect(renameSpace(docWith(pane("a")), "w9", "api")).toEqual(Option.none())
  })

  test("closing a space ends the terminals of all its tabs", () => {
    const doc = withSecondTab(docWith({ id: "tb1", type: "row", children: [pane("a")] }))
    expect(Option.map(closeSpace(doc, "w1"), ({ doc, terminals }) => [doc.spaces, terminals])).toEqual(Option.some([[], ["t-a", "t-b"]]))
    expect(closeSpace(doc, "w9")).toEqual(Option.none())
  })
})
