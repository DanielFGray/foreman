import { Option } from "effect"
import { expect, test } from "vitest"
import { init, update } from "./main.ts"
import { Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { keyedSidebarWidth } from "./sidebarWidth.ts"

const start = init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model

test("a drag moves the sidebar's edge with the pointer, keeps its grip, and is kept on release", () => {
  // Taken 2px right of the edge at its default 340, then moved 100px right.
  const held = update(start, Message.PressedSidebarEdge({ x: 342 })).model
  const moved = update(held, Message.MovedSidebarEdge({ x: 442 })).model
  expect(moved.sidebarWidth).toStrictEqual(Option.some(440))
  expect(update(held, Message.MovedSidebarEdge({ x: 5000 })).model.sidebarWidth).toStrictEqual(Option.some(560))
  const released = update(moved, Message.ReleasedSidebarEdge())
  expect(released.commands).toMatchObject([{ name: "SaveSidebarWidth", args: { width: Option.some(440) } }])
  // Once let go, the pointer moves nothing.
  expect(update(released.model, Message.MovedSidebarEdge({ x: 300 })).model.sidebarWidth).toStrictEqual(Option.some(440))
})

test("the edge's keys step it, go to its limits, and leave other keys alone", () => {
  expect(keyedSidebarWidth(340, "ArrowLeft")).toStrictEqual(Option.some(324))
  expect(keyedSidebarWidth(200, "ArrowLeft")).toStrictEqual(Option.some(200))
  expect(keyedSidebarWidth(340, "End")).toStrictEqual(Option.some(560))
  expect(keyedSidebarWidth(340, "Enter")).toStrictEqual(Option.none())
})
