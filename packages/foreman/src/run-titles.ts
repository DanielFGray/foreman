import { Effect, Option } from "effect";
import type { RunRecord } from "tasks";
import type { Tracker } from "./tracker.ts";

type TrackerReads = Pick<Tracker["Service"], "list" | "lookup">;

/** Reads titles for run tasks that are absent from a tracker's active snapshot. */
export const runTitles = (tracker: TrackerReads, project: string, runs: ReadonlyArray<RunRecord>) =>
  Effect.gen(function* () {
    const listed = yield* tracker.list({ project });
    const titles = new Map(listed.map((task) => [task.id, task.title] as const));
    const missing = [...new Set(runs.map((run) => run.task))].filter((task) => !titles.has(task));
    const lookedUp = yield* Effect.forEach(missing, (task) =>
      tracker.lookup(task).pipe(Effect.map(Option.map((item) => [task, item.title] as const))),
    );
    for (const title of lookedUp)
      yield* Option.match(title, {
        onNone: () => Effect.void,
        onSome: ([task, name]) => Effect.sync(() => titles.set(task, name)).pipe(Effect.asVoid),
      });
    return titles;
  });
