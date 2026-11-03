import { expect, test } from "bun:test";
import { moveArgs } from "./ladder-order.js";

const rungs = ["a", "b", "c", "d"];

test("a rung moved to place 0 goes to the bottom", () => {
  expect(moveArgs(rungs, "c", 0)).toEqual(["ladder", "move", "c"]);
});

test("a rung moved up goes above the rung that ends below it", () => {
  expect(moveArgs(rungs, "a", 2)).toEqual(["ladder", "move", "a", "--above", "c"]);
});

test("a rung moved down goes above the rung that ends below it", () => {
  expect(moveArgs(rungs, "d", 1)).toEqual(["ladder", "move", "d", "--above", "a"]);
});

test("a rung moved to the top goes above the last of the others", () => {
  expect(moveArgs(rungs, "b", 3)).toEqual(["ladder", "move", "b", "--above", "d"]);
});
