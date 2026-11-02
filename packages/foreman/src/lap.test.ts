import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { connectionAt, store, Tasks, verdict } from "tasks";
import {
  approvedCommit,
  authoredBy,
  isApproved,
  isSatisfied,
  lapOf,
  passedNodes,
  reviewedBy,
  reviewFailedBy,
  roundsOf,
} from "./lap.ts";
import { Prog } from "./prog.ts";
import { newRunFor } from "./run-record.ts";
import { authorRun, handedOff, reviewRun } from "./task-fixture.ts";

describe("a task's lap", () => {
  test("a commit after the approval voids it", () => {
    const runs = [
      handedOff("low", "c1"),
      reviewRun("mid", { open: false, ending: "approved", commit: "c1" }),
    ];

    expect(isApproved({ runs, tip: "c1" })).toBe(true);
    expect(isApproved({ runs, tip: "c2" })).toBe(false);
    expect(approvedCommit({ runs })).toBe("c1");
  });

  test("an approval followed by a return in one turn is not an approval", () => {
    const runs = [
      authorRun("low", { open: false, ending: "handed-off" }),
      reviewRun("mid", { open: false, ending: "approved", commit: "c1" }),
      reviewRun("mid", { open: false, ending: "returned", commit: "c1" }),
    ];

    expect(isApproved({ runs, tip: "c1" })).toBe(false);
    expect(approvedCommit({ runs })).toBeUndefined();
  });

  test("a new author run leaves the last lap's reviews behind", () => {
    const runs = [
      authorRun("low", { open: false, ending: "handed-off" }),
      reviewRun("mid", { open: false, ending: "approved", commit: "c1" }),
      reviewRun("high", { open: false, ending: "no-verdict" }),
      authorRun("low"),
    ];

    expect(lapOf({ runs })).toHaveLength(1);
    expect(isApproved({ runs, tip: "c1" })).toBe(false);
    expect(reviewFailedBy({ runs })).toEqual([]);
  });

  test("names the open reviewer and the rungs whose reviewers stopped", () => {
    const runs = [
      authorRun("low", { open: false, ending: "handed-off" }),
      reviewRun("mid", { open: false, ending: "no-verdict" }),
      reviewRun("high"),
    ];

    expect(reviewedBy({ runs })).toBe("high");
    expect(reviewFailedBy({ runs })).toEqual(["mid"]);
  });

  test("a stale reviewer is cleared by ending its run", () => {
    const stale = [authorRun("low", { open: false, ending: "handed-off" }), reviewRun("mid")];
    const cleared = stale.map((run) =>
      run.open && run.role === "review"
        ? { ...run, open: false, ending: "no-verdict" as const }
        : run,
    );

    expect(reviewedBy({ runs: stale })).toBe("mid");
    expect(reviewedBy({ runs: cleared })).toBeUndefined();
  });

  test("the author is the latest author run, and rounds are counted on it", () => {
    const runs = [
      handedOff("low", "c1"),
      reviewRun("mid", { open: false, ending: "returned", commit: "c1" }),
      authorRun("high", { rounds: 1 }),
    ];

    expect(authoredBy({ runs })).toBe("high");
    expect(roundsOf({ runs })).toBe(1);
    expect(authoredBy({ runs: [] })).toBeUndefined();
    expect(roundsOf({ runs: [reviewRun("mid")] })).toBe(0);
  });

  test("passed blocks are the work that advanced the task in this lap", () => {
    const approval = reviewRun("mid", { open: false, ending: "approved", commit: "c1" });

    expect([...passedNodes({ runs: [authorRun("low")], tip: "c1" })]).toEqual([]);
    expect([...passedNodes({ runs: [handedOff("low"), reviewRun("mid")], tip: "c1" })]).toEqual([
      "author",
    ]);
    expect([...passedNodes({ runs: [handedOff("low"), approval], tip: "c1" })]).toEqual([
      "author",
      "review",
    ]);
    expect([...passedNodes({ runs: [handedOff("low"), approval], tip: "c2" })]).toEqual(["author"]);
    expect([
      ...passedNodes({
        runs: [authorRun("low", { open: false, ending: "satisfied" })],
        tip: undefined,
      }),
    ]).toEqual(["author"]);
    expect([
      ...passedNodes({ runs: [handedOff("low"), approval, authorRun("high")], tip: "c1" }),
    ]).toEqual([]);
  });

  test("reads the author's satisfied claim from its run", () => {
    expect(isSatisfied({ runs: [authorRun("low", { open: false, ending: "satisfied" })] })).toBe(
      true,
    );
    expect(isSatisfied({ runs: [authorRun("low", { open: false, ending: "handed-off" })] })).toBe(
      false,
    );
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

  test("read the runs a dispatch and a verdict wrote", async () => {
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
    const run = <A, E>(f: (prog: Prog["Service"]) => Effect.Effect<A, E>) =>
      Effect.runPromise(Prog.use(f).pipe(Effect.provide(Prog.Default.pipe(Layer.provide(store)))));

    await run((prog) => prog.attribute(id, dispatch("author", "low")));
    await run((prog) => prog.submit(id));
    await run((prog) => prog.assignReview(id, dispatch("review", "mid", "c1")));
    await Effect.runPromise(
      verdict(id, "approved").pipe(Effect.provide(Tasks.layerSql.pipe(Layer.provideMerge(store)))),
    );

    const task = await run((prog) => prog.show(id));

    expect(reviewedBy(task)).toBe("mid");
    expect(approvedCommit(task)).toBe("c1");
    expect(isApproved({ ...task, tip: "c1" })).toBe(true);
    expect(isApproved({ ...task, tip: "c2" })).toBe(false);
  });
});
