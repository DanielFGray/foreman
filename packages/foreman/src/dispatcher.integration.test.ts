import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Console, Effect, Layer, Option, Schedule, SubscriptionRef } from "effect";
import { Command } from "effect/cli";
import { policyPath, updatePolicy } from "./policy.ts";
import { Dispatcher } from "./dispatcher.ts";
import { Fleet, FleetError, type AgentRole, type Worker, type WorkerState } from "./fleet.ts";
import { Settings } from "./config.ts";
import { kindOf, Prog, ProgError, type Item } from "./prog.ts";
import type { Run } from "tasks";
import { Prompts } from "./prompt.ts";
import { Quota } from "./quota.ts";
import { Repository, type Branch, type Checked, type Landing } from "./repository.ts";
import type { CheckRun, Ending, NewRun, Role } from "tasks";
import { authoredBy, reviewFailedBy } from "./lap.ts";
import { authorRun, handedOff, reviewRun, withRuns } from "./task-fixture.ts";
import { pipelineCommand } from "./pipeline-command.ts";
import { type AgentNode, type PipelineNode, STANDARD_PIPELINE } from "./pipeline.ts";
import { scratchStore } from "./scratch-store.ts";

const now = new Date();

const item = (
  id: string,
  status: Item["status"],
  labels: ReadonlyArray<string>,
  project = "test",
  runs: ReadonlyArray<Run> = [],
): Item =>
  withRuns(
    {
      id,
      title: id,
      status,
      project,
      type: "task",
      priority: 1,
      labels: [...labels],
      description: "",
      parent: undefined,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: new Date(0),
      definitionOfDone: undefined,
      runs: [],
      tip: undefined,
    },
    runs,
  );

/** The rung of the task's open review run, if a reviewer is assigned. */
const reviewerOf = (world: World, id: string) =>
  world.tasks.get(id)?.runs.find((run) => run.open && run.role === "review")?.rung;

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
  /** Tasks whose next spawn fails, as when a harness will not start. */
  readonly spawnFails = new Set<string>();
  readonly removed: string[] = [];
  readonly notifications: string[] = [];
  readonly logs: Array<[string, string]> = [];
  /** The ref each landing merged, in order: the approved commit, never a branch name. */
  readonly merged: string[] = [];
  /** Tips a branch took after the tick observed it, as when an author commits during a landing. */
  readonly movedTips = new Map<string, string>();
  /** The worktrees holding uncommitted work, which `holdsWork` reports. */
  readonly dirty = new Set<string>();
  /** The commit message of every work commit a tick made, in order. */
  readonly commits: string[] = [];
  /** The text each task's author terminal shows, which `screen` reads back. */
  readonly screens = new Map<string, string>();
  /** The name of every write any fake made, in order. */
  readonly writes: string[] = [];
  clean: "clean" | "held" = "clean";
  landing: Landing = { _tag: "Merged", verified: false };
  /** What every check block's command answers. */
  checking: Checked = { _tag: "Passed", verified: true };
  /** The commit and command of every check run, in order. */
  readonly checked: Array<[string, string]> = [];
  /** The commit message each landing passed to `Repository.merge`. */
  readonly mergeMessages: string[] = [];

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
      this.spawnFails.has(target.task)
        ? Effect.fail(new FleetError({ operation: "spawn", detail: "harness would not start" }))
        : this.write("fleet.spawn", () => {
            this.spawned.push([target.task, options.role]);
            const roles = new Map(target.roles).set(options.role, "working" as const);
            this.workers.set(target.task, { ...target, roles, state: "working" });
            return { kind: options.kind, model: options.model };
          }),
    roster: Effect.sync(() => [...this.workers.values()]),
    // The dispatcher never waits on a turn; only `foreman wait` does.
    awaitTurn: () => Effect.void,
    spaces: Effect.succeed(["/build/test"]),
    focus: () => this.write("fleet.focus", () => undefined),
    say: () => this.write("fleet.say", () => undefined),
    screen: (target: Worker) =>
      this.write("fleet.screen", () => Option.fromNullishOr(this.screens.get(target.task))),
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
    // Fails for an absent task, as Prog.show does, so callers that tolerate a
    // deleted task (the branch read) are exercised against the real contract.
    show: (id: string) => {
      const task = this.tasks.get(id);
      return task === undefined
        ? Effect.fail(new ProgError({ command: `show ${id}`, detail: "no such task in the store" }))
        : Effect.succeed(task);
    },
    lookup: (id: string) => Effect.succeed(Option.fromNullishOr(this.tasks.get(id))),
    ready: () =>
      Effect.succeed(
        [...this.tasks.values()].filter((task) => task.status === "open") as ReadonlyArray<Item>,
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
    attribute: (id: string, run: NewRun) =>
      this.write("prog.attribute", () => this.openRun(id, run)),
    assignReview: (id: string, run: NewRun) =>
      this.write("prog.assignReview", () => {
        this.closeRuns(id, { author: "handed-off", review: "released", commit: run.commit });
        return this.openRun(id, run);
      }),
    endReview: (id: string, ending: Ending) =>
      this.write("prog.endReview", () => this.closeRuns(id, { review: ending })),
    endRuns: (id: string, endings: { author?: Ending; review?: Ending }) =>
      this.write("prog.endRuns", () => this.closeRuns(id, endings)),
    abandon: (id: string, role: Role) =>
      this.write("prog.abandon", () => {
        this.update(id, (task) => ({
          ...task,
          status: role === "author" ? "open" : task.status,
          runs: task.runs.filter((run) => !(run.open && run.role === role)),
        }));
      }),
    parkForOperator: (id: string) =>
      this.write("prog.parkForOperator", () =>
        this.update(id, (task) => ({ ...task, labels: [...task.labels, "needs-you"] })),
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
    markWall: (id: string, provider: string) =>
      this.write("prog.markWall", () =>
        this.update(id, (task) => ({ ...task, labels: [...task.labels, `walled:${provider}`] })),
      ),
    clearDiagnostic: () => this.write("prog.clearDiagnostic", () => undefined),
    release: (id: string, ending: Ending = "released") =>
      this.write("prog.release", () => {
        this.closeRuns(id, { author: ending, review: "released" });
        this.update(id, (task) => ({ ...task, status: "open" }));
        return "open" as const;
      }),
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
    complete: (task: { id: string }) =>
      this.write("prog.complete", () => {
        this.closeRuns(task.id, { author: "released", review: "released" });
        this.update(task.id, (found) => ({ ...found, status: "done" }));
      }),
    add: () => Effect.die("unused"),
    children: () => Effect.succeed([]),
    countRound: () => this.write("prog.countRound", () => 1),
    rereadReview: (id: string, commit: string) =>
      this.write("prog.rereadReview", () =>
        this.update(id, (task) => ({
          ...task,
          runs: task.runs.map((run) =>
            run.role === "review" && run.open && run.ending === undefined
              ? { ...run, commit }
              : run,
          ),
        })),
      ),
    recordCheck: (check: CheckRun) =>
      this.write("prog.recordCheck", () =>
        this.update(check.task, (task) => ({
          ...task,
          runs: [
            ...task.runs,
            {
              id: task.runs.length + 1,
              task: check.task,
              role: "check" as const,
              rung: undefined,
              node: check.node,
              commit: check.commit,
              ending: check.ending,
              rounds: undefined,
              open: false,
            },
          ],
        })),
      ),
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
    holdsWork: (directory: string) => Effect.sync(() => this.dirty.has(directory)),
    commitWork: (directory: string, message: string) =>
      this.write("repository.commitWork", () => {
        this.commits.push(message);
        this.dirty.delete(directory);
      }),
    base: () => Effect.succeed("base"),
    tip: (_directory: string, branch: string) =>
      Effect.succeed(this.movedTips.get(branch) ?? this.branches.get(branch)?.tip),
    branches: () => Effect.succeed([...this.branches.values()]),
    remove: (_directory: string, branch: string) =>
      this.write("repository.remove", () => {
        this.removed.push(branch);
        return this.branches.delete(branch);
      }),
    // `setup` answers `undefined` when the project has no setup script; `Effect.void` would not type as that answer.
    setup: () => this.write("repository.setup", () => undefined),
    merge: (
      _directory: string,
      ref: string,
      _verify: string | undefined,
      _proving: string,
      message: string,
    ) =>
      this.write("repository.merge", () => {
        this.merged.push(ref);
        this.mergeMessages.push(message);
        return this.landing;
      }),
    check: (_directory: string, commit: string, command: string) =>
      this.write("repository.check", () => {
        this.checked.push([commit, command]);
        return this.checking;
      }),
    // Worktrees are the fleet adapter's concern; the world's fleet is faked whole.
    worktrees: () => Effect.die("unused"),
    addWorktree: () => Effect.die("unused"),
    removeWorktree: () => Effect.die("unused"),
    restoreBranch: () => Effect.die("unused"),
  };

  /**
   * Every write a fake makes passes through here, so a test can assert that a
   * tick wrote nothing to the task store, git, the multiplexer or the runs.
   */
  write<A>(name: string, body: () => A) {
    return Effect.sync(() => {
      this.writes.push(name);
      return body();
    });
  }

  private openRun(id: string, run: NewRun): number {
    const opened = (this.tasks.get(id)?.runs.length ?? 0) + 1;
    this.update(id, (task) => ({
      ...task,
      runs: [
        ...task.runs,
        {
          id: task.runs.length + 1,
          task: id,
          role: run.work === "review" ? "review" : "author",
          rung: run.rung,
          node: run.node,
          commit: run.commit,
          ending: undefined,
          rounds: undefined,
          open: true,
        },
      ],
    }));
    return opened;
  }

  /** Closes the open runs that have an ending for their role, keeping an ending already stated. */
  private closeRuns(
    id: string,
    endings: { author?: Ending; review?: Ending; commit?: string | undefined },
  ): void {
    this.update(id, (task) => ({
      ...task,
      runs: task.runs.map((run) => {
        const ending = run.role === "review" ? endings.review : endings.author;
        return run.open && ending !== undefined
          ? {
              ...run,
              open: false,
              ending: run.ending ?? ending,
              commit: run.role === "author" ? (endings.commit ?? run.commit) : run.commit,
            }
          : run;
      }),
    }));
  }

  private update(id: string, change: (task: Item) => Item): void {
    const task = this.tasks.get(id);
    if (task) this.tasks.set(id, change(task));
  }
}

const prompts = Layer.succeed(Prompts, {
  author: () => Effect.succeed("author"),
  onboard: () => Effect.succeed("onboard"),
  review: () => Effect.succeed("review"),
  diagnose: () => Effect.succeed("diagnose"),
});

/** A policy that lets the fleet take every step by itself, one agent at a time. */
const ALLOWED = {
  slots: 1,
  default: { author: "on", climb: "on", review: "on", land: "on" } as const,
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
// A pipelines file that does not exist: every project runs the standard
// pipeline, and the operator's own drawings stay out of the tests.
const operatorPipelines = process.env["FOREMAN_PIPELINES"];
process.env["FOREMAN_PIPELINES"] = join(policies, "pipelines.json");
afterAll(() => {
  rmSync(policies, { recursive: true, force: true });
  if (operatorPolicy === undefined) delete process.env["FOREMAN_POLICY"];
  else process.env["FOREMAN_POLICY"] = operatorPolicy;
  if (operatorPipelines === undefined) delete process.env["FOREMAN_PIPELINES"];
  else process.env["FOREMAN_PIPELINES"] = operatorPipelines;
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
    const task = item("ts-kill", "in_progress", ["attempt:cheap:1"], "test", [authorRun("cheap")]);
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
    expect(world.tasks.get(task.id)?.labels).toEqual(["attempt:cheap:1"]);
    expect(world.logs).toEqual([
      [task.id, "foreman: operator killed this attempt: tests caught the wrong path"],
    ]);
  });

  test("writes the bare kill note and refills the freed slot", async () => {
    const task = item("ts-kill-default", "reviewing", ["attempt:cheap:1"], "test", [
      handedOff("cheap"),
    ]);
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
    expect(world.tasks.get(task.id)?.labels).toEqual(["attempt:cheap:1"]);
    expect(world.logs).toContainEqual([task.id, "foreman: operator killed this attempt"]);
    expect(world.spawned).toEqual([[task.id, "author"]]);
  });

  test("settles an author handoff without climbing", async () => {
    const task = item("ts-author", "reviewing", [], "test", [handedOff("cheap")]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.labels).toEqual([]);
    expect(reviewerOf(world, task.id)).toBe("cheap");
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("allows a settled role to receive the next dispatch", async () => {
    const task = item("ts-settled", "reviewing", [], "test", [handedOff("cheap")]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
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
          tip: "c1",
        },
      ],
    ] as const) {
      const task = item(id, "in_progress", [], "test", [authorRun("cheap")]);
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
    const kept = item("ts-kept", "reviewing", [], "test", [handedOff("cheap")]);
    const world = new World(swept, kept);
    world.branches.set("foreman/ts-swept", {
      branch: "foreman/ts-swept",
      merged: true,
      empty: false,
      stale: undefined,
      tip: "c1",
    });
    world.branches.set("foreman/ts-kept", {
      branch: "foreman/ts-kept",
      merged: true,
      empty: false,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.branches.has("foreman/ts-swept")).toBe(false);
    expect(world.branches.has("foreman/ts-kept")).toBe(true);
    expect(world.removed).toEqual(["foreman/ts-swept"]);
  });

  test("keeps the branch of a merged workspace whose task was deleted", async () => {
    const world = new World();
    world.workers.set("ts-orphan", worker("ts-orphan", "author", "working"));
    world.branches.set("foreman/ts-orphan", {
      branch: "foreman/ts-orphan",
      merged: true,
      empty: false,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.removed).toEqual([]);
    expect(world.branches.has("foreman/ts-orphan")).toBe(true);
  });

  test("closes the author run of a handoff when the reviewer is assigned", async () => {
    const task = item("ts-empty", "reviewing", [], "test", [authorRun("cheap")]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.runs).toMatchObject([
      { role: "author", open: false, ending: "handed-off", commit: "c1" },
      { role: "review", open: true, commit: "c1" },
    ]);
  });

  test("leaves the run of a live author open", async () => {
    const task = item("ts-live", "in_progress", [], "test", [authorRun("cheap")]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "working"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.runs).toMatchObject([{ open: true, ending: undefined }]);
  });

  test("returns a review handoff with no commit to the queue", async () => {
    const task = item("ts-empty", "reviewing", [], "test", [handedOff("cheap")]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: true,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
    expect(world.spawned).toEqual([[task.id, "author"]]);
  });

  test("reviews an empty branch whose author found the trunk already satisfies it", async () => {
    const task = item("ts-satisfied", "reviewing", [], "test", [
      authorRun("cheap", { open: false, ending: "satisfied" }),
    ]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: true,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("reviewing");
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("closes a satisfied task the reviewer approved, merging nothing", async () => {
    const task = item("ts-confirmed", "reviewing", [], "test", [
      authorRun("cheap", { open: false, ending: "satisfied" }),
      reviewRun("cheap", { ending: "approved", commit: "c1" }),
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
      tip: "c1",
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("done");
    expect(world.closed).toContain(task.id);
  });

  test("reviews an empty branch whose task's deliverable is a research report", async () => {
    const task = item("ts-research", "reviewing", ["research"], "test", [handedOff("cheap")]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: true,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("reviewing");
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("closes a research task the reviewer approved, merging nothing", async () => {
    const task = item("ts-research-confirmed", "reviewing", ["research"], "test", [
      handedOff("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1" }),
    ]);
    const world = new World(task);
    world.landing = { _tag: "Present" };
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: true,
      empty: true,
      stale: undefined,
      tip: "c1",
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
    const task = item("ts-approved", "reviewing", [], "test", [
      handedOff("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1" }),
    ]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("done");
    expect(world.closed).toContain(task.id);
  });

  test("a commit after the approval voids it: nothing lands", async () => {
    const task = item("ts-voided", "reviewing", [], "test", [
      handedOff("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1" }),
    ]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "review", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c2",
    });

    await tick(world);

    expect(world.merged).toEqual([]);
    // The approval covered c1; the next reviewer reads c2.
    expect(world.tasks.get(task.id)?.status).toBe("reviewing");
    expect(world.spawned).toEqual([[task.id, "review"]]);
    expect(world.tasks.get(task.id)?.runs.at(-1)).toMatchObject({
      role: "review",
      open: true,
      commit: "c2",
    });
  });

  test("land refuses a tip that moved after it was observed", async () => {
    const task = item("ts-moved", "reviewing", [], "test", [
      handedOff("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1" }),
    ]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });
    world.movedTips.set(`foreman/${task.id}`, "c2");

    await tick(world);

    expect(world.merged).toEqual([]);
    expect(world.tasks.get(task.id)?.status).toBe("reviewing");
  });

  test("a landing merges the approved commit and closes the lap's runs", async () => {
    // The landing takes the task's terminals down, so no later settle sees
    // them: the runs must be closed here or never.
    const task = item("ts-landed", "reviewing", [], "test", [
      handedOff("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1" }),
    ]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "review", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("done");
    expect(world.mergeMessages).toEqual([`Merge foreman/${task.id}: ${task.title}`]);
    expect(world.merged).toEqual(["c1"]);
    expect(world.tasks.get(task.id)?.runs.some((run) => run.open)).toBe(false);
  });
});

describe("a correction round", () => {
  /** A review of c1 under way, and a branch at c2 that the correction committed. */
  const corrected = () => {
    const task = item("ts-corrected", "reviewing", [], "test", [
      handedOff("cheap"),
      reviewRun("dear", { commit: "c1" }),
    ]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c2",
    });
    world.workers.set(task.id, worker(task.id, "review", "settled"));
    return { task, world };
  };

  const approve = (world: World, id: string) => {
    const task = world.tasks.get(id)!;
    world.tasks.set(id, {
      ...task,
      runs: task.runs.map((run) => (run.role === "review" ? { ...run, ending: "approved" } : run)),
    });
  };

  test("lands the tip the round left when the reviewer approves it", async () => {
    const { task, world } = corrected();

    await Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.corrected(task.id)).pipe(
        Effect.provide(layerFor(world)),
      ),
    );
    approve(world, task.id);
    await tick(world);

    expect(world.merged).toEqual(["c2"]);
    expect(world.tasks.get(task.id)?.status).toBe("done");
  });

  test("an approval of the old tip, given before the round ended, stays on it", async () => {
    const { task, world } = corrected();
    approve(world, task.id);

    await Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.corrected(task.id)).pipe(
        Effect.provide(layerFor(world)),
      ),
    );
    await tick(world);

    expect(world.merged).toEqual([]);
    expect(world.tasks.get(task.id)?.runs.find((run) => run.ending === "approved")?.commit).toBe(
      "c1",
    );
  });
});

describe("a fleet that is not running", () => {
  const unmerged = (task: string): Branch => ({
    branch: `foreman/${task}`,
    merged: false,
    empty: false,
    stale: undefined,
    tip: "c1",
  });

  /**
   * A world in which every pass of a running tick has something to write: a
   * settled author whose branch is empty, an approved task to land, a merged branch to
   * sweep, a stale claim to release, a done task's branch to recover, and a
   * queued task to start. The grant names no task, so a running tick would
   * also expire it.
   */
  const busy = () => {
    const settled = item("ts-settled", "reviewing", [], "test", [handedOff("cheap")]);
    const approved = item("ts-approved", "reviewing", [], "test", [
      handedOff("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1" }),
    ]);
    const swept = item("ts-swept", "canceled", []);
    const stale = {
      ...item("ts-stale", "in_progress", [], "test", [authorRun("cheap")]),
      lastActivityAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    };
    const abandoned = item("ts-abandoned", "done", [], "test", [handedOff("cheap")]);
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
    default: { author: "on", climb: "on", review: "on", land: "on" } as const,
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
    const ours = {
      ...item("ts-ours", "in_progress", [], "test", [authorRun("cheap")]),
      lastActivityAt: old,
    };
    const byHand = { ...item("ts-by-hand", "in_progress", []), lastActivityAt: old };
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
        quotaSpending(spent),
        prompts,
        BunServices.layer,
      ),
    );

  /** A task whose author finished, waiting to be read. */
  const awaiting = (id: string) => {
    const task = item(id, "reviewing", [], "test", [handedOff("cheap")]);
    const world = new World(task);
    world.workers.set(id, worker(id, "author", "settled"));
    world.branches.set(`foreman/${id}`, {
      branch: `foreman/${id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
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
    const rungs = world.tasks.values().map((task) => authoredBy(task));
    expect(new Set(rungs)).toEqual(new Set(["cheap", "dear"]));
  });

  test("reviews with the rung above the wall rather than waiting on money", async () => {
    // "cheap" wrote it, so "dear" reads it — and "dear" is on another account,
    // which the wall on openai says nothing about.
    const world = awaiting("ts-skips");
    await tickWith(world, ["openai"]);

    expect(world.spawned).toEqual([["ts-skips", "review"]]);
    expect(reviewerOf(world, "ts-skips")).toBe("dear");
  });

  test("leaves the task alone when every account above is spent", async () => {
    const world = awaiting("ts-walled");
    await tickWith(world, ["openai", "anthropic"]);

    // No reviewer, and nothing written: the rung is untouched and no attempt is
    // counted, so the task is read again unchanged once an allowance resets.
    expect(world.spawned).toEqual([]);
    expect(world.tasks.get("ts-walled")?.labels).toEqual([]);
    expect(world.tasks.get("ts-walled")?.status).toBe("reviewing");
  });

  test("substitutes a reviewer without climbing the task's own rung", async () => {
    // A dearer reviewer is what the wallet forced, not what the work earned, so
    // the task keeps the rung it had and its next author is unchanged.
    const task = item("ts-rung", "reviewing", ["attempt:cheap:1"], "test", [handedOff("cheap")]);
    const world = new World(task);
    world.workers.set(task.id, worker(task.id, "author", "settled"));
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });

    await tickWith(world, ["openai"]);

    expect(world.tasks.get(task.id)?.labels).toEqual(["attempt:cheap:1"]);
    expect(reviewerOf(world, task.id)).toBe("dear");
  });

  test("takes the cheapest rung nothing has recorded against the task", async () => {
    const world = new World(item("ts-fresh", "open", []));
    await tickWith(world, []);

    expect(world.spawned).toEqual([["ts-fresh", "author"]]);
    expect(authoredBy(world.tasks.get("ts-fresh")!)).toBe("cheap");
  });

  test("takes the rung above a recorded failure", async () => {
    const world = new World(item("ts-failed", "open", ["failed-by:cheap"]));
    await tickWith(world, []);

    expect(authoredBy(world.tasks.get("ts-failed")!)).toBe("dear");
  });

  test("steps an author over a spent account rather than parking the task", async () => {
    // Nothing is recorded against the task: the wall is the wallet's, so the
    // cheap rung is chosen again the moment the account resets.
    const world = new World(item("ts-money", "open", []));
    await tickWith(world, ["openai"]);

    expect(authoredBy(world.tasks.get("ts-money")!)).toBe("dear");
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
    const task = item("ts-sent-back", "open", [], "test", [handedOff("cheap"), reviewRun("dear")]);
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
      tip: "c1",
    });

    await tickWith(world, []);

    const labels = world.tasks.get(task.id)?.labels ?? [];
    expect(labels).toContain("failed-by:cheap");
    expect(labels.filter((label) => label.startsWith("failed-by:"))).toEqual(["failed-by:cheap"]);
  });
});

/**
 * Ticks once, then reads back the asks that tick published. Asks are part of
 * the reading, so the test sees what `foreman approve` and the panel would.
 */
const asksAfter = (world: World) =>
  Effect.runPromise(
    Dispatcher.use((dispatcher) =>
      dispatcher.tick.pipe(Effect.andThen(SubscriptionRef.get(dispatcher.state))),
    ).pipe(Effect.provide(layerFor(world))),
  ).then((state) => state.asks.map(({ task, step, rung }) => ({ task: task.id, step, rung })));

describe("a step set to ask", () => {
  const off = { author: "off", climb: "off", review: "off", land: "off" } as const;
  const unmerged = (task: string): Branch => ({
    branch: `foreman/${task}`,
    merged: false,
    empty: false,
    stale: undefined,
    tip: "c1",
  });

  test("a review ask writes nothing and reports the reviewer it is waiting on", async () => {
    usePolicy({ slots: 1, default: { ...off, review: "ask" } });
    const task = item("ts-ask-review", "reviewing", [], "test", [handedOff("cheap")]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, unmerged(task.id));

    const asks = await asksAfter(world);

    expect(asks).toEqual([{ task: task.id, step: "review", rung: "cheap" }]);
    expect(world.spawned).toEqual([]);
    expect(world.writes).toEqual([]);
  });

  test("approving a review ask starts exactly that review on the next tick", async () => {
    const task = item("ts-approve-review", "reviewing", [], "test", [handedOff("cheap")]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, unmerged(task.id));
    usePolicy({
      slots: 1,
      default: { ...off, review: "ask" },
      grants: [{ scope: task.id, steps: ["review"], remaining: 1, admitted: [] }],
    });

    await asksAfter(world);

    expect(world.spawned).toEqual([[task.id, "review"]]);
    expect(world.writes).not.toContain("repository.merge");
  });

  test("a land ask writes nothing until its approval grant lands the task", async () => {
    usePolicy({ slots: 1, default: { ...off, land: "ask" } });
    const task = item("ts-ask-land", "reviewing", [], "test", [
      handedOff("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1" }),
    ]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, unmerged(task.id));

    const asks = await asksAfter(world);

    expect(asks).toEqual([{ task: task.id, step: "land", rung: "cheap" }]);
    expect(world.tasks.get(task.id)?.status).toBe("reviewing");
    expect(world.writes).toEqual([]);

    usePolicy({
      slots: 1,
      default: { ...off, land: "ask" },
      grants: [{ scope: task.id, steps: ["land"], remaining: 1, admitted: [] }],
    });
    await asksAfter(world);

    expect(world.tasks.get(task.id)?.status).toBe("done");
  });

  test("an author ask lists at most the free slots and starts nothing", async () => {
    usePolicy({ slots: 1, default: { ...off, author: "ask" } });
    const world = new World(item("ts-a", "open", []), item("ts-b", "open", []));

    const asks = await asksAfter(world);

    expect(asks.map(({ task }) => task)).toEqual(["ts-a"]);
    expect(world.spawned).toEqual([]);
    expect(world.writes).toEqual([]);
  });
});

describe("approving an ask", () => {
  test("writes the grant the next tick takes, and only for the asked step", async () => {
    usePolicy({ slots: 1, default: { author: "off", climb: "off", review: "ask", land: "ask" } });
    const task = item("ts-approve-real", "reviewing", [], "test", [handedOff("cheap")]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });
    const [ask] = await asksAfter(world).then((asks) => asks);
    expect(ask).toEqual({ task: task.id, step: "review", rung: "cheap" });

    await Effect.runPromise(
      Dispatcher.use((dispatcher) =>
        dispatcher.approve({ task, step: "review", rung: "cheap" }),
      ).pipe(Effect.provide(layerFor(world))),
    );

    expect(JSON.parse(readFileSync(process.env["FOREMAN_POLICY"] ?? "", "utf8")).grants).toEqual([
      { scope: task.id, steps: ["review"], remaining: 1, admitted: [] },
    ]);
    await tick(world);
    expect(world.spawned).toEqual([[task.id, "review"]]);
    expect(world.tasks.get(task.id)?.status).toBe("reviewing");
  });
});

describe("unassign", () => {
  test("ends a stale review with no failure, so the same rung may review again", async () => {
    const task = item("ts-stale", "open", [], "test", [handedOff("low"), reviewRun("mid")]);
    const world = new World(task);

    await Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.unassign(task)).pipe(
        Effect.provide(layerFor(world)),
      ),
    );

    const runs = world.tasks.get(task.id)?.runs ?? [];
    expect(runs.at(-1)).toMatchObject({ rung: "mid", open: false, ending: "released" });
    expect(reviewFailedBy({ runs })).toEqual([]);
  });
});

describe("a usage wall", () => {
  /** A free opencode rung, cheapest, then a rung on another account. */
  const layerFor = (world: World) =>
    Layer.provideMerge(
      Dispatcher.Default,
      Layer.mergeAll(
        Layer.succeed(Settings, {
          ladder: [
            {
              name: "free",
              harness: "opencode",
              model: "opencode/free-model",
              provider: undefined,
            },
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
        Layer.succeed(Quota, {
          usage: (provider: string) =>
            Effect.succeed({ provider, plan: undefined, allowances: [] }),
        }),
        prompts,
        BunServices.layer,
      ),
    );

  const tick = (world: World) =>
    Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.tick).pipe(Effect.provide(layerFor(world))),
    );

  /** An author that stopped on the free rung, with its worktree holding edits. */
  const stoppedOn = (id: string, screen: string, dirty: boolean) => {
    const task = item(id, "in_progress", [], "test", [authorRun("free")]);
    const world = new World(task);
    world.workers.set(id, { ...worker(id, "author", "settled"), repository: "/build/test" });
    if (dirty) world.dirty.add(`/worktree/${id}`);
    world.screens.set(id, screen);
    return world;
  };

  test("hands the task to another account and keeps its work, its attempts and its rung", async () => {
    const world = stoppedOn(
      "ts-walled",
      [
        "› ship the handoff",
        "",
        "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to",
        "",
        "  ctrl+p commands",
      ].join("\n"),
      true,
    );

    await tick(world);

    const labels = world.tasks.get("ts-walled")?.labels ?? [];
    expect(world.commits).toHaveLength(1);
    expect(world.commits[0]).toContain("stopped on a usage limit before verifying");
    expect(labels).toContain("walled:opencode");
    expect(labels.some((label) => label.startsWith("attempt:"))).toBe(false);
    expect(labels.some((label) => label.startsWith("failed-by:"))).toBe(false);
    expect(world.tasks.get("ts-walled")?.runs[0]).toMatchObject({ open: false, ending: "walled" });
    expect(world.logs.map(([, message]) => message).join("\n")).toContain("opencode");
    // Settle runs before fill in the same tick, so the next author is already
    // dispatched onto the rung on the other account.
    expect(authoredBy(world.tasks.get("ts-walled")!)).toBe("dear");
    expect(world.spawned).toContainEqual(["ts-walled", "author"]);
  });

  test("hands a review to another account without recording a reviewer failure", async () => {
    const task = item("ts-review-wall", "reviewing", [], "test", [
      handedOff("free"),
      reviewRun("free"),
    ]);
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
      tip: "c1",
    });
    world.screens.set(task.id, "Free usage limit reached. Connect a provider");

    await tick(world);

    const found = world.tasks.get(task.id);
    expect(found?.status).toBe("reviewing");
    expect(found?.labels).toContain("walled:opencode");
    expect(found?.runs.some((run) => run.ending === "no-verdict")).toBe(false);
    expect(reviewerOf(world, task.id)).toBe("dear");
  });

  test("commits nothing when the worktree holds no uncommitted work", async () => {
    const world = stoppedOn(
      "ts-walled-clean",
      "Free usage limit reached. Connect a provider",
      false,
    );

    await tick(world);

    expect(world.commits).toHaveLength(0);
    expect(world.tasks.get("ts-walled-clean")?.labels).toContain("walled:opencode");
  });

  test("a stop with no wall text on its screen goes through unfinished as before", async () => {
    const world = stoppedOn("ts-plain", "all done\n  ctrl+p commands", true);

    await tick(world);

    const labels = world.tasks.get("ts-plain")?.labels ?? [];
    expect(labels).toContain("attempt:free:1");
    expect(labels.some((label) => label.startsWith("walled:"))).toBe(false);
    expect(world.commits).toHaveLength(0);
    expect(world.tasks.get("ts-plain")?.runs[0]).toMatchObject({
      open: false,
      ending: "unfinished",
    });
  });

  test("a quoted wall higher up the screen than the stop is no wall", async () => {
    const quoted = "Free usage limit reached is the message foreman looks for.";
    const world = stoppedOn(
      "ts-quoted",
      [quoted, ...Array.from({ length: 20 }, (_, i) => `working line ${i}`)].join("\n"),
      false,
    );

    await tick(world);

    expect(world.tasks.get("ts-quoted")?.labels.some((label) => label.startsWith("walled:"))).toBe(
      false,
    );
  });
});

describe("a policy change", () => {
  test("is published within a second, not at the next poll", async () => {
    usePolicy({ ...ALLOWED, paused: true });
    const waited = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dispatcher = yield* Dispatcher;
          yield* Effect.forkScoped(dispatcher.run);
          const read = SubscriptionRef.get(dispatcher.state);
          // The first tick has published once the reading carries a time; the
          // next one is a full poll interval (60 s) away.
          yield* read.pipe(
            Effect.filterOrFail((s) => s.observedAt !== undefined),
            Effect.retry(Schedule.spaced("20 millis")),
          );
          const started = Date.now();
          yield* updatePolicy(policyPath(), (policy) => ({ ...policy, slots: 7 }));
          yield* read.pipe(
            Effect.filterOrFail((s) => s.policy.slots === 7),
            Effect.retry(Schedule.spaced("20 millis")),
            Effect.timeout("3 seconds"),
          );
          return Date.now() - started;
        }),
      ).pipe(Effect.provide(layerFor(new World()))),
    );

    expect(waited).toBeLessThan(1000);
  });
});

describe("a reviewer that stops without a verdict", () => {
  /** Three rungs on three accounts, so a review has two rungs to climb. */
  const layerFor = (world: World) =>
    Layer.provideMerge(
      Dispatcher.Default,
      Layer.mergeAll(
        Layer.succeed(Settings, {
          ladder: [
            { name: "low", harness: "test", model: "a/low", provider: undefined },
            { name: "mid", harness: "test", model: "b/mid", provider: undefined },
            { name: "high", harness: "test", model: "c/high", provider: undefined },
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
        Layer.succeed(Quota, {
          usage: (provider: string) =>
            Effect.succeed({ provider, plan: undefined, allowances: [] }),
        }),
        prompts,
        BunServices.layer,
      ),
    );

  const tick = (world: World) => {
    usePolicy({ ...ALLOWED, slots: 1 });
    return Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.tick).pipe(Effect.provide(layerFor(world))),
    );
  };

  /** A task whose `reviewer` rung stopped with the pane settled and no verdict. */
  const stopped = (id: string, runs: ReadonlyArray<Run>) => {
    const world = new World(item(id, "reviewing", [], "test", runs));
    world.workers.set(id, { ...worker(id, "review", "settled"), repository: "/build/test" });
    world.branches.set(`foreman/${id}`, {
      branch: `foreman/${id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });
    return world;
  };

  test("keeps the task in review, charges no attempt, and dispatches a higher reviewer", async () => {
    const world = stopped("ts-stopped", [handedOff("low"), reviewRun("mid")]);

    await tick(world);

    const task = world.tasks.get("ts-stopped");
    expect(task?.status).toBe("reviewing");
    expect(task?.labels).toEqual([]);
    expect(task?.runs.slice(1)).toMatchObject([
      { rung: "mid", open: false, ending: "no-verdict" },
      { rung: "high", open: true },
    ]);
    expect(world.spawned).toEqual([["ts-stopped", "review"]]);
  });

  test("keeps recorded reviewer failures and the satisfied claim when a spawn fails", async () => {
    const world = stopped("ts-spawn", [
      authorRun("low", { open: false, ending: "satisfied" }),
      reviewRun("mid"),
    ]);
    world.spawnFails.add("ts-spawn");

    await tick(world).catch(() => undefined);

    const runs = world.tasks.get("ts-spawn")?.runs ?? [];
    expect(runs).toMatchObject([
      { role: "author", ending: "satisfied" },
      { rung: "mid", open: false, ending: "no-verdict" },
    ]);
    expect(world.tasks.get("ts-spawn")?.status).toBe("reviewing");
  });

  test("hands the task to the operator when no reviewer rung is left", async () => {
    const world = stopped("ts-last", [
      handedOff("low"),
      reviewRun("mid", { open: false, ending: "no-verdict" }),
      reviewRun("high"),
    ]);

    await tick(world);

    const task = world.tasks.get("ts-last");
    expect(task?.status).toBe("open");
    expect(task?.labels).toEqual(["needs-you"]);
    expect(world.spawned).toEqual([]);
  });
});

describe("a drawn pipeline", () => {
  const drawn = join(policies, "pipelines.json");
  const draw = (nodes: ReadonlyArray<PipelineNode>) =>
    writeFileSync(drawn, JSON.stringify({ test: { nodes } }));
  afterEach(() => rmSync(drawn, { force: true }));

  /** The standard pipeline with `change` made to its author block. */
  const withAuthor = (change: (author: AgentNode) => ReadonlyArray<PipelineNode>) =>
    STANDARD_PIPELINE.nodes.flatMap((node) =>
      node.kind === "agent" && node.id === "author" ? change(node) : [node],
    );

  /** A task its author handed off on commit c1, which is its branch's tip. */
  const handedOver = (id: string) => {
    const world = new World(item(id, "reviewing", [], "test", [handedOff("cheap", "c1")]));
    world.workers.set(id, worker(id, "author", "settled"));
    world.branches.set(`foreman/${id}`, {
      branch: `foreman/${id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });
    return world;
  };

  test("an agent block pinned to a rung dispatches that rung", async () => {
    draw(withAuthor((author) => [{ ...author, model: "dear" }]));
    const world = new World(item("ts-pinned", "open", []));
    await Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.tick).pipe(
        Effect.provide(
          Layer.provideMerge(
            Dispatcher.Default,
            Layer.mergeAll(
              Layer.succeed(Settings, {
                ladder: [
                  { name: "cheap", harness: "test", model: undefined, provider: undefined },
                  { name: "dear", harness: "test", model: undefined, provider: undefined },
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
              Quota.Default,
              prompts,
              BunServices.layer,
            ),
          ),
        ),
      ),
    );

    expect(world.spawned).toEqual([["ts-pinned", "author"]]);
    expect(authoredBy(world.tasks.get("ts-pinned")!)).toBe("dear");
  });

  test("an agent block with slots of its own runs no more of its tasks at once", async () => {
    usePolicy({ ...ALLOWED, slots: 3 });
    draw(withAuthor((author) => [{ ...author, slots: 1 }]));
    const world = new World(item("ts-first", "open", []), item("ts-second", "open", []));
    await tick(world);
    expect(world.spawned).toEqual([["ts-first", "author"]]);

    // The first author is still at work, so the block stays full.
    await tick(world);
    expect(world.spawned).toEqual([["ts-first", "author"]]);
  });

  test("a park block hands the task to the operator once", async () => {
    draw(
      STANDARD_PIPELINE.nodes
        .map((node) =>
          node.kind === "router" && node.id === "retry"
            ? { ...node, routes: [{ when: "label:hold", to: "operator" }, ...node.routes] }
            : node,
        )
        .concat([{ kind: "park", id: "operator" }]),
    );
    const world = new World(item("ts-parked", "open", ["hold"]));
    await tick(world);
    await tick(world);

    expect(world.tasks.get("ts-parked")?.labels).toEqual(["hold", "needs-you"]);
    expect(world.writes.filter((write) => write === "prog.parkForOperator")).toHaveLength(1);
    expect(world.spawned).toEqual([]);
  });

  describe("with a check after the author", () => {
    beforeEach(() =>
      draw(
        withAuthor((author) => [
          { ...author, next: "lint-gate" },
          { kind: "gate", id: "lint-gate", step: "review", next: "lint" },
          { kind: "check", id: "lint", command: "bun run lint", next: "review-gate" },
        ]),
      ),
    );

    test("a pass records the commit it ran on, and the same tick sends the reviewer", async () => {
      const world = handedOver("ts-lint");
      await tick(world);

      expect(world.checked).toEqual([["c1", "bun run lint"]]);
      expect(world.tasks.get("ts-lint")?.runs.find((run) => run.role === "check")).toMatchObject({
        node: "lint",
        commit: "c1",
        ending: "passed",
      });
      expect(world.spawned).toEqual([["ts-lint", "review"]]);
    });

    test("a commit after the pass is checked again before the next review", async () => {
      const world = handedOver("ts-moved");
      await tick(world);
      // The reviewer approves c1, and then someone commits c2 on the branch.
      await Effect.runPromise(world.prog.endReview("ts-moved", "approved"));
      world.workers.set("ts-moved", worker("ts-moved", "review", "settled"));
      world.branches.set("foreman/ts-moved", {
        ...world.branches.get("foreman/ts-moved")!,
        tip: "c2",
      });
      await tick(world);

      expect(world.checked).toEqual([
        ["c1", "bun run lint"],
        ["c2", "bun run lint"],
      ]);
      expect(world.merged).toEqual([]);
    });

    test("a failure returns the task a rung up with the output in its log", async () => {
      const world = handedOver("ts-red");
      world.checking = { _tag: "Failed", output: "lint: 3 problems" };
      await tick(world);

      const task = world.tasks.get("ts-red");
      expect(task?.status).toBe("open");
      expect(task?.labels).toContain("failed-by:cheap");
      expect(task?.runs.at(-1)).toMatchObject({ role: "check", commit: "c1", ending: "failed" });
      expect(
        world.logs.some(([id, message]) => id === "ts-red" && message.includes("lint: 3 problems")),
      ).toBe(true);
      expect(world.notifications).toContain("Check failed");
    });

    test("a ground that is not ready records nothing, and the check runs again", async () => {
      const world = handedOver("ts-held");
      world.checking = { _tag: "Held", detail: "index.lock" };
      await tick(world);
      expect(world.tasks.get("ts-held")?.runs.filter((run) => run.role === "check")).toEqual([]);

      world.checking = { _tag: "Passed", verified: true };
      await tick(world);
      expect(world.checked).toHaveLength(2);
    });
  });
});

describe("foreman pipeline place", () => {
  test("prints where each task stands, and writes nothing", async () => {
    const queued = item("ts-queued", "open", []);
    const approved = withRuns(
      item("ts-approved", "reviewing", [], "test", [handedOff("cheap", "c1")]),
      [reviewRun("cheap", { ending: "approved", commit: "c1" })],
      "c1",
    );
    const world = new World(queued, approved);
    world.branches.set(`foreman/${approved.id}`, {
      branch: `foreman/${approved.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });
    const store = scratchStore();
    const printed: Array<string> = [];

    await Effect.runPromise(
      Command.runWith(pipelineCommand(layerFor(world)), { version: "test" })(["place"]).pipe(
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (...args: ReadonlyArray<string>) => printed.push(args.join(" ")),
        }),
        Effect.provide(Layer.merge(BunServices.layer, store.layer)),
        Effect.ensuring(Effect.sync(store.cleanup)),
      ),
    );

    expect(printed).toEqual([
      "ts-queued  test  at author waiting  gates: start (author)  ahead: 2  ts-queued",
      "ts-approved  test  at land waiting  gates: land-gate (land)  ahead: 0  ts-approved",
    ]);
    expect(world.writes).toEqual([]);
    expect(world.spawned).toEqual([]);
  });
});
