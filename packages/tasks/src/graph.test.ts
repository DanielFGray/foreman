import { describe, expect, test } from "bun:test";
import { columnsOf } from "./graph.ts";

const blocks = (dependsOn: string, item: string) => ({ item, dependsOn });

describe("columnsOf", () => {
  test("puts each item one column right of its furthest blocker", () => {
    // a blocks b and c; b blocks c, so c waits two columns out.
    const columns = columnsOf(
      ["a", "b", "c", "d"],
      [blocks("a", "b"), blocks("a", "c"), blocks("b", "c")],
    );
    expect(Object.fromEntries(columns)).toEqual({ a: 0, b: 1, c: 2, d: 0 });
  });

  test("leaves out an edge to an item that is not shown", () => {
    expect(Object.fromEntries(columnsOf(["b"], [blocks("gone", "b")]))).toEqual({ b: 0 });
  });

  test("gives every item of a cycle a finite column", () => {
    const columns = columnsOf(
      ["a", "b", "c"],
      [blocks("a", "b"), blocks("b", "c"), blocks("c", "a")],
    );
    expect([...columns.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(new Set(columns.values()).size).toBe(3);
  });
});
