import { describe, expect, test } from "bun:test";
import { changedSettings, instructionsOf } from "./editor-settings.js";

describe("changedSettings", () => {
  const drafted = { kind: "source", id: "queue", filter: "label:bug", next: "branch" };
  test("a discard that drops a source's filter empties the filter input", () =>
    expect(changedSettings(drafted, { ...drafted, filter: "" })).toEqual([["filter", ""]]));
  test("a reading that keeps every setting refills nothing, so unsent text stays", () =>
    expect(changedSettings(drafted, { ...drafted, next: "worktree" })).toEqual([]));
  test("a land shows the branch it lands onto, and an empty input for none", () => {
    const land = { kind: "land", id: "land", how: "merge" };
    expect(changedSettings(land, { ...land, onto: "develop" })).toEqual([["onto", "develop"]]);
    expect(changedSettings({ ...land, onto: "develop" }, land)).toEqual([["onto", ""]]);
  });
});

describe("instructionsOf", () => {
  test("an agent reads the instructions it names, else its role's, and another block reads none", () => {
    expect(instructionsOf({ kind: "agent", role: "review", instructions: "careful" })).toBe("careful");
    expect(instructionsOf({ kind: "agent", role: "review" })).toBe("review");
    expect(instructionsOf({ kind: "check", command: "true" })).toBeUndefined();
    expect(instructionsOf(undefined)).toBeUndefined();
  });
});
