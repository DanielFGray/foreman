import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { runsOf, Tasks } from "tasks";
import { convert, reportLines } from "./cutover-runs.ts";
import { isApproved, reviewedBy, reviewFailedBy } from "./lap.ts";
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

const program = <A, E>(effect: Effect.Effect<A, E, Tasks | Repository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);

/** A task with these labels, in this status; its branch exists when `branch` is true. */
const taskWith = (
  status: "in_progress" | "reviewing" | "done",
  labels: Array<string>,
  branch = true,
) =>
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
        const settled = yield* taskWith("reviewing", ["by:cheap", "satisfied", "approved", "bug"]);
        const reviewing = yield* taskWith("reviewing", ["by:cheap", "review-by:strong"]);
        const finished = yield* taskWith("done", ["by:cheap", "approved"]);

        const report = yield* convert({ root, dryRun: false });
        const runs = yield* runsOf([working, settled, reviewing, finished]);
        const brief = (id: string) =>
          runs
            .get(id)
            ?.map((run) => [run.role, run.rung, run.open, run.ending, run.commit, run.rounds]);

        expect(brief(working)).toEqual([
          ["author", "cheap", true, undefined, undefined, 1],
          ["review", "strong", false, "no-verdict", undefined, undefined],
        ]);
        expect(brief(settled)).toEqual([
          ["author", "cheap", false, "satisfied", tip, undefined],
          ["review", undefined, false, "approved", tip, undefined],
        ]);
        expect(brief(reviewing)).toEqual([
          ["author", "cheap", false, "handed-off", tip, undefined],
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
        expect(isApproved(settledRuns)).toBe(true);
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
        const lost = yield* taskWith("reviewing", ["by:retired", "approved"], false);

        const report = yield* convert({ root, dryRun: false });
        const runs = (yield* runsOf([lost])).get(lost)!;

        expect(runs.map((run) => [run.role, run.rung, run.commit])).toEqual([
          ["author", "retired", undefined],
          ["review", undefined, undefined],
        ]);
        expect(isApproved({ runs, tip })).toBe(false);
        const plan = report.plans.find((candidate) => candidate.task === lost)!;
        expect(plan.unknownRungs).toEqual(["retired", "approved (reviewer not recorded)"]);
        expect(plan.branchGone).toBe(true);
        const text = reportLines(report).join("\n");
        expect(text).toContain("rungs the ladder no longer has");
        expect(text).toContain("branch gone");
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
