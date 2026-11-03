import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { Run } from "tasks";
import { connectionAt, nameExit, store, Tasks } from "tasks";
import {
  authoredBy,
  claimsAlreadyDone,
  lapOf,
  lastExit,
  reviewedBy,
  reviewerNamed,
  reviewFailedBy,
  roundsOf,
  routedCommit,
} from "./lap.ts";
import { place, STANDARD_PIPELINE } from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";
import { Records } from "./records.ts";
import { Tracker } from "./tracker.ts";
import { newRunFor } from "./run-record.ts";
import { authorRun, authorDone, reviewRun } from "./task-fixture.ts";

/** The block a reviewing task with these runs stands at on the standard pipeline. */
const blockOf = (runs: ReadonlyArray<Run>, tip: string | undefined) => {
  const placement = place(
    STANDARD_PIPELINE,
    factsOf(
      { status: "in_progress", priority: 2, parent: undefined, labels: [], runs, charges: [], tip },
      STANDARD_PIPELINE,
    ),
  );
  return placement._tag === "At" ? placement.node.id : placement._tag;
};

describe("a task's lap", () => {
  test("a land takes the commit of the exit that routed it there", () => {
    const runs = [
      authorDone("low", "c1"),
      reviewRun("mid", { open: false, ending: "approved", commit: "c1" }),
    ];

    expect(routedCommit({ runs })).toBe("c1");
    expect(blockOf(runs, "c1")).toBe("land");
    // A commit after the approval voids it.
    expect(blockOf(runs, "c2")).toBe("review");
  });

  test("an approval followed by a return is a return", () => {
    const runs = [
      authorDone("low", "c1"),
      reviewRun("mid", { open: false, ending: "approved", commit: "c1" }),
      reviewRun("mid", { open: false, ending: "returned", commit: "c1" }),
    ];

    expect(lastExit({ runs })?.ending).toBe("returned");
    expect(blockOf(runs, "c1")).toBe("author");
  });

  test("a new author run leaves the last lap's reviews behind", () => {
    const runs = [
      authorDone("low"),
      reviewRun("mid", { open: false, ending: "approved", commit: "c1" }),
      reviewRun("high", { open: false, ending: "stopped" }),
      authorRun("low"),
    ];

    expect(lapOf({ runs })).toHaveLength(1);
    expect(lastExit({ runs })).toBeUndefined();
    expect(reviewFailedBy({ runs })).toEqual([]);
  });

  test("names the open reviewer and the rungs whose reviewers stopped", () => {
    const runs = [
      authorDone("low"),
      reviewRun("mid", { open: false, ending: "stopped" }),
      reviewRun("high"),
    ];

    expect(reviewedBy({ runs })).toBe("high");
    expect(reviewFailedBy({ runs })).toEqual(["mid"]);
    expect(reviewerNamed({ runs })).toBe(false);
    const named = runs.map((run) => (run.open ? { ...run, ending: "approved" } : run));
    expect(reviewerNamed({ runs: named })).toBe(true);
  });

  test("a stale reviewer is cleared by ending its run", () => {
    const stale = [authorDone("low"), reviewRun("mid")];
    const cleared = stale.map((run) =>
      run.open && run.role === "review" ? { ...run, open: false, ending: "stopped" } : run,
    );

    expect(reviewedBy({ runs: stale })).toBe("mid");
    expect(reviewedBy({ runs: cleared })).toBeUndefined();
  });

  test("the author is the latest author run, and rounds are counted on it", () => {
    const runs = [
      authorDone("low", "c1"),
      reviewRun("mid", { open: false, ending: "returned", commit: "c1" }),
      authorRun("high", { rounds: 1 }),
    ];

    expect(authoredBy({ runs })).toBe("high");
    expect(roundsOf({ runs })).toBe(1);
    expect(authoredBy({ runs: [] })).toBeUndefined();
    expect(roundsOf({ runs: [reviewRun("mid")] })).toBe(0);
  });

  test("the exits of this lap place the task", () => {
    const approval = reviewRun("mid", { open: false, ending: "approved", commit: "c1" });

    expect(blockOf([authorRun("low")], "c1")).toBe("author");
    expect(blockOf([authorDone("low", "c1"), reviewRun("mid")], "c1")).toBe("review");
    expect(blockOf([authorDone("low", "c1"), approval], "c1")).toBe("land");
    expect(blockOf([authorDone("low", "c1"), approval], "c2")).toBe("review");
    expect(blockOf([authorRun("low", { open: false, ending: "already-done" })], undefined)).toBe(
      "review",
    );
    expect(blockOf([authorDone("low", "c1"), approval, authorRun("high")], "c1")).toBe("author");
  });

  test("reads the author's already-done claim from its exit", () => {
    expect(
      claimsAlreadyDone({ runs: [authorRun("low", { open: false, ending: "already-done" })] }),
    ).toBe(true);
    expect(claimsAlreadyDone({ runs: [authorDone("low")] })).toBe(false);
  });
});

describe("the readers against a scratch store", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "foreman-lap-"));
    process.env.PROG_DB = join(directory, "prog.db");
    await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(process.env.PROG_DB))));
  });

  afterAll(async () => {
    delete process.env.PROG_DB;
    await rm(directory, { recursive: true, force: true });
  });

  test("read the runs a dispatch and a named exit wrote", async () => {
    const id = (await Bun.$`prog add "lap" -p foreman`.text()).trim();
    const dispatch = (role: "author" | "review", rung: string, commit?: string) =>
      newRunFor({
        task: { id, title: id, project: "foreman", labels: [] },
        branch: `foreman/${id}`,
        harness: "test",
        model: undefined,
        rung,
        provider: undefined,
        role,
        node: role,
        commit,
      });
    const run = <A, E>(
      f: (records: Records["Service"], tracker: Tracker["Service"]) => Effect.Effect<A, E>,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* f(yield* Records, yield* Tracker);
        }).pipe(Effect.provide(Records.layer.pipe(Layer.provide(store)))),
      );

    await run((records) => records.attribute(id, dispatch("author", "low")));
    await run((_, tracker) => tracker.claim(id));
    await run((records) => records.assignReview(id, dispatch("review", "mid", "c1")));
    await Effect.runPromise(
      nameExit(id, { name: "approved", commit: "c1", event: undefined }).pipe(
        Effect.provide(Tasks.layerSql.pipe(Layer.provideMerge(store))),
      ),
    );

    const task = await run((records) => records.show(id));

    expect(reviewedBy(task)).toBe("mid");
    expect(reviewerNamed(task)).toBe(true);
    expect(routedCommit(task)).toBe("c1");
    expect(blockOf(task.runs, "c1")).toBe("review");
  });
});
