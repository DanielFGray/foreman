import { describe, expect, test } from "vitest"
import { Option, Schema } from "effect"
import { Layout } from "./Fleet.ts"

const decode = Schema.decodeUnknownSync(Layout)
const block = (id: string, terminal: string, weight: Option.Option<number>): Layout => ({
  _tag: "Block",
  type: "block",
  id,
  size: Option.map(weight, (w) => ({ weight: Option.some(w) })),
  content: { _tag: "Terminal", terminal },
})

describe("Layout", () => {
  // herdr-app's document for a tab split right, then down.
  test("decodes a real split", async () => {
    const root = decode(await Bun.file(`${import.meta.dirname}/fixtures/layout.json`).json())
    expect(root).toMatchObject({
      _tag: "Split",
      type: "row",
      children: [
        { _tag: "Block", size: Option.some({ weight: Option.some(0.5) }), content: { _tag: "Terminal", terminal: "t2b" } },
        {
          _tag: "Split",
          type: "column",
          children: [
            { _tag: "Block", size: Option.none(), content: { _tag: "Terminal", terminal: "t2c" } },
            { _tag: "Block", size: Option.none(), content: { _tag: "Terminal", terminal: "t2d" } },
          ],
        },
      ],
    })
  })

  // Hand-written: no herdr-app command makes a stack, and the other shapes are
  // ones herdr-app may add.
  test("keeps a tree with nodes, contents and sizes it does not know", () => {
    const root = decode({
      type: "stack",
      id: "s1",
      children: [
        { type: "block", id: "p1", content: { terminal: "t1" }, size: { fixed: 20 } },
        { type: "block", id: "p2", content: { mod: "board", props: { file: "x" } } },
        { type: "block", id: "p3", content: { url: "https://example.com" } },
        { type: "browser", id: "p4" },
      ],
    })
    expect(root).toEqual({
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

  test("survives the trip from the bridge to the page", () => {
    const root: Layout = { _tag: "Split", type: "row", id: "r", size: Option.none(), children: [block("p1", "t1", Option.some(1))] }
    expect(Schema.decodeSync(Layout)(Schema.encodeSync(Layout)(root))).toEqual(root)
  })
})
