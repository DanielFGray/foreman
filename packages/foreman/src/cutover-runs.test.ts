import type { Run } from "tasks";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { runsOf, Tasks } from "tasks";
import { convert, reportLines } from "./cutover-runs.ts";
import { reviewedBy, reviewFailedBy } from "./lap.ts";
import { place, STANDARD_PIPELINE } from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";
import { Repository } from "./repository.ts";
import { scratchStore, seed } from "./scratch-store.ts";

const rig = await readFile(join(import.meta.dir, "..", "e2e", "registry.sql"), "utf8");

let root: string;
let tip: string;
const store = scratchStore();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "foreman-cutover-"));
  const repo = join(root, "proj");
  const git = (...args: Array<string>) => Bun.$`git -C ${repo} ${args}`.quiet();
  await Bun.$`git init -q ${repo}`.quiet();
  await git("config", "user.email", "foreman@test");
  await git("config", "user.name", "foreman");
  await git("commit", "-q", "--allow-empty", "-m", "initial");
  tip = (await git("rev-parse", "HEAD")).text().trim();
  await Effect.runPromise(seed(rig).pipe(Effect.provide(store.layer)));
});

afterAll(async () => {
  store.cleanup();
  await rm(root, { recursive: true, force: true });
});

const layer = Layer.mergeAll(Tasks.layerSql, Repository.Default).pipe(
  Layer.provideMerge(store.layer),
);

const program = <A, E>(effect: Effect.Effect<A, E, Tasks | Repository | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);

/** A task with these labels, in this status; its branch exists when `branch` is true. */
const taskWith = (status: "open" | "in_progress" | "done", labels: Array<string>, branch = true) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    const id = yield* tasks.add({
      title: `t ${labels.join(",")}`,
      project: "proj",
      status,
      labels,
    });
    if (branch)
      yield* Effect.promise(() => Bun.$`git -C ${join(root, "proj")} branch foreman/${id}`.quiet());
    return id;
  });

describe("the runs cutover", () => {
  test("converts each kind of label to its run, removes the labels, and converts nothing twice", () =>
    program(
      Effect.gen(function* () {
        const tasks = yield* Tasks;
        const working = yield* taskWith("in_progress", [
          "by:cheap",
          "rounds:1",
          "review-failed-by:strong",
        ]);
        const settled = yield* taskWith("in_progress", [
          "by:cheap",
          "satisfied",
          "approved",
          "bug",
        ]);
        const reviewing = yield* taskWith("in_progress", ["by:cheap", "review-by:strong"]);
        const finished = yield* taskWith("done", ["by:cheap", "approved"]);

        const report = yield* convert({ root, dryRun: false });
        const runs = yield* runsOf([working, settled, reviewing, finished]);
        const brief = (id: string) =>
          runs
            .get(id)
            ?.map((run) => [run.role, run.rung, run.open, run.ending, run.commit, run.rounds]);

        expect(brief(working)).toEqual([
          ["author", "cheap", true, undefined, undefined, 1],
          ["review", "strong", false, "stopped", undefined, undefined],
        ]);
        expect(brief(settled)).toEqual([
          ["author", "cheap", false, "already-done", tip, undefined],
          ["review", undefined, false, "approved", tip, undefined],
        ]);
        expect(brief(reviewing)).toEqual([
          ["author", "cheap", false, "done", tip, undefined],
          ["review", "strong", true, undefined, tip, undefined],
        ]);
        expect(runs.has(finished)).toBe(false);

        // The labels go, the facts about the task stay, and a done task keeps its history.
        expect((yield* tasks.require(settled)).labels).toEqual(["bug"]);
        expect((yield* tasks.require(finished)).labels.slice().sort()).toEqual([
          "approved",
          "by:cheap",
        ]);
        expect(report.plans.map((plan) => plan.task).sort()).toEqual(
          [working, settled, reviewing].sort(),
        );

        // The readers see what the labels said.
        const settledRuns = { runs: runs.get(settled)!, tip };
        expect(landsAt(settledRuns)).toBe(true);
        expect(reviewedBy({ runs: runs.get(reviewing)! })).toBe("strong");
        expect(reviewFailedBy({ runs: runs.get(working)! })).toEqual(["strong"]);

        const again = yield* convert({ root, dryRun: false });
        expect(again.plans).toEqual([]);
        expect((yield* runsOf([working, settled, reviewing])).get(working)).toHaveLength(2);
      }),
    ));

  test("names a rung the ladder lost and a branch that is gone, and an approval on it does not hold", () =>
    program(
      Effect.gen(function* () {
        const lost = yield* taskWith("in_progress", ["by:retired", "approved"], false);

        const report = yield* convert({ root, dryRun: false });
        const runs = (yield* runsOf([lost])).get(lost)!;

        expect(runs.map((run) => [run.role, run.rung, run.commit])).toEqual([
          ["author", "retired", undefined],
          ["review", undefined, undefined],
        ]);
        expect(landsAt({ runs, tip: undefined })).toBe(false);
        const plan = report.plans.find((candidate) => candidate.task === lost)!;
        expect(plan.unknownRungs).toEqual(["retired", "approved (reviewer not recorded)"]);
        expect(plan.branchGone).toBe(true);
        const text = reportLines(report).join("\n");
        expect(text).toContain("rungs the ladder no longer has");
        expect(text).toContain("branch gone");
      }),
    ));

  test("a task back in the queue loses its old labels and gains no runs", () =>
    program(
      Effect.gen(function* () {
        const tasks = yield* Tasks;
        // A released attempt: its by: label names no run that handed work off.
        const queued = yield* taskWith("open", ["by:cheap", "rounds:1", "failed-by:cheap", "bug"]);

        const report = yield* convert({ root, dryRun: false });

        expect((yield* runsOf([queued])).has(queued)).toBe(false);
        expect((yield* tasks.require(queued)).labels.slice().sort()).toEqual([
          "bug",
          "failed-by:cheap",
        ]);
        expect(report.plans.find((plan) => plan.task === queued)?.runs).toEqual([]);
      }),
    ));

  test("a dry run prints the plan and writes nothing", () =>
    program(
      Effect.gen(function* () {
        const tasks = yield* Tasks;
        const id = yield* taskWith("in_progress", ["by:strong", "rounds:2"]);

        const report = yield* convert({ root, dryRun: true });
        const plan = report.plans.find((candidate) => candidate.task === id)!;

        expect(plan.runs).toHaveLength(1);
        expect(reportLines(report).join("\n")).toContain("would write");
        expect((yield* runsOf([id])).has(id)).toBe(false);
        expect((yield* tasks.require(id)).labels).toEqual(["by:strong", "rounds:2"]);

        // The real run still finds the task.
        expect((yield* convert({ root, dryRun: false })).plans.map((p) => p.task)).toContain(id);
      }),
    ));
});

/** Whether a reviewing task with these runs stands at the land of the standard pipeline. */
const landsAt = (task: { readonly runs: ReadonlyArray<Run>; readonly tip: string | undefined }) => {
  const placement = place(
    STANDARD_PIPELINE,
    factsOf(
      { status: "in_progress", priority: 2, parent: undefined, labels: [], ...task },
      STANDARD_PIPELINE,
    ),
  );
  return placement._tag === "At" && placement.node.kind === "land";
};
