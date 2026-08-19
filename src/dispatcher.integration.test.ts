import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Dispatcher } from "./dispatcher.ts";
import { Fleet, type AgentRole, type Worker, type WorkerState } from "./fleet.ts";
import { Settings } from "./config.ts";
import { Prog, type Item, type ReadyTask } from "./prog.ts";
import { Prompts } from "./prompt.ts";
import { Repository, type Branch, type Landing } from "./repository.ts";

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
  workspace: `workspace-${task}`,
  pane: `pane-${task}`,
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
          workspace: `workspace-${options.task}`,
          pane: `pane-${options.task}`,
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
    notify: () => Effect.void,
  };

  readonly prog = {
    _tag: "Prog" as const,
    show: (id: string) => Effect.succeed(this.tasks.get(id) as Item),
    ready: () =>
      Effect.succeed(
        [...this.tasks.values()].filter(
          (task) => task.status === "open",
        ) as ReadonlyArray<ReadyTask>,
      ),
    focused: () =>
      Effect.succeed([...this.tasks.values()].filter((task) => task.labels.includes("focus"))),
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
                !label.startsWith("by-") &&
                !label.startsWith("review-by-") &&
                label !== "approved" &&
                label !== "satisfied",
            ),
            `by-${kind}`,
          ],
        })),
      ),
    assignReview: (id: string, kind: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter((label) => !label.startsWith("review-by-")),
            `review-by-${kind}`,
          ],
        })),
      ),
    clearReview: (id: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: task.labels.filter(
            (label) =>
              !label.startsWith("review-by-") && label !== "approved" && label !== "satisfied",
          ),
        })),
      ),
    setRung: (id: string, rung: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter(
              (label) => !label.startsWith("rung-") && !label.startsWith("attempt-"),
            ),
            `rung-${rung}`,
          ],
        })),
      ),
    markAttempt: (id: string, rung: string, count: number) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: [
            ...task.labels.filter((label) => !label.startsWith(`attempt-${rung}-`)),
            `attempt-${rung}-${count}`,
          ],
        })),
      ),
    clearRung: (id: string) =>
      Effect.sync(() =>
        this.update(id, (task) => ({
          ...task,
          labels: task.labels.filter((label) => !label.startsWith("rung-")),
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
              !label.startsWith("review-by-") && label !== "approved" && label !== "satisfied",
          ),
        })),
      ),
    submit: (id: string) =>
      Effect.sync(() => this.update(id, (task) => ({ ...task, status: "reviewing" }))),
    review: (id: string) =>
      Effect.sync(() => this.update(id, (task) => ({ ...task, status: "reviewing" }))),
    claim: (id: string) =>
      Effect.sync(() => this.update(id, (task) => ({ ...task, status: "in_progress" }))),
    log: () => Effect.void,
    complete: (id: string) =>
      Effect.sync(() => this.update(id, (task) => ({ ...task, status: "done" }))),
    add: () => Effect.die("unused"),
    addEpic: () => Effect.die("unused"),
    children: () => Effect.succeed([]),
  };

  readonly repository = {
    _tag: "Repository" as const,
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
    setup: () => Effect.succeed(undefined),
    merge: () => Effect.succeed(this.landing),
    sweepUnpublishedMerges: () => Effect.succeed([]),
  };

  private update(id: string, change: (task: Item) => Item): void {
    const task = this.tasks.get(id);
    if (task) this.tasks.set(id, change(task));
  }
}

const prompts = Layer.succeed(Prompts, {
  _tag: "Prompts",
  author: () => Effect.succeed("author"),
  onboard: () => Effect.succeed("onboard"),
  review: () => Effect.succeed("review"),
  diagnose: () => Effect.succeed("diagnose"),
  planner: () => Effect.succeed("planner"),
  tasker: () => Effect.succeed("tasker"),
});

const layerFor = (world: World) =>
  Layer.provideMerge(
    Dispatcher.Default,
    Layer.mergeAll(
      Layer.succeed(Settings, {
        projects: [{ name: "test", directory: "/repo", verify: undefined }],
        slots: 1,
        running: true,
        ladder: [{ name: "cheap", harness: "test", model: undefined }],
        planner: { name: "cheap", harness: "test", model: undefined },
        tasker: { name: "cheap", harness: "test", model: undefined },
        pollInterval: 60,
        staleAfter: 24,
        coachWindow: 60,
        landedWindow: 7,
        attemptsPerRung: 2,
      }),
      Layer.succeed(Fleet, world.fleet),
      Layer.succeed(Prog, world.prog),
      Layer.succeed(Repository, world.repository),
      prompts,
    ),
  );

const tick = (world: World) =>
  Effect.runPromise(Dispatcher.tick.pipe(Effect.provide(layerFor(world))));

describe("Dispatcher tick", () => {
  test("settles an author handoff without climbing", async () => {
    const task = item("ts-author", "reviewing", ["by-cheap"]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.labels).toEqual(["by-cheap", "review-by-cheap"]);
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("allows a settled role to receive the next dispatch", async () => {
    const task = item("ts-settled", "reviewing", ["by-cheap"]);
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

  test("sweeps a merged branch only after its task leaves the pipeline", async () => {
    const swept = item("ts-swept", "canceled", []);
    const kept = item("ts-kept", "reviewing", ["by-cheap"]);
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

  test("returns a review handoff with no commit to the queue", async () => {
    const task = item("ts-empty", "reviewing", ["by-cheap"]);
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
    const task = item("ts-satisfied", "reviewing", ["by-cheap", "satisfied"]);
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
      "by-cheap",
      "review-by-cheap",
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

  test("lands an approved task without a worker", async () => {
    const task = item("ts-approved", "reviewing", ["by-cheap", "review-by-cheap", "approved"]);
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
