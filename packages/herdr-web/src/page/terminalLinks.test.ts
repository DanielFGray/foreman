import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { cellAt, type Pointer, pointedAt, webAddress } from "./terminalLinks.ts"

test("only an http or https address may open", () => {
  expect([webAddress("https://example.com/a b"), webAddress("http://x.test"), webAddress("javascript:alert(1)"), webAddress("file:///etc/passwd"), webAddress("not a url")]).toEqual([
    Option.some("https://example.com/a%20b"),
    Option.some("http://x.test/"),
    Option.none(),
    Option.none(),
    Option.none(),
  ])
})

describe("cellAt", () => {
  // 80×24 cells of 10×20 px, at (100, 50) on the page, with 200 lines of scrollback.
  const grid = { left: 100, top: 50, width: 800, height: 480, cols: 80, rows: 24, viewportY: 0, scrollback: 200 }

  test("a point on the screen is the cell under it, its row counted from the top of the scrollback", () => {
    expect(cellAt(grid, { x: 105, y: 55 })).toEqual(Option.some({ x: 0, y: 200 }))
    expect(cellAt(grid, { x: 899, y: 529 })).toEqual(Option.some({ x: 79, y: 223 }))
  })

  test("scrolled back, the screen shows rows further up", () => {
    expect(cellAt({ ...grid, viewportY: 30.5 }, { x: 105, y: 55 })).toEqual(Option.some({ x: 0, y: 170 }))
  })

  test("a canvas the stylesheet scales to half size maps the same cells", () => {
    expect(cellAt({ ...grid, width: 400, height: 240 }, { x: 102.5, y: 52.5 })).toEqual(Option.some({ x: 0, y: 200 }))
  })

  test("a point off the canvas is no cell", () => {
    expect([cellAt(grid, { x: 99, y: 60 }), cellAt(grid, { x: 900, y: 60 }), cellAt(grid, { x: 120, y: 530 })]).toEqual([Option.none(), Option.none(), Option.none()])
  })
})

describe("pointedAt", () => {
  const down: Pointer = { _tag: "Down", id: 1, x: 10, y: 10, at: 0 }
  const up = (change: Partial<Pointer>): Pointer => ({ _tag: "Up", id: 1, x: 12, y: 14, at: 120, ...change })

  test("a touch that ends near where it began, soon after, is a tap where it ended", () => {
    expect(pointedAt(Option.some(down), up({}))).toEqual(Option.some(up({})))
  })

  test("a touch that moves, lasts, or is another finger's is no tap", () => {
    expect([
      pointedAt(Option.some(down), up({ y: 60 })),
      pointedAt(Option.some(down), up({ at: 900 })),
      pointedAt(Option.some(down), up({ id: 2 })),
      pointedAt(Option.none(), up({})),
    ]).toEqual([Option.none(), Option.none(), Option.none(), Option.none()])
  })

  test("a Ctrl or Cmd click points where it is", () => {
    const click: Pointer = { _tag: "Click", id: 0, x: 40, y: 40, at: 5 }
    expect(pointedAt(Option.none(), click)).toEqual(Option.some(click))
  })
})
