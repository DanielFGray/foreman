import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { Item as TaskItem, type RunRecord } from "tasks";
import { runTitles } from "./run-titles.ts";

const run: RunRecord = {
  id: 1,
  project: "demo",
  task: "demo#7",
  work: "build",
  rung: Option.none(),
  model: Option.none(),
  node: Option.none(),
  commit: Option.none(),
  ending: Option.some("done"),
  outcome: Option.some("committed"),
  rounds: Option.none(),
  notes: Option.none(),
  startedAt: Option.none(),
  closedAt: Option.some(new Date("2026-01-01T00:00:00.000Z")),
  costUsd: Option.none(),
};

const closed = new TaskItem({
  id: run.task,
  project: "demo",
  type: "task",
  title: "Closed task title",
  description: "",
  definitionOfDone: Option.none(),
  status: "done",
  priority: 2,
  parent: Option.none(),
  labels: [],
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
});

describe("runTitles", () => {
  test("looks up a closed task missing from the active list", async () => {
    const titles = await Effect.runPromise(
      runTitles(
        {
          list: () => Effect.succeed([]),
          lookup: () => Effect.succeedSome(closed),
        },
        "demo",
        [run],
      ),
    );

    expect(titles.get(run.task)).toBe("Closed task title");
  });
});
