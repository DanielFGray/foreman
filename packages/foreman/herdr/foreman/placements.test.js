import { describe, expect, test } from "bun:test";
import { byBlock } from "./placements.js";

describe("byBlock", () => {
  test("a task at an expanded id inside an instance is drawn on the instance", () => {
    const at = byBlock(
      [
        { key: "t1", stands: "checks.review", state: "running" },
        { key: "t2", stands: "inbox", state: "waiting" },
      ],
      [
        { id: "inbox" },
        { id: "checks", covers: ["checks.review-gate", "checks.review"] },
      ],
    );
    expect([...at.keys()].sort()).toEqual(["checks", "inbox"]);
    expect(at.get("checks").map((task) => task.key)).toEqual(["t1"]);
    expect(at.get("inbox").map((task) => task.key)).toEqual(["t2"]);
  });

  test("running tasks sort before waiting ones on the same block", () => {
    const at = byBlock(
      [
        { key: "b", stands: "author", state: "waiting" },
        { key: "a", stands: "author", state: "running" },
      ],
      [{ id: "author" }],
    );
    expect(at.get("author").map((task) => task.key)).toEqual(["a", "b"]);
  });
});
