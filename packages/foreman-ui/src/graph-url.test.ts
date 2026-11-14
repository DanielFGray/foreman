import { assert, describe, it } from "@effect/vitest";
import {
  graphSearchOf,
  graphStateOf,
  searchOf,
  toggleFold,
  togglePick,
  toggleStatus,
} from "./graph-url.ts";

describe("graph URL state", () => {
  it("shows open and claimed work, with nothing folded, searched or picked, on an empty query", () => {
    const state = graphStateOf({});
    assert.deepStrictEqual(state.statuses, ["open", "in_progress"]);
    assert.strictEqual(state.query, "");
    assert.strictEqual(state.folded.size, 0);
    assert.deepStrictEqual(state.picked, []);
    assert.deepStrictEqual(searchOf(state), {});
  });

  it("round-trips every field", () => {
    const search = { status: "open,done", q: "graph view", fold: "ep-1,ep-2", pick: "ts-1,ts-2" };
    const state = graphStateOf(search);
    assert.deepStrictEqual(state.statuses, ["open", "done"]);
    assert.strictEqual(state.query, "graph view");
    assert.deepStrictEqual([...state.folded], ["ep-1", "ep-2"]);
    assert.deepStrictEqual(state.picked, ["ts-1", "ts-2"]);
    assert.deepStrictEqual(searchOf(state), search);
  });

  it("drops an unknown status and keeps the order TaskState lists", () => {
    assert.deepStrictEqual(graphStateOf({ status: "done,bogus,open" }).statuses, ["open", "done"]);
  });

  it("keeps only the graph's own string keys of a parsed query", () => {
    assert.deepStrictEqual(graphSearchOf({ q: "123", pick: "a", other: "x", fold: ["a", "b"] }), {
      q: "123",
      pick: "a",
    });
  });

  it("toggles a status in order, a fold, and a pick to the end of the list", () => {
    const start = graphStateOf({ pick: "a" });
    assert.deepStrictEqual(toggleStatus(start, "proposed").statuses, [
      "proposed",
      "open",
      "in_progress",
    ]);
    assert.deepStrictEqual(toggleStatus(start, "open").statuses, ["in_progress"]);
    assert.isTrue(toggleFold(start, "ep").folded.has("ep"));
    assert.isFalse(toggleFold(toggleFold(start, "ep"), "ep").folded.has("ep"));
    assert.deepStrictEqual(togglePick(start, "b").picked, ["a", "b"]);
    assert.deepStrictEqual(togglePick(start, "a").picked, []);
  });
});
