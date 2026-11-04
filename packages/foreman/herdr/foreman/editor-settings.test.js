import { describe, expect, test } from "bun:test";
import { changedSettings } from "./editor-settings.js";

describe("changedSettings", () => {
  const drafted = { kind: "source", id: "queue", filter: "label:bug", next: "branch" };
  test("a discard that drops a source's filter empties the filter input", () =>
    expect(changedSettings(drafted, { ...drafted, filter: "" })).toEqual([["filter", ""]]));
  test("a reading that keeps every setting refills nothing, so unsent text stays", () =>
    expect(changedSettings(drafted, { ...drafted, next: "worktree" })).toEqual([]));
});
