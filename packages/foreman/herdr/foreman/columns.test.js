import { expect, mock, test } from "bun:test";

// columns.js draws with herdr-app's element builders; scrolling needs none of them.
mock.module("gpui-kit", () => ({ div: () => ({}) }));
mock.module("gpui-base", () => ({ h_flex: () => ({}) }));
const { scrolledBy } = await import("./columns.js");

// A wheel at window x `x`, carrying no bounds, as herdr-app may send it.
const wheel = (x, dy) => ({ delta: { x: 0, y: dy }, position: { x, y: 100 } });

test("a wheel scrolls the column under the pointer, measured from the view's origin", () => {
  // The view starts 300 px into the window, so window x 420 is view x 120: the second column.
  const layout = { xs: [0, 100], columnW: 90, overflow: 0, reach: [50, 50] };
  expect(scrolledBy({ x: 0, y: [0, 0] }, wheel(420, 30), layout, { x: 300 }).y).toEqual([0, 30]);
});
