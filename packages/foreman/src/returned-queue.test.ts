import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { connectionAt } from "tasks";
import type { Ladder } from "./ladder.ts";
import { queueFrom } from "./queue.ts";
import { STANDARD_PIPELINES } from "./pipeline.ts";
import { Records } from "./records.ts";
import { newRunFor } from "./run-record.ts";
import { type RunEvent, stepOf, type StepRules } from "./run-step.ts";
import { Tracker } from "./tracker.ts";

// ProjectTracker reads the policy file; a path with no file is the default, every project on tasks.
process.env["FOREMAN_POLICY"] = join(tmpdir(), "foreman-test-no-policy", "policy.json");

const ladder: Ladder = [
  {
    name: "cheap",
    harness: "test",
    level: 0,
    model: undefined,
    provider: undefined,
    enabled: true,
    author: true,
    unmetered: false,
  },
  {
    name: "dear",
    harness: "test",
    level: 1,
    model: undefined,
    provider: undefined,
    enabled: true,
    author: true,
    unmetered: false,
  },
];

const rules: StepRules = {
  ladder,
  reviewers: [
    {
      name: "dear",
      harness: "test",
      model: "m-dear",
      provider: undefined,
      thinking: "high",
      unmetered: false,
    },
  ],
  attemptsPerLevel: 2,
  pipeline: STANDARD_PIPELINES.worktree,
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

const authorOn = (rung: string) => (id: string) =>
  ({ _tag: "AuthorStarted", run: started(id, "author", rung) }) as const;
const reviewOn = (rung: string, commit: string) => (id: string) =>
  ({ _tag: "ReviewStarted", run: started(id, "review", rung, commit) }) as const;
const fixed = (event: RunEvent) => (): RunEvent => event;

/** A task approved at c1 by the reviewer, whose landing then conflicts. */
const conflicted: ReadonlyArray<(id: string) => RunEvent> = [
  authorOn("cheap"),
  fixed({ _tag: "ExitNamed", exit: "done", commit: "c1", notes: Option.none() }),
  fixed({ _tag: "HandedOff", tip: "c1" }),
  reviewOn("dear", "c1"),
  fixed({ _tag: "ExitNamed", exit: "approved", commit: "c1", notes: Option.none() }),
  fixed({ _tag: "HandedOff", tip: "c1" }),
  fixed({ _tag: "Conflicted" }),
];

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "foreman-returned-"));
  process.env.TASKS_DB = join(directory, "tasks.db");
  await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(process.env.TASKS_DB))));
});

afterAll(async () => {
  delete process.env.TASKS_DB;
  await rm(directory, { recursive: true, force: true });
});

/** Runs `f` against foreman's records and the tracker, over the scratch store. */
const run = <A, E>(
  f: (records: Records["Service"], tracker: Tracker["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* Records, yield* Tracker);
    }).pipe(
      Effect.provide(
        Records.layer.pipe(
          Layer.provide(Layer.mergeAll(connectionAt(process.env.TASKS_DB!), BunServices.layer)),
        ),
      ),
    ),
  );

describe("a task returned by a conflicted landing", () => {
  test("is listed in the queue, in the same project", async () => {
    const id = await run((_, tracker) =>
      tracker.add({ project: "foreman", title: "returned", description: "", labels: [] }),
    );
    for (const eventOf of conflicted) {
      const event = eventOf(id);
      const stored = await run((records) => records.show(id));
      const { row } = stepOf(stored, event, rules);
      await run((records) => records.write(id, row));
    }

    const ready = await run((records) => records.ready(Option.some("foreman")));
    const task = ready.find((item) => item.id === id);
    expect(task?.status).toBe("open");
    expect(task?.parked).toBeUndefined();

    const { queue } = queueFrom({
      ready,
      ladder,
      projects: ["foreman"],
      epics: [],
      failed: new Set(),
      now: new Date(),
    });
    expect(queue.map((item) => item.id)).toContain(id);
  });
});

describe("the same, after the operator raised the floor", () => {
  test("is listed in the queue", async () => {
    const id = await run((_, tracker) =>
      tracker.add({ project: "foreman", title: "floored", description: "", labels: [] }),
    );
    await run((records) => records.markFailure(id, "cheap"));
    for (const eventOf of conflicted) {
      const event = eventOf(id);
      const stored = await run((records) => records.show(id));
      const { row } = stepOf(stored, event, rules);
      await run((records) => records.write(id, row));
    }

    const ready = await run((records) => records.ready(Option.some("foreman")));
    const task = ready.find((item) => item.id === id);
    expect(task?.parked).toBeUndefined();
    const { queue } = queueFrom({
      ready,
      ladder,
      projects: ["foreman"],
      epics: [],
      failed: new Set(),
      now: new Date(),
    });
    expect(queue.map((item) => item.id)).toContain(id);
  });
});
