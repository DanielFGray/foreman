import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, SubscriptionRef } from "effect";
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
  parent: null,
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
  /** The name of every write any fake made, in order. */
  readonly writes: string[] = [];
  clean: "clean" | "held" = "clean";
  landing: Landing = { _tag: "Merged", verified: false };

  constructor(...items: ReadonlyArray<Item>) {
    for (const task of items) this.tasks.set(task.id, task);
  }

  readonly fleet = {
    open: (options: { task: string; repository: string; branch: string; directory: string }) =>
      this.write("fleet.open", () => {
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
      this.write("fleet.spawn", () => {
        this.spawned.push([target.task, options.role]);
        const roles = new Map(target.roles).set(options.role, "working" as const);
        this.workers.set(target.task, { ...target, roles, state: "working" });
        return { kind: options.kind, model: options.model };
      }),
    roster: Effect.sync(() => [...this.workers.values()]),
    spaces: Effect.succeed(["/build/test"]),
    focus: () => this.write("fleet.focus", () => undefined),
    say: () => this.write("fleet.say", () => undefined),
    stop: (target: Worker, role: AgentRole) =>
      this.write("fleet.stop", () => {
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
      this.write("fleet.close", () => {
        this.closed.push(options.task);
        this.workers.delete(options.task);
      }),
    notify: (title: string) =>
      this.write("fleet.notify", () => void this.notifications.push(title)),
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
    detail: () => Effect.succeedNone,
    epicsOver: () => Effect.succeed([]),
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
      this.write("prog.attribute", () =>
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
      this.write("prog.assignReview", () =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter((label) => kindOf(label) !== "review-by"),
            `review-by:${kind}`,
          ],
        })),
      ),
    clearReview: (id: string) =>
      this.write("prog.clearReview", () =>
        this.update(id, (task) => ({
          ...task,
          labels: task.labels.filter(
            (label) =>
              kindOf(label) !== "review-by" && label !== "approved" && label !== "satisfied",
          ),
        })),
      ),
    markFailure: (id: string, rung: string) =>
      this.write("prog.markFailure", () =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter((label) => !label.startsWith(`attempt:${rung}:`)),
            `failed-by:${rung}`,
          ],
        })),
      ),
    markAttempt: (id: string, rung: string, count: number) =>
      this.write("prog.markAttempt", () =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter((label) => !label.startsWith(`attempt:${rung}:`)),
            `attempt:${rung}:${count}`,
          ],
        })),
      ),
    clearNeedsYou: (id: string) =>
      this.write("prog.clearNeedsYou", () =>
        this.update(id, (task) => ({
          ...task,
          labels: task.labels.filter((label) => label !== "needs-you"),
        })),
      ),
    clearFailure: (id: string, rung: string) =>
      this.write("prog.clearFailure", () =>
        this.update(id, (task) => ({
          ...task,
          labels: task.labels.filter((label) => label !== `failed-by:${rung}`),
        })),
      ),
    markDiagnostic: () => this.write("prog.markDiagnostic", () => undefined),
    clearDiagnostic: () => this.write("prog.clearDiagnostic", () => undefined),
    release: (id: string) =>
      this.write("prog.release", () =>
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
      this.write("prog.submit", () =>
        this.update(id, (task) => ({ ...task, status: "reviewing" })),
      ),
    review: (id: string) =>
      this.write("prog.review", () =>
        this.update(id, (task) => ({ ...task, status: "reviewing" })),
      ),
    claim: (id: string) =>
      this.write("prog.claim", () =>
        this.update(id, (task) => ({ ...task, status: "in_progress" })),
      ),
    log: (id: string, message: string) =>
      this.write("prog.log", () => void this.logs.push([id, message])),
    complete: (id: string) =>
      this.write("prog.complete", () => this.update(id, (task) => ({ ...task, status: "done" }))),
    add: () => Effect.die("unused"),
    children: () => Effect.succeed([]),
    countRound: () => this.write("prog.countRound", () => 1),
  };

  readonly repository = {
    checkoutOf: (folder: string) => Effect.succeed<string | undefined>(folder),
    verifyOf: () => Effect.succeed<string | undefined>(undefined),
    isFree: () =>
      Effect.succeed(
        this.clean === "clean"
          ? ({ _tag: "Clean" } as const)
          : ({ _tag: "Held", reason: "dirty", detail: "held" } as const),
      ),
    holdsWork: () => Effect.succeed(false),
    base: () => Effect.succeed("base"),
    branches: () => Effect.succeed([...this.branches.values()]),
    remove: (_directory: string, branch: string) =>
      this.write("repository.remove", () => {
        this.removed.push(branch);
        return this.branches.delete(branch);
      }),
    // `setup` answers `undefined` when the project has no setup script; `Effect.void` would not type as that answer.
    setup: () => this.write("repository.setup", () => undefined),
    merge: () => this.write("repository.merge", () => this.landing),
    sweepUnpublishedMerges: () =>
      this.write("repository.sweepUnpublishedMerges", (): ReadonlyArray<string> => []),
    // Worktrees are the fleet adapter's concern; the world's fleet is faked whole.
    worktrees: () => Effect.die("unused"),
    addWorktree: () => Effect.die("unused"),
    removeWorktree: () => Effect.die("unused"),
    restoreBranch: () => Effect.die("unused"),
  };

  /**
   * Every write a fake makes passes through here, so a test can assert that a
   * tick wrote nothing to the task store, git, the multiplexer or the trials.
   */
  write<A>(name: string, body: () => A) {
    return Effect.sync(() => {
      this.writes.push(name);
      return body();
    });
  }

  private update(id: string, change: (task: Item) => Item): void {
    const task = this.tasks.get(id);
    if (task) this.tasks.set(id, change(task));
  }
}

/** The trials table, held in memory so a test can read what a tick appended. */
const trialsFor = (world: World) =>
  Layer.succeed(Trials, {
    record: (trial: Trial) => world.write("trials.record", () => void world.trials.push(trial)),
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
        dispatcher.kill({ task, worker: live }, Option.some("tests caught the wrong path")),
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

  test("writes the bare kill note and refills the freed slot", async () => {
    const task = item("ts-kill-default", "reviewing", ["by:cheap", "attempt:cheap:1"]);
    const world = new World(task);
    const live = worker(task.id, "review", "blocked");
    world.workers.set(task.id, live);

    await Effect.runPromiseExit(
      Dispatcher.use((dispatcher) => dispatcher.kill({ task, worker: live }, Option.none())).pipe(
        Effect.provide(layerFor(world)),
      ),
    );
    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
    expect(world.tasks.get(task.id)?.labels).toEqual(["attempt:cheap:1", "by:cheap"]);
    expect(world.logs).toContainEqual([task.id, "foreman: operator killed this attempt"]);
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
      const vanished = { ...worker(task.id, "author", "gone"), repository: "/build/test" };
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

  test("a landing writes the trial rows of the runs it ends", async () => {
    // The landing takes the task's terminals down, so no later settle sees
    // them: the rows must be written here or never.
    const task = item("ts-landed", "reviewing", ["by:cheap", "review-by:cheap", "approved"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "review", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("done");
    expect(world.trials).toEqual([
      expect.objectContaining({ task: task.id, work: "build", outcome: "committed" }),
      expect.objectContaining({ task: task.id, work: "review", outcome: "committed" }),
    ]);
  });
});

describe("a fleet that is not running", () => {
  const unmerged = (task: string): Branch => ({
    branch: `foreman/${task}`,
    merged: false,
    empty: false,
    stale: undefined,
  });

  /**
   * A world in which every pass of a running tick has something to write: a
   * settled author whose branch is empty, an approved task to land, a merged branch to
   * sweep, a stale claim to release, a done task's branch to recover, and a
   * queued task to start. The grant names no task, so a running tick would
   * also expire it.
   */
  const busy = () => {
    const settled = item("ts-settled", "reviewing", ["by:cheap"]);
    const approved = item("ts-approved", "reviewing", ["by:cheap", "review-by:cheap", "approved"]);
    const swept = item("ts-swept", "canceled", []);
    const stale = {
      ...item("ts-stale", "in_progress", ["by:cheap"]),
      last_activity_at: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    };
    const abandoned = item("ts-abandoned", "done", ["by:cheap"]);
    const queued = item("ts-queued", "open", []);
    const world = new World(settled, approved, swept, stale, abandoned, queued);
    world.workers.set(settled.id, worker(settled.id, "author", "settled"));
    for (const task of [approved, abandoned]) {
      world.branches.set(`foreman/${task.id}`, unmerged(task.id));
    }
    // Empty, so the settle pass records the run and sends the task back.
    world.branches.set("foreman/ts-settled", { ...unmerged("ts-settled"), empty: true });
    world.branches.set("foreman/ts-swept", { ...unmerged("ts-swept"), merged: true });
    return world;
  };

  const everything = {
    slots: 5,
    default: { author: true, climb: true, review: true, land: true },
    grants: [{ scope: "ts-nowhere", steps: ["land"] }],
  };

  const policyText = () => readFileSync(process.env["FOREMAN_POLICY"] ?? "", "utf8");

  test("a paused tick writes nothing, whatever the policy would otherwise allow", async () => {
    usePolicy({ ...everything, paused: true });
    const before = policyText();
    const world = busy();

    await tick(world);
    await tick(world);

    expect(world.writes).toEqual([]);
    expect(policyText()).toBe(before);
  });

  test("an idle tick, with every step off and no grant, writes nothing", async () => {
    usePolicy({ slots: 5 });
    const before = policyText();
    const world = busy();

    await tick(world);
    await tick(world);

    expect(world.writes).toEqual([]);
    expect(policyText()).toBe(before);
  });

  test("a running tick over the same world writes from every pass", async () => {
    // The control for the two above: without it, a seed that gave no pass any
    // work would pass them too.
    usePolicy(everything);
    const before = policyText();
    const world = busy();

    await tick(world);

    expect(world.writes).toEqual(
      expect.arrayContaining([
        "trials.record",
        "repository.merge",
        "repository.remove",
        "prog.release",
        "prog.submit",
        "prog.claim",
        "fleet.spawn",
      ]),
    );
    expect(policyText()).not.toBe(before);
  });

  test("a running tick releases a stale claim only when foreman's agent made it", async () => {
    usePolicy(everything);
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const ours = { ...item("ts-ours", "in_progress", ["by:cheap"]), last_activity_at: old };
    const byHand = { ...item("ts-by-hand", "in_progress", []), last_activity_at: old };
    const world = new World(ours, byHand);

    await tick(world);

    const released = world.logs
      .filter(([, line]) => line.startsWith("foreman: claim released"))
      .map(([id]) => id);
    expect(released).toEqual([ours.id]);
    expect(world.tasks.get(byHand.id)?.status).toBe("in_progress");
  });

  test("still publishes its reading", async () => {
    usePolicy({ ...everything, paused: true });
    const world = busy();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const dispatcher = yield* Dispatcher;
        yield* dispatcher.tick;
        return yield* SubscriptionRef.get(dispatcher.state);
      }).pipe(Effect.provide(layerFor(world))),
    );

    expect(state.observedAt).toBeDefined();
    expect(state.policy.paused).toBe(true);
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
  const ticking = (quota: Layer.Layer<Quota>, policy: object, ticks: number) => {
    usePolicy(policy);
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
    await ticking(quota.layer, { ...ALLOWED, paused: true }, 1);
    expect(quota.calls()).toBe(1);
  });

  test("a paused fleet stops asking after that first one", async () => {
    const quota = countingQuota();
    await ticking(quota.layer, { ...ALLOWED, paused: true }, 3);
    expect(quota.calls()).toBe(1);
  });

  test("an idle fleet stops asking too, since no step reads the answer", async () => {
    const quota = countingQuota();
    await ticking(quota.layer, { slots: 1 }, 3);
    expect(quota.calls()).toBe(1);
  });

  test("a running fleet asks every tick, because the gate reads it", async () => {
    const quota = countingQuota();
    await ticking(quota.layer, ALLOWED, 3);
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
    world.workers.set(task.id, {
      ...worker(task.id, "review", "settled"),
      repository: "/build/test",
    });
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
