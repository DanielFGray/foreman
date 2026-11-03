import { Option } from "effect"
import { expect, test } from "vitest"
import { closest, floating } from "./drag.ts"

const box = (x: number, y: number) => ({ x, y, width: 20, height: 20 })

test("the nearest target within the radius is picked, and none outside every radius", () => {
  const targets = [
    { rect: box(0, 0), drop: "stay" },
    { rect: box(100, 0), drop: "move" },
  ]
  expect(Option.map(closest(targets, { x: 80, y: 10 }, 50), ({ drop }) => drop)).toEqual(Option.some("move"))
  expect(Option.map(closest(targets, { x: 30, y: 10 }, 50), ({ drop }) => drop)).toEqual(Option.some("stay"))
  expect(closest(targets, { x: 60, y: 200 }, 50)).toEqual(Option.none())
})

test("a floating element moves as far as the pointer", () => {
  expect(floating(box(10, 10), { x: 5, y: 5 }, { x: 25, y: -5 })).toEqual(box(30, 0))
})
