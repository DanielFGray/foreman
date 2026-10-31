import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { Dispatcher } from "./dispatcher.ts";
import { Fleet, type AgentRole, type Worker, type WorkerState } from "./fleet.ts";
import { Settings } from "./config.ts";
import { kindOf, Prog, type Item, type ReadyTask } from "./prog.ts";
import { Prompts } from "./prompt.ts";
import { Quota } from "./quota.ts";
import { Repository, type Branch, type Landing } from "./repository.ts";
import { Trials, type Trial } from "./trials.ts";

const now = new Date();

const item = (
  id: string,
  status: Item["status"],
  labels: ReadonlyArray<string>,
  project = "test",
): Item => ({
  id,
  title: id,
  status,
  project,
  type: "task",
  priority: 1,
  labels: [...labels],
  description: null,
  last_activity_at: now,
  created_at: now,
});

const worker = (task: string, role: "author" | "review", state: WorkerState): Worker => ({
  task,
  repository: "/home/dan/build/project",
  directory: `/worktree/${task}`,
  worktree: `/worktree/${task}`,
  state,
  roles: new Map([[role, state]]),
});

class World {
  readonly tasks = new Map<string, Item>();
  readonly workers = new Map<string, Worker>();
  readonly branches = new Map<string, Branch>();
  readonly closed: string[] = [];
  readonly stopped: Array<[string, string]> = [];
  readonly spawned: Array<[string, string]> = [];
  readonly removed: string[] = [];
  readonly notifications: string[] = [];
  readonly logs: Array<[string, string]> = [];
  /** Trial rows the settle pass appended, in the order it wrote them. */
  readonly trials: Trial[] = [];
  clean: "clean" | "held" = "clean";
  landing: Landing = { _tag: "Merged", verified: false };

  constructor(...items: ReadonlyArray<Item>) {
    for (const task of items) this.tasks.set(task.id, task);
  }

  readonly fleet = {
    open: (options: { task: string; repository: string; branch: string; directory: string }) =>
      Effect.sync(() => {
        const current = this.workers.get(options.task);
        if (current) return current;
        const created: Worker = {
          task: options.task,
          repository: options.repository,
          directory: options.directory,
          worktree: options.directory,
          state: "gone",
          roles: new Map(),
        };
        this.workers.set(options.task, created);
        return created;
      }),
    attach: (options: { task: string; repository: string }) =>
      this.fleet.open({
        task: options.task,
        repository: options.repository,
        branch: `foreman/${options.task}`,
        directory: options.repository,
      }),
    spawn: (
      target: Worker,
      options: { role: AgentRole; kind: string; model: string | undefined; prompt: string },
    ) =>
      Effect.sync(() => {
        this.spawned.push([target.task, options.role]);
        const roles = new Map(target.roles).set(options.role, "working" as const);
        this.workers.set(target.task, { ...target, roles, state: "working" });
        return { kind: options.kind, model: options.model };
      }),
    roster: Effect.sync(() => [...this.workers.values()]),
    focus: () => Effect.void,
    say: () => Effect.void,
    stop: (target: Worker, role: AgentRole) =>
      Effect.sync(() => {
        this.stopped.push([target.task, role]);
        const roles = new Map(target.roles);
        roles.delete(role);
        this.workers.set(target.task, {
          ...target,
          roles,
          state: roles.size === 0 ? "gone" : "settled",
        });
      }),
    close: (options: { task: string; repository: string | undefined }) =>
      Effect.sync(() => {
        this.closed.push(options.task);
        this.workers.delete(options.task);
      }),
    notify: (title: string) => Effect.sync(() => void this.notifications.push(title)),
  };

  readonly prog = {
    show: (id: string) => Effect.succeed(this.tasks.get(id) as Item),
    lookup: (id: string) => Effect.succeed(Option.fromNullishOr(this.tasks.get(id))),
    ready: () =>
      Effect.succeed(
        [...this.tasks.values()].filter(
          (task) => task.status === "open",
        ) as ReadonlyArray<ReadyTask>,
      ),
    inProgressEpics: () => Effect.succeed([]),
    awaitingReview: (project: string) =>
      Effect.succeed(
        [...this.tasks.values()].filter(
          (task) => task.project === project && task.status === "reviewing",
        ),
      ),
    landed: (project: string) =>
      Effect.succeed(
        [...this.tasks.values()].filter(
          (task) => task.project === project && task.status === "done",
        ),
      ),
    claimed: (project: string) =>
      Effect.succeed(
        [...this.tasks.values()].filter(
          (task) => task.project === project && task.status === "in_progress",
        ),
      ),
    attribute: (id: string, kind: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter(
              (label) =>
                kindOf(label) !== "by" &&
                kindOf(label) !== "review-by" &&
                label !== "approved" &&
                label !== "satisfied",
            ),
            `by:${kind}`,
          ],
        })),
      ),
    assignReview: (id: string, kind: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter((label) => kindOf(label) !== "review-by"),
            `review-by:${kind}`,
          ],
        })),
      ),
    clearReview: (id: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: task.labels.filter(
            (label) =>
              kindOf(label) !== "review-by" && label !== "approved" && label !== "satisfied",
          ),
        })),
      ),
    markFailure: (id: string, rung: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter((label) => !label.startsWith(`attempt:${rung}:`)),
            `failed-by:${rung}`,
          ],
        })),
      ),
    markAttempt: (id: string, rung: string, count: number) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter((label) => !label.startsWith(`attempt:${rung}:`)),
            `attempt:${rung}:${count}`,
          ],
        })),
      ),
    clearNeedsYou: (id: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: task.labels.filter((label) => label !== "needs-you"),
        })),
      ),
    clearFailure: (id: string, rung: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: task.labels.filter((label) => label !== `failed-by:${rung}`),
        })),
      ),
    markDiagnostic: () => Effect.void,
    clearDiagnostic: () => Effect.void,
    release: (id: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          status: "open",
          labels: task.labels.filter(
            (label) =>
              kindOf(label) !== "review-by" && label !== "approved" && label !== "satisfied",
          ),
        })),
      ),
    submit: (id: string) =>
      Effect.sync(() => this.update(id, (task) => ({ ...task, status: "reviewing" }))),
    review: (id: string) =>
      Effect.sync(() => this.update(id, (task) => ({ ...task, status: "reviewing" }))),
    claim: (id: string) =>
      Effect.sync(() => this.update(id, (task) => ({ ...task, status: "in_progress" }))),
    log: (id: string, message: string) => Effect.sync(() => void this.logs.push([id, message])),
    complete: (id: string) =>
      Effect.sync(() => this.update(id, (task) => ({ ...task, status: "done" }))),
    add: () => Effect.die("unused"),
    children: () => Effect.succeed([]),
    countRound: () => Effect.succeed(1),
  };

  readonly repository = {
    isClean: () =>
      Effect.succeed(
        this.clean === "clean"
          ? ({ _tag: "Clean" } as const)
          : ({ _tag: "Held", reason: "dirty", detail: "held" } as const),
      ),
    holdsWork: () => Effect.succeed(false),
    base: () => Effect.succeed("base"),
    branches: () => Effect.succeed([...this.branches.values()]),
    remove: (_directory: string, branch: string) =>
      Effect.sync(() => {
        this.removed.push(branch);
        return this.branches.delete(branch);
      }),
    // `setup` answers `undefined` when the project has no setup script; `Effect.void` would not type as that answer.
    setup: () => Effect.succeed(undefined),
    merge: () => Effect.succeed(this.landing),
    sweepUnpublishedMerges: () => Effect.succeed([]),
    // Worktrees are the fleet adapter's concern; the world's fleet is faked whole.
    worktrees: () => Effect.die("unused"),
    addWorktree: () => Effect.die("unused"),
    removeWorktree: () => Effect.die("unused"),
    restoreBranch: () => Effect.die("unused"),
  };

  private update(id: string, change: (task: Item) => Item): void {
    const task = this.tasks.get(id);
    if (task) this.tasks.set(id, change(task));
  }
}

/** The trials table, held in memory so a test can read what a tick appended. */
const trialsFor = (world: World) =>
  Layer.succeed(Trials, {
    record: (trial: Trial) => Effect.sync(() => void world.trials.push(trial)),
  });

const prompts = Layer.succeed(Prompts, {
  author: () => Effect.succeed("author"),
  onboard: () => Effect.succeed("onboard"),
  review: () => Effect.succeed("review"),
  diagnose: () => Effect.succeed("diagnose"),
});

/** A policy that lets the fleet take every step by itself, one agent at a time. */
const ALLOWED = {
  slots: 1,
  default: { author: true, climb: true, review: true, land: true },
};

/**
 * Points the dispatcher at a fresh policy file. The path is read from the
 * environment on every pass, and the tests in a file run one at a time.
 */
const policies = mkdtempSync(join(tmpdir(), "foreman-policy-"));
let written = 0;
const usePolicy = (policy: object) => {
  const path = join(policies, `${written++}.json`);
  writeFileSync(path, JSON.stringify(policy));
  process.env["FOREMAN_POLICY"] = path;
};
beforeEach(() => usePolicy(ALLOWED));
const operatorPolicy = process.env["FOREMAN_POLICY"];
afterAll(() => {
  rmSync(policies, { recursive: true, force: true });
  if (operatorPolicy === undefined) delete process.env["FOREMAN_POLICY"];
  else process.env["FOREMAN_POLICY"] = operatorPolicy;
});

const layerFor = (world: World) =>
  Layer.provideMerge(
    Dispatcher.Default,
    Layer.mergeAll(
      Layer.succeed(Settings, {
        projects: [{ name: "test", directory: "/repo", verify: undefined }],
        ladder: [{ name: "cheap", harness: "test", model: undefined, provider: undefined }],
        otlpEndpoint: "http://localhost:4318",
        pollInterval: 60,
        staleAfter: 24,
        coachWindow: 60,
        landedWindow: 7,
        attemptsPerRung: 2,
      }),
      Layer.succeed(Fleet, world.fleet),
      Layer.succeed(Prog, world.prog),
      Layer.succeed(Repository, world.repository),
      trialsFor(world),
      // Every rung in the test ladder names a bare harness, so no provider is
      // derivable and the gate has nothing to ask about — which is the point:
      // a ladder foreman cannot read quota for dispatches exactly as before.
      Quota.Default,
      prompts,
      BunServices.layer,
    ),
  );

const tick = (world: World) =>
  Effect.runPromise(
    Dispatcher.use((dispatcher) => dispatcher.tick).pipe(Effect.provide(layerFor(world))),
  );

describe("Dispatcher tick", () => {
  test("kills a live attempt, logs the reason, and requeues without climbing", async () => {
    const task = item("ts-kill", "in_progress", ["by:cheap", "attempt:cheap:1"]);
    const world = new World(task);
    const live = worker(task.id, "author", "working");
    world.workers.set(task.id, live);

    await Effect.runPromiseExit(
      Dispatcher.use((dispatcher) =>
        dispatcher.kill({ task, worker: live }, "tests caught the wrong path"),
      ).pipe(Effect.provide(layerFor(world))),
    );

    expect(world.stopped).toEqual([[task.id, "author"]]);
    expect(world.closed).toEqual([task.id]);
    expect(world.tasks.get(task.id)?.status).toBe("open");
    expect(world.tasks.get(task.id)?.labels).toEqual(["by:cheap", "attempt:cheap:1"]);
    expect(world.logs).toEqual([
      [task.id, "foreman: operator killed this attempt: tests caught the wrong path"],
    ]);
  });

  test("uses the default kill note and refills the freed slot", async () => {
    const task = item("ts-kill-default", "reviewing", ["by:cheap", "attempt:cheap:1"]);
    const world = new World(task);
    const live = worker(task.id, "review", "blocked");
    world.workers.set(task.id, live);

    await Effect.runPromiseExit(
      Dispatcher.use((dispatcher) => dispatcher.kill({ task, worker: live }, "")).pipe(
        Effect.provide(layerFor(world)),
      ),
    );
    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
    expect(world.tasks.get(task.id)?.labels).toEqual(["attempt:cheap:1", "by:cheap"]);
    expect(world.logs).toContainEqual([
      task.id,
      "foreman: operator killed this attempt: operator killed this attempt",
    ]);
    expect(world.spawned).toEqual([[task.id, "author"]]);
  });

  test("settles an author handoff without climbing", async () => {
    const task = item("ts-author", "reviewing", ["by:cheap"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.labels).toEqual(["by:cheap", "review-by:cheap"]);
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("allows a settled role to receive the next dispatch", async () => {
    const task = item("ts-settled", "reviewing", ["by:cheap"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
    });

    await tick(world);

    expect(world.spawned).toContainEqual([task.id, "review"]);
  });

  test("counts vanished authors toward their rung limit", async () => {
    for (const [id, branch] of [
      ["ts-vanished-empty", undefined],
      [
        "ts-vanished-with-work",
        {
          branch: "foreman/ts-vanished-with-work",
          merged: false,
          empty: false,
          stale: undefined,
        },
      ],
    ] as const) {
      const task = item(id, "in_progress", ["by:cheap"]);
      const world = new World(task);
      const vanished = { ...worker(task.id, "author", "gone"), repository: "/repo" };
      world.workers.set(task.id, vanished);
      if (branch) world.branches.set(branch.branch, branch);

      await tick(world);
      expect(world.tasks.get(task.id)?.labels).toContain("attempt:cheap:1");

      world.workers.set(task.id, vanished);
      await tick(world);

      expect(world.tasks.get(task.id)?.labels).toContain("failed-by:cheap");
    }
  });

  test("sweeps a merged branch only after its task leaves the pipeline", async () => {
    const swept = item("ts-swept", "canceled", []);
    const kept = item("ts-kept", "reviewing", ["by:cheap"]);
    const world = new World(swept, kept);
    world.branches.set("foreman/ts-swept", {
      branch: "foreman/ts-swept",
      merged: true,
      empty: false,
      stale: undefined,
    });
    world.branches.set("foreman/ts-kept", {
      branch: "foreman/ts-kept",
      merged: true,
      empty: false,
      stale: undefined,
    });

    await tick(world);

    expect(world.branches.has("foreman/ts-swept")).toBe(false);
    expect(world.branches.has("foreman/ts-kept")).toBe(true);
    expect(world.removed).toEqual(["foreman/ts-swept"]);
  });

  test("appends a trial row for the run that just ended", async () => {
    // The coordinator reads this table by hand at every slice close; foreman
    // writes the row at the settle instead, so the two cannot describe different
    // runs.
    const task = item("ts-empty", "reviewing", ["by:cheap"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: true,
      stale: undefined,
    });

    await tick(world);

    expect(world.trials).toHaveLength(1);
    expect(world.trials[0]).toMatchObject({
      task: "ts-empty",
      kind: "test",
      work: "build",
      outcome: "handed-off",
      source: "live",
    });
  });

  test("writes no trial row for a run that is still going", async () => {
    const task = item("ts-live", "in_progress", ["by:cheap"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "working"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
    });

    await tick(world);

    expect(world.trials).toEqual([]);
  });

  test("returns a review handoff with no commit to the queue", async () => {
    const task = item("ts-empty", "reviewing", ["by:cheap"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: true,
      stale: undefined,
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
    expect(world.spawned).toEqual([[task.id, "author"]]);
  });

  test("reviews an empty branch whose author found the trunk already satisfies it", async () => {
    const task = item("ts-satisfied", "reviewing", ["by:cheap", "satisfied"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: true,
      stale: undefined,
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("reviewing");
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("closes a satisfied task the reviewer approved, merging nothing", async () => {
    const task = item("ts-confirmed", "reviewing", [
      "by:cheap",
      "review-by:cheap",
      "satisfied",
      "approved",
    ]);
    const world = new World(task);
    // The trunk contains an empty branch by definition, which is the verdict a
    // confirmed claim lands on: nothing merged and nothing verified.
    world.landing = { _tag: "Present" };
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: true,
      empty: true,
      stale: undefined,
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("done");
    expect(world.closed).toContain(task.id);
  });

  test("reviews an empty branch whose task's deliverable is a research report", async () => {
    const task = item("ts-research", "reviewing", ["by:cheap", "research"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: true,
      stale: undefined,
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("reviewing");
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("closes a research task the reviewer approved, merging nothing", async () => {
    const task = item("ts-research-confirmed", "reviewing", [
      "by:cheap",
      "review-by:cheap",
      "research",
      "approved",
    ]);
    const world = new World(task);
    world.landing = { _tag: "Present" };
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: true,
      empty: true,
      stale: undefined,
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("done");
    expect(world.closed).toContain(task.id);
  });

  test("holds a project out of both fill passes", async () => {
    const task = item("ts-held", "open", []);
    const world = new World(task);
    world.clean = "held";

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("open");
    expect(world.spawned).toEqual([]);
  });

  test("reserves the only slot for the focused thread", async () => {
    const focused = item("ts-focus", "open", ["focus"]);
    const spillover = item("ts-spillover", "open", []);
    const world = new World(focused, spillover);

    await tick(world);

    expect(world.spawned).toEqual([[focused.id, "author"]]);
    expect(world.tasks.get(spillover.id)?.status).toBe("open");
  });

  test("does not complete while focused ready work waits for a person", async () => {
    const focused = item("ts-focus", "open", ["focus", "needs-you"]);
    const world = new World(focused);

    await tick(world);

    expect(world.spawned).toEqual([]);
    expect(world.notifications).not.toContain("Focus complete");
  });

  test("lands an approved task without a worker", async () => {
    const task = item("ts-approved", "reviewing", ["by:cheap", "review-by:cheap", "approved"]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("done");
    expect(world.closed).toContain(task.id);
  });
});

describe("quota probing", () => {
  /** A Quota that counts how many times each provider was actually asked. */
  const countingQuota = () => {
    let calls = 0;
    const layer = Layer.succeed(Quota, {
      usage: (provider: string) =>
        Effect.sync(() => {
          calls += 1;
          return { provider, plan: undefined, allowances: [] };
        }),
    });
    return { layer, calls: () => calls };
  };

  const layerWith = (quota: Layer.Layer<Quota>, world: World) =>
    Layer.provideMerge(
      Dispatcher.Default,
      Layer.mergeAll(
        Layer.succeed(Settings, {
          projects: [{ name: "test", directory: "/repo", verify: undefined }],
          // A rung whose model names its provider is one the gate can ask about.
          ladder: [{ name: "cheap", harness: "test", model: "openai/gpt", provider: undefined }],
          otlpEndpoint: "http://localhost:4318",
          pollInterval: 60,
          staleAfter: 24,
          coachWindow: 60,
          landedWindow: 7,
          attemptsPerRung: 2,
        }),
        Layer.succeed(Fleet, world.fleet),
        Layer.succeed(Prog, world.prog),
        Layer.succeed(Repository, world.repository),
        trialsFor(world),
        quota,
        prompts,
        BunServices.layer,
      ),
    );

  /** Runs `ticks` ticks over one Dispatcher, so the startup probe counts once. */
  const ticking = (quota: Layer.Layer<Quota>, paused: boolean, ticks: number) => {
    usePolicy({ ...ALLOWED, paused });
    return Effect.runPromise(
      Effect.gen(function* () {
        for (let n = 0; n < ticks; n++) yield* (yield* Dispatcher).tick;
      }).pipe(Effect.provide(layerWith(quota, new World()))),
    );
  };

  test("the first tick asks whatever the fleet is doing", async () => {
    // "Never read" and "nothing left" look the same on a dashboard, so a fleet
    // that has just started says which one it is before it stops asking.
    const quota = countingQuota();
    await ticking(quota.layer, true, 1);
    expect(quota.calls()).toBe(1);
  });

  test("a paused fleet stops asking after that first one", async () => {
    const quota = countingQuota();
    await ticking(quota.layer, true, 3);
    expect(quota.calls()).toBe(1);
  });

  test("a running fleet asks every tick, because the gate reads it", async () => {
    const quota = countingQuota();
    await ticking(quota.layer, false, 3);
    expect(quota.calls()).toBe(3);
  });
});

describe("a spent account and the reviewer above it", () => {
  /** A Quota where each named provider is spent and every other has room. */
  const quotaSpending = (spent: ReadonlyArray<string>) =>
    Layer.succeed(Quota, {
      usage: (provider: string) =>
        Effect.succeed({
          provider,
          plan: undefined,
          allowances: spent.includes(provider)
            ? [{ window: "monthly", usedPercent: 100, resetsAt: undefined }]
            : [],
        }),
    });

  /** Two rungs on two accounts, so a wall on one leaves the other spendable. */
  const layerFor = (world: World, spent: ReadonlyArray<string>) =>
    Layer.provideMerge(
      Dispatcher.Default,
      Layer.mergeAll(
        Layer.succeed(Settings, {
          projects: [{ name: "test", directory: "/repo", verify: undefined }],
          ladder: [
            { name: "cheap", harness: "test", model: "openai/gpt", provider: undefined },
            { name: "dear", harness: "test", model: "anthropic/claude", provider: undefined },
          ],
          otlpEndpoint: "http://localhost:4318",
          pollInterval: 60,
          staleAfter: 24,
          coachWindow: 60,
          landedWindow: 7,
          attemptsPerRung: 2,
        }),
        Layer.succeed(Fleet, world.fleet),
        Layer.succeed(Prog, world.prog),
        Layer.succeed(Repository, world.repository),
        trialsFor(world),
        quotaSpending(spent),
        prompts,
        BunServices.layer,
      ),
    );

  /** A task whose author finished, waiting to be read. */
  const awaiting = (id: string) => {
    const task = item(id, "reviewing", ["by:cheap"]);
    const world = new World(task);
    world.workers.set(id, worker(id, "author", "settled"));
    world.branches.set(`foreman/${id}`, {
      branch: `foreman/${id}`,
      merged: false,
      empty: false,
      stale: undefined,
    });
    return world;
  };

  const tickWith = (world: World, spent: ReadonlyArray<string>, slots = 1) => {
    usePolicy({ ...ALLOWED, slots });
    return Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.tick).pipe(Effect.provide(layerFor(world, spent))),
    );
  };

  test("spreads one tick's slots across accounts rather than stacking them", async () => {
    // Every free slot reads the same allowances, so without spreading the whole
    // burst takes the cheapest rung — and spends one account until it dies.
    const world = new World(item("ts-one", "open", []), item("ts-two", "open", []));
    await tickWith(world, [], 2);

    expect(world.spawned).toEqual([
      ["ts-one", "author"],
      ["ts-two", "author"],
    ]);
    const rungs = world.tasks.values().flatMap((task) => task.labels);
    expect(new Set(rungs)).toEqual(new Set(["by:cheap", "by:dear"]));
  });

  test("reviews with the rung above the wall rather than waiting on money", async () => {
    // "cheap" wrote it, so "dear" reads it — and "dear" is on another account,
    // which the wall on openai says nothing about.
    const world = awaiting("ts-skips");
    await tickWith(world, ["openai"]);

    expect(world.spawned).toEqual([["ts-skips", "review"]]);
    expect(world.tasks.get("ts-skips")?.labels).toEqual(["by:cheap", "review-by:dear"]);
  });

  test("leaves the task alone when every account above is spent", async () => {
    const world = awaiting("ts-walled");
    await tickWith(world, ["openai", "anthropic"]);

    // No reviewer, and nothing written: the rung is untouched and no attempt is
    // counted, so the task is read again unchanged once an allowance resets.
    expect(world.spawned).toEqual([]);
    expect(world.tasks.get("ts-walled")?.labels).toEqual(["by:cheap"]);
    expect(world.tasks.get("ts-walled")?.status).toBe("reviewing");
  });

  test("substitutes a reviewer without climbing the task's own rung", async () => {
    // A dearer reviewer is what the wallet forced, not what the work earned, so
    // the task keeps the rung it had and its next author is unchanged.
    const task = item("ts-rung", "reviewing", ["by:cheap", "attempt:cheap:1"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
    });

    await tickWith(world, ["openai"]);

    expect(world.tasks.get(task.id)?.labels).toEqual([
      "by:cheap",
      "attempt:cheap:1",
      "review-by:dear",
    ]);
  });

  test("takes the cheapest rung nothing has recorded against the task", async () => {
    const world = new World(item("ts-fresh", "open", []));
    await tickWith(world, []);

    expect(world.spawned).toEqual([["ts-fresh", "author"]]);
    expect(world.tasks.get("ts-fresh")?.labels).toContain("by:cheap");
  });

  test("takes the rung above a recorded failure", async () => {
    const world = new World(item("ts-failed", "open", ["failed-by:cheap"]));
    await tickWith(world, []);

    expect(world.tasks.get("ts-failed")?.labels).toContain("by:dear");
  });

  test("steps an author over a spent account rather than parking the task", async () => {
    // Nothing is recorded against the task: the wall is the wallet's, so the
    // cheap rung is chosen again the moment the account resets.
    const world = new World(item("ts-money", "open", []));
    await tickWith(world, ["openai"]);

    expect(world.tasks.get("ts-money")?.labels).toContain("by:dear");
    expect(world.tasks.get("ts-money")?.labels).not.toContain("failed-by:cheap");
  });

  test("waits in the queue when every rung is walled, and records nothing", async () => {
    const world = new World(item("ts-broke", "open", []));
    await tickWith(world, ["openai", "anthropic"]);

    expect(world.spawned).toEqual([]);
    expect(world.tasks.get("ts-broke")?.status).toBe("open");
    expect(world.tasks.get("ts-broke")?.labels).toEqual([]);
  });

  test("dispatches nothing for a task every rung has failed", async () => {
    // The ladder is exhausted by evidence, which is the operator's column —
    // and unlike a wall, no reset clears it.
    const world = new World(item("ts-exhausted", "open", ["failed-by:cheap", "failed-by:dear"]));
    await tickWith(world, []);

    expect(world.spawned).toEqual([]);
    expect(world.tasks.get("ts-exhausted")?.status).toBe("open");
  });

  test("records the rung that ran, not the one that comes next", async () => {
    // A reviewer sending work back is a judgement about the model that wrote
    // the code, so what lands on the task is that model's failure.
    const task = item("ts-sent-back", "open", ["by:cheap", "review-by:dear"]);
    const world = new World(task);
    world.workers.set(task.id, { ...worker(task.id, "review", "settled"), repository: "/repo" });
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
    });

    await tickWith(world, []);

    const labels = world.tasks.get(task.id)?.labels ?? [];
    expect(labels).toContain("failed-by:cheap");
    expect(labels.filter((label) => label.startsWith("failed-by:"))).toEqual(["failed-by:cheap"]);
  });
});
