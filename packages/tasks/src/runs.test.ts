import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAt } from "./connection.ts";
import {
  addRound,
  closeRun,
  deleteOpenRun,
  openRun,
  outcomeOf,
  runsOf,
  type NewRun,
} from "./runs.ts";

const dir = mkdtempSync(join(tmpdir(), "tasks-runs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
const inStore = <A, E>(use: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(use.pipe(Effect.provide(connectionAt(join(dir, `store-${++files}.db`)))));

const run = (over: Partial<NewRun> = {}): NewRun => ({
  project: "p",
  task: "ts-1",
  slice: "a slice",
  kind: "pi",
  pool: "Pool",
  model: "m1",
  rung: "cheap",
  node: "author",
  work: "build",
  ...over,
});

describe("runs", () => {
  test("a run is open until closed, and closes with its outcome and commit", async () => {
    const [open, closed] = await inStore(
      Effect.gen(function* () {
        const id = yield* openRun(run());
        const open = (yield* runsOf(["ts-1"])).get("ts-1");
        yield* closeRun(id, { ending: "handed-off", commit: "abc" });
        return [open, (yield* runsOf(["ts-1"])).get("ts-1")] as const;
      }),
    );
    expect(open?.map((r) => [r.open, r.ending, r.role])).toEqual([[true, undefined, "author"]]);
    expect(closed?.map((r) => [r.open, r.ending, r.commit])).toEqual([
      [false, "handed-off", "abc"],
    ]);
  });

  test("a review run keeps the tip it opened with when it closes", async () => {
    const runs = await inStore(
      Effect.gen(function* () {
        const id = yield* openRun(run({ work: "review", node: "review", commit: "tip1" }));
        yield* closeRun(id, { ending: "approved" });
        return (yield* runsOf(["ts-1"])).get("ts-1");
      }),
    );
    expect(runs?.[0]).toMatchObject({ role: "review", ending: "approved", commit: "tip1" });
  });

  test("runs read oldest first, per task", async () => {
    const byTask = await inStore(
      Effect.gen(function* () {
        yield* openRun(run({ rung: "a" }));
        yield* openRun(run({ task: "ts-2", rung: "x" }));
        yield* openRun(run({ rung: "b" }));
        return yield* runsOf(["ts-1", "ts-2", "ts-3"]);
      }),
    );
    expect(byTask.get("ts-1")?.map((r) => r.rung)).toEqual(["a", "b"]);
    expect(byTask.get("ts-2")?.map((r) => r.rung)).toEqual(["x"]);
    expect(byTask.has("ts-3")).toBe(false);
  });

  test("an open run that never started can be deleted, a closed one cannot", async () => {
    const result = await inStore(
      Effect.gen(function* () {
        const never = yield* openRun(run());
        yield* deleteOpenRun(never);
        const done = yield* openRun(run());
        yield* closeRun(done, { ending: "unfinished" });
        const refused = yield* deleteOpenRun(done).pipe(Effect.flip);
        return { left: (yield* runsOf(["ts-1"])).get("ts-1")?.length, refused: refused._tag };
      }),
    );
    expect(result).toEqual({ left: 1, refused: "RunError" });
  });

  test("rounds count on the open author run only", async () => {
    const counts = await inStore(
      Effect.gen(function* () {
        const author = yield* openRun(run());
        const review = yield* openRun(run({ work: "review" }));
        const first = yield* addRound(author);
        const second = yield* addRound(author);
        const refused = yield* addRound(review).pipe(Effect.flip);
        return [first, second, refused._tag];
      }),
    );
    expect(counts).toEqual([1, 2, "RunError"]);
  });

  test("the store refuses an ending its kind of run cannot have", async () => {
    const refused = await inStore(
      Effect.gen(function* () {
        const review = yield* openRun(run({ work: "review" }));
        return yield* closeRun(review, { ending: "landed" }).pipe(Effect.flip);
      }),
    );
    expect(refused._tag).toBe("SqlError");
  });

  test("a landing is an answer for research and a commit otherwise", () => {
    expect(outcomeOf("landed", true)).toBe("answered");
    expect(outcomeOf("landed", false)).toBe("committed");
    expect(outcomeOf("canceled", false)).toBe("dropped");
    expect(outcomeOf("approved", false)).toBe("handed-off");
  });
});
