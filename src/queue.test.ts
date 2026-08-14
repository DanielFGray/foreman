import { describe, expect, test } from "bun:test";
import { interleave } from "./queue.ts";
import type { ReadyTask } from "./prog.ts";

const task = (id: string, project: string, priority: number): ReadyTask => ({
  id,
  project,
  priority,
  title: id,
  labels: [],
});

describe("interleave", () => {
  test("never rotates lower-priority work ahead", () => {
    const result = interleave([task("a1", "a", 1), task("a2", "a", 1), task("b2", "b", 2)]);

    expect(result.map(({ id }) => id)).toEqual(["a1", "a2", "b2"]);
  });

  test("rotates projects within a priority", () => {
    const result = interleave([
      task("a1", "a", 1),
      task("a2", "a", 1),
      task("b1", "b", 1),
      task("b2", "b", 1),
    ]);

    expect(result.map(({ id }) => id)).toEqual(["a1", "b1", "a2", "b2"]);
  });

  test("keeps only configured projects from the global ready set", () => {
    const result = interleave(
      [task("a1", "a", 1), task("b1", "b", 1), task("c1", "c", 1)],
      ["a", "c"],
    );

    expect(result.map(({ id }) => id)).toEqual(["a1", "c1"]);
  });
});
