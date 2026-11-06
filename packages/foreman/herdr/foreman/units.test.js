import { expect, test } from "bun:test";
import { drawnAt } from "./units.js";

test("reported bounds become drawn lengths", () => {
  expect(drawnAt({ x: 6, y: 3, width: 300, height: 120 }, 0.6)).toEqual({ x: 10, y: 5, width: 500, height: 200 });
});

test("an absent value stays absent", () => {
  expect(drawnAt(null, 0.6)).toBeNull();
  expect(drawnAt(undefined, 0.6)).toBeUndefined();
});
