import { expect, mock, test } from "bun:test";

// columns.js draws with herdr-app's element builders; scrolling needs none of them.
mock.module("gpui-kit", () => ({ div: () => ({}) }));
mock.module("gpui-base", () => ({ h_flex: () => ({}) }));
const { scrolledBy } = await import("./columns.js");

const wheel = (x, dy) => ({ delta: { x: 0, y: dy }, position: { x, y: 100 }, bounds: { x: 0, y: 0 } });

test("a wheel scrolls the column under the pointer", () => {
  const layout = { xs: [0, 100], columnW: 90, overflow: 0, reach: [50, 50] };
  expect(scrolledBy({ x: 0, y: [0, 0] }, wheel(120, 30), layout).y).toEqual([0, 30]);
});

test("a wheel over a column drawn on top of another scrolls the one on top", () => {
  // The second column is pinned over the first, which has scrolled under it.
  const layout = { xs: [100, 100], columnW: 90, overflow: 0, reach: [0, 500] };
  expect(scrolledBy({ x: 0, y: [0, 0] }, wheel(120, 30), layout).y).toEqual([0, 30]);
});
