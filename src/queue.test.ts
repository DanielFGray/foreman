import { describe, expect, test } from "bun:test";
import { interleave } from "./queue.ts";
import type { ReadyTask } from "./prog.ts";

const now = new Date("2026-08-14T00:00:00Z");

const task = (id: string, project: string, priority: number, lastActivityAt = now): ReadyTask => ({
  id,
  project,
  priority,
  title: id,
  labels: [],
  last_activity_at: lastActivityAt,
});

describe("interleave", () => {
  test("never rotates lower-priority work ahead", () => {
    const result = interleave(
      [task("a1", "a", 1), task("a2", "a", 1), task("b2", "b", 2)],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["a1", "a2", "b2"]);
  });

  test("rotates projects within a priority", () => {
    const result = interleave(
      [task("a1", "a", 1), task("a2", "a", 1), task("b1", "b", 1), task("b2", "b", 1)],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["a1", "b1", "a2", "b2"]);
  });

  test("keeps only configured projects from the global ready set", () => {
    const result = interleave(
      [task("a1", "a", 1), task("b1", "b", 1), task("c1", "c", 1)],
      ["a", "c"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["a1", "c1"]);
  });

  test("ages waiting tasks within the bounded score", () => {
    const result = interleave(
      [task("new-high", "a", 1), task("old-medium", "b", 2, new Date("2026-08-04T00:00:00Z"))],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["old-medium", "new-high"]);
  });

  test("does not let aging outrank fresh high priority work past the cap", () => {
    const result = interleave(
      [task("new-high", "a", 1), task("old-low", "b", 3, new Date("2026-07-01T00:00:00Z"))],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["new-high", "old-low"]);
  });

  test("rotates projects across nearby continuous scores", () => {
    const result = interleave(
      [task("a1", "a", 1), task("a2", "a", 1.1), task("b1", "b", 1.2), task("b2", "b", 1.3)],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["a1", "b1", "a2", "b2"]);
  });
});
