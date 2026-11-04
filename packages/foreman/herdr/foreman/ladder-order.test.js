import { expect, test } from "bun:test";
import { moveArgs, reviewerArgs } from "./ladder-order.js";

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

test("a worker dropped on Reviewers keeps its rung's thinking level", () => {
  const card = { kind: "worker", model: "opus", rung: { rung: "opus", thinking: "low" } };
  expect(reviewerArgs(card)).toEqual(["reviewers", "add", "opus", "--thinking", "low"]);
});

test("a rung with no level, or a Models card, passes no thinking level", () => {
  const worker = { kind: "worker", model: "auto", rung: { rung: "cursor", thinking: null } };
  expect(reviewerArgs(worker)).toEqual(["reviewers", "add", "auto"]);
  expect(reviewerArgs({ kind: "model", model: "opus" })).toEqual(["reviewers", "add", "opus"]);
});
