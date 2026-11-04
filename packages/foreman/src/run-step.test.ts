import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { connectionAt, store } from "tasks";
import type { CheckNode } from "./pipeline.ts";
import { QUEUE, STANDARD_PIPELINES } from "./pipeline.ts";
import { type Item, Records } from "./records.ts";
import { newRunFor } from "./run-record.ts";
import { applyRow, type RunEvent, stepOf, type StepRules } from "./run-step.ts";
import { Tracker } from "./tracker.ts";

// ProjectTracker reads the policy file; a path with no file is the default, every project on prog.
process.env["FOREMAN_POLICY"] = join(tmpdir(), "foreman-test-no-policy", "policy.json");

const rules: StepRules = {
  ladder: [
    { name: "cheap", harness: "test", level: 0, model: undefined, provider: undefined },
    { name: "dear", harness: "test", level: 1, model: undefined, provider: undefined },
  ],
  attemptsPerRung: 2,
  pipeline: STANDARD_PIPELINES.worktree,
};

const lint: CheckNode = {
  kind: "check",
  id: "lint",
  command: "bun run lint",
  exits: [
    { name: "passed", to: "review-gate" },
    { name: "failed", to: QUEUE, fails: "author" },
  ],
};

const started = (id: string, role: "author" | "review", rung: string, commit?: string) =>
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

const checked = (id: string, ending: "passed" | "failed", commit: string): RunEvent => ({
  _tag: "Checked",
  block: lint,
  check: { project: "foreman", task: id, node: lint.id, command: lint.command, commit, ending },
});

const authorOn = (rung: string) => (id: string) =>
  ({ _tag: "AuthorStarted", run: started(id, "author", rung) }) as const;
const reviewOn = (rung: string, commit: string) => (id: string) =>
  ({ _tag: "ReviewStarted", run: started(id, "review", rung, commit) }) as const;
const fixed = (event: RunEvent) => (): RunEvent => event;

/** Each scenario's events, built from the task id the store gives it. */
const scenarios: Record<string, ReadonlyArray<(id: string) => RunEvent>> = {
  "approved and landed": [
    authorOn("cheap"),
    fixed({ _tag: "ExitNamed", name: "done", commit: "c1" }),
    fixed({ _tag: "HandedOff", tip: "c1" }),
    reviewOn("dear", "c1"),
    fixed({ _tag: "ExitNamed", name: "approved", commit: "c1" }),
    fixed({ _tag: "HandedOff", tip: "c1" }),
    fixed({ _tag: "Landed" }),
  ],
  "returned with findings that fail the author": [
    authorOn("cheap"),
    fixed({ _tag: "ExitNamed", name: "done", commit: "c1" }),
    fixed({ _tag: "HandedOff", tip: "c1" }),
    reviewOn("dear", "c1"),
    fixed({ _tag: "ExitNamed", name: "returned", commit: "c1" }),
    fixed({ _tag: "ReviewReturned" }),
    authorOn("dear"),
  ],
  "stops spend the rung's attempts, then climb": [
    authorOn("cheap"),
    fixed({ _tag: "Stopped", ending: "stopped" }),
    authorOn("cheap"),
    fixed({ _tag: "Stalled", role: "author", who: "test" }),
    authorOn("cheap"),
    fixed({ _tag: "Stopped", ending: "vanished" }),
    (id) => ({ _tag: "AuthorReplaced", run: started(id, "author", "dear") }),
  ],
  "a stalled reviewer with no rung above parks": [
    authorOn("cheap"),
    fixed({ _tag: "ExitNamed", name: "done", commit: "c1" }),
    fixed({ _tag: "HandedOff", tip: "c1" }),
    reviewOn("dear", "c1"),
    fixed({ _tag: "Stalled", role: "review", who: "reviewer dear" }),
  ],
  "walls on both roles": [
    authorOn("cheap"),
    fixed({ _tag: "Walled", role: "author" }),
    authorOn("cheap"),
    fixed({ _tag: "ExitNamed", name: "done", commit: "c1" }),
    fixed({ _tag: "HandedOff", tip: "c1" }),
    reviewOn("dear", "c1"),
    fixed({ _tag: "Walled", role: "review" }),
  ],
  "checks pass, then fail back to the queue": [
    authorOn("cheap"),
    fixed({ _tag: "ExitNamed", name: "done", commit: "c1" }),
    fixed({ _tag: "HandedOff", tip: "c1" }),
    (id) => checked(id, "passed", "c1"),
    (id) => checked(id, "failed", "c1"),
  ],
  "a requeued task closes its open run, and its exit stands": [
    authorOn("cheap"),
    fixed({ _tag: "ExitNamed", name: "already-done", commit: "c1" }),
    fixed({ _tag: "Requeued" }),
  ],
  "a landing that conflicts, breaks, and is climbed by hand": [
    authorOn("cheap"),
    fixed({ _tag: "ExitNamed", name: "done", commit: "c1" }),
    fixed({ _tag: "HandedOff", tip: "c1" }),
    fixed({ _tag: "Conflicted" }),
    authorOn("cheap"),
    fixed({ _tag: "Broke" }),
    fixed({ _tag: "Climbed" }),
  ],
};

/**
 * The task as the step reads it, with each run id replaced by its place in
 * the task: the store numbers runs across every task, the fold within one.
 */
const view = (task: Item) => {
  const place = new Map(task.runs.map((run, index) => [run.id, index + 1]));
  return {
    status: task.status,
    parked: task.parked,
    charges: task.charges.map((charge) => ({
      ...charge,
      run: charge.run === undefined ? undefined : place.get(charge.run),
    })),
    runs: task.runs.map(({ id, ...run }) => ({ ...run, id: place.get(id) })),
  };
};

const run = <A, E>(
  f: (records: Records["Service"], tracker: Tracker["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* Records, yield* Tracker);
    }).pipe(
      Effect.provide(Records.layer.pipe(Layer.provide(Layer.mergeAll(store, BunServices.layer)))),
    ),
  );

describe("applyRow agrees with the store", () => {
  let directory: string;
  /** Each part of a row some scenario wrote, so a part no scenario reaches fails the last test. */
  const written = new Set<string>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "foreman-step-"));
    process.env.PROG_DB = join(directory, "prog.db");
    await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(process.env.PROG_DB))));
  });

  afterAll(async () => {
    delete process.env.PROG_DB;
    await rm(directory, { recursive: true, force: true });
  });

  for (const [name, events] of Object.entries(scenarios)) {
    test(name, async () => {
      const id = await run((_, tracker) =>
        tracker.add({ project: "foreman", title: name, description: "", labels: [] }),
      );
      let folded = await run((records) => records.show(id));
      for (const eventOf of events) {
        const event = eventOf(id);
        const stored = await run((records) => records.show(id));
        const { row } = stepOf(stored, event, rules);
        await run((records) => records.write(id, row));
        if (row.move !== undefined) written.add(row.move);
        for (const [part, value] of Object.entries(row)) {
          if (
            part !== "move" &&
            value !== undefined &&
            !(Array.isArray(value) && value.length === 0)
          ) {
            written.add(part);
          }
        }
        folded = applyRow(folded, row);

        expect({ event: event._tag, ...view(folded) }).toEqual({
          event: event._tag,
          ...view(await run((records) => records.show(id))),
        });
      }
    });
  }

  test("the scenarios write every part of a row", () => {
    expect([...written].sort()).toEqual([
      "charges",
      "check",
      "claim",
      "close",
      "complete",
      "exit",
      "land",
      "open",
      "park",
      "reopen",
    ]);
  });
});
