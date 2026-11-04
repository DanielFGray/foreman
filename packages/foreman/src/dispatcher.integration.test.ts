import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Console, Effect, Layer, Option, Schedule, SubscriptionRef } from "effect";
import { Command } from "effect/cli";
import { policyPath, updatePolicy } from "./policy.ts";
import { Dispatcher } from "./dispatcher.ts";
import {
  directoryFor,
  Fleet,
  FleetError,
  type AgentRole,
  type Worker,
  type WorkerState,
} from "./fleet.ts";
import { Settings } from "./config.ts";
import { attemptsOf, failuresOf, Records, walledBy, type Endings, type Item } from "./records.ts";
import { applyRow, NO_WRITES, openAgentOf, type Row } from "./run-step.ts";
import { Tracker, TrackerError } from "./tracker.ts";
import type { Run } from "tasks";
import { type AgentRun, Prompts } from "./prompt.ts";
import { Quota } from "./quota.ts";
import { Repository, type Branch, type Checked, type Hold, type Landing } from "./repository.ts";
import type { Ending, NewRun, Role } from "tasks";
import { authoredBy, reviewFailedBy } from "./lap.ts";
import { authorRun, authorDone, charged, reviewRun, stoppedRun, withRuns } from "./task-fixture.ts";
import type { Ladder } from "./ladder.ts";
import type { Reviewer } from "./reviewers.ts";
import { pipelineCommand } from "./pipeline-command.ts";
import {
  type AgentNode,
  type Pipeline,
  type PipelineNode,
  place,
  STANDARD_PIPELINES,
} from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";
import { traceOf, type TraceEvent } from "./pipeline-trace.ts";
import { scratchStore } from "./scratch-store.ts";
import { fakeGh } from "./github-fixture.ts";
import type { GhOptions, GhResult } from "./github.ts";

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
      charges: [],
      parked: undefined,
      tip: undefined,
    },
    runs,
  );

/**
 * The id of the task's newest run; none when it has no runs. A new run takes
 * the next id, so ids order runs the way the store's do, which charges and
 * walls read.
 */
const newestRun = (task: Item): number | undefined =>
  task.runs.length === 0 ? undefined : Math.max(...task.runs.map((run) => run.id));

/** The rung of the task's open review run, if a reviewer is assigned. */
const reviewerOf = (world: World, id: string) =>
  world.tasks.get(id)?.runs.find((run) => run.open && run.role === "review")?.rung;

const worker = (task: string, role: "author" | "review", state: WorkerState): Worker => ({
  task,
  repository: "/home/dan/build/project",
  directory: `/worktree/${task}`,
  worktree: `/worktree/${task}`,
  state,
  since: undefined,
  roles: new Map([[role, { state, since: undefined }]]),
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
  /**
   * Tasks whose next completion fails after the records are written, as on a
   * tracker that shares no transaction with them.
   */
  readonly completeFails = new Set<string>();
  /** Projects whose tracker does not answer, as GitHub does when it cannot be reached. */
  readonly unreachable = new Set<string>();
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
  /** The rows `records.write` received, oldest first. */
  readonly rows: Row[] = [];
  clean: "clean" | "held" = "clean";
  /** The task branch the project's checkout has out (branch mode), if any. */
  checkedOut: string | undefined = undefined;
  /** Whether the checkout has uncommitted changes, which a start in the checkout refuses. */
  treeDirty = false;
  /** The commit the checkout's HEAD names. */
  headCommit = "h0";
  /** Each push a landing made: the branch and the commit. */
  readonly pushed: Array<[string, string]> = [];
  /** The head of each branch on the remote, which a fetch takes. */
  readonly remoteHeads = new Map<string, string>();
  /** The `ancestor..descendant` pairs git would say descend. */
  readonly ancestors = new Set<string>();
  /** Every `gh` call the dispatcher made, with its options at the same index. */
  readonly ghCalls: Array<ReadonlyArray<string>> = [];
  readonly ghOptions: Array<GhOptions> = [];
  /** How `gh` answers. With no GitHub in the world, every call fails. */
  answerGh: (args: ReadonlyArray<string>) => GhResult = () => ({
    exitCode: 1,
    stdout: "",
    stderr: "no GitHub in this world",
  });

  /** A `Github` over this world's `gh`. */
  get github() {
    return fakeGh((args, options) => {
      this.ghCalls.push(args);
      this.ghOptions.push(options);
      return this.answerGh(args);
    }).layer;
  }
  /** Every prompt an agent was started with, in order. */
  readonly prompts: string[] = [];
  /** The directory of every workspace `open` was asked for, in order. */
  readonly opened: string[] = [];
  landing: Landing = { _tag: "Merged", verified: false };
  /** What every check block's command answers. */
  checking: Checked = { _tag: "Passed", verified: true };
  /** The commit and command of every check run, in order. */
  readonly checked: Array<[string, string]> = [];
  /** The base each check run judged its commit against, in order. */
  readonly checkBases: string[] = [];
  /** The commit message each landing passed to `Repository.merge`. */
  readonly mergeMessages: string[] = [];

  constructor(...items: ReadonlyArray<Item>) {
    for (const task of items) this.tasks.set(task.id, task);
  }

  /** The worker of a task in `directory`, made when it has none. */
  private workerIn(task: string, repository: string, directory: string): Worker {
    this.opened.push(directory);
    const current = this.workers.get(task);
    if (current) return current;
    const created: Worker = {
      task,
      repository,
      directory,
      worktree: directory === repository ? undefined : directory,
      state: "gone",
      since: undefined,
      roles: new Map(),
    };
    this.workers.set(task, created);
    return created;
  }

  /** git's `leaveBranch`: a clean checkout with `branch` out takes the operator's branch back. */
  private leave(branch: string) {
    if (this.checkedOut === branch && !this.treeDirty) this.checkedOut = undefined;
  }

  readonly fleet = {
    // Opening the checkout itself checks the task's branch out there, as
    // `Repository.checkoutBranch` does.
    open: (options: { task: string; repository: string; branch: string; directory: string }) =>
      this.write("fleet.open", () => {
        if (options.directory === options.repository) this.checkedOut = options.branch;
        return this.workerIn(options.task, options.repository, options.directory);
      }),
    attach: (options: { task: string; repository: string }) =>
      this.write("fleet.attach", () =>
        this.workerIn(options.task, options.repository, options.repository),
      ),
    spawn: (
      target: Worker,
      options: { role: AgentRole; kind: string; model: string | undefined; prompt: string },
    ) =>
      this.spawnFails.has(target.task)
        ? Effect.fail(new FleetError({ operation: "spawn", detail: "harness would not start" }))
        : this.write("fleet.spawn", () => {
            this.spawned.push([target.task, options.role]);
            this.prompts.push(options.prompt);
            const roles = new Map(target.roles).set(options.role, {
              state: "working",
              since: undefined,
            });
            this.workers.set(target.task, { ...target, roles, state: "working" });
            return { kind: options.kind, model: options.model };
          }),
    roster: Effect.sync(() => [...this.workers.values()]),
    // The dispatcher never waits on a turn; only `foreman wait` does.
    awaitTurn: () => Effect.void,
    spaces: Effect.succeed(["/build/test"]),
    focus: () => this.write("fleet.focus", () => undefined),
    preview: (target: Worker) => this.write("fleet.preview", () => `preview-${target.task}`),
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
        this.leave(`foreman/${options.task}`);
      }),
    notify: (title: string) =>
      this.write("fleet.notify", () => void this.notifications.push(title)),
    inWorker: Effect.succeed(false),
  };

  /** The tracker's status moves and log, the calls the dispatcher makes on it directly. */
  readonly tracker: Tracker["Service"] = {
    refresh: (project) =>
      this.unreachable.has(project)
        ? Effect.fail(
            new TrackerError({ command: `read ${project}`, detail: "tracker unreachable" }),
          )
        : Effect.void,
    lookup: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    dependencies: () => Effect.die("unused"),
    ready: () => Effect.die("unused"),
    url: () => Effect.succeedNone,
    logs: (id) =>
      Effect.sync(() =>
        this.logs
          .filter(([task]) => task === id)
          .map(([, message]) => ({ message, createdAt: now })),
      ),
    add: () => Effect.die("unused"),
    reopen: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    cancel: (id) =>
      this.write("tracker.cancel", () =>
        this.update(id, (task) => ({ ...task, status: "canceled" })),
      ),
    label: () => Effect.die("unused"),
    unlabel: () => Effect.die("unused"),
    relabel: () => Effect.die("unused"),
    claim: (id) =>
      this.write("tracker.claim", () =>
        this.update(id, (task) => ({ ...task, status: "in_progress" })),
      ),
    log: (id, message) => this.write("tracker.log", () => void this.logs.push([id, message])),
  };

  readonly records = {
    // Fails for an absent task, as Records.show does, so callers that tolerate a
    // deleted task (the branch read) are exercised against the real contract.
    show: (id: string) => {
      const task = this.tasks.get(id);
      return task === undefined
        ? Effect.fail(
            new TrackerError({ command: `show ${id}`, detail: "no such task in the store" }),
          )
        : Effect.succeed(task);
    },
    lookup: (id: string) => Effect.succeed(Option.fromNullishOr(this.tasks.get(id))),
    ready: () =>
      Effect.succeed(
        [...this.tasks.values()].filter((task) => task.status === "open") as ReadonlyArray<Item>,
      ),
    detail: () => Effect.succeedNone,
    epicsOver: () => Effect.succeed([]),
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
    // The rows the dispatcher writes are applied as the tracer applies them;
    // `run-step.test.ts` proves that agrees with the store.
    write: (id: string, row: Row) =>
      row.move === "complete" && this.completeFails.delete(id)
        ? this.write("records.write", () => {
            const records = { ...row, move: undefined };
            this.rows.push(records);
            this.update(id, (task) => applyRow(task, records));
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new TrackerError({ command: `done ${id}`, detail: "tracker unreachable" }),
              ),
            ),
          )
        : this.write("records.write", () => {
            this.rows.push(row);
            this.update(id, (task) => applyRow(task, row));
          }),
    endReview: (id: string, ending: Ending) =>
      this.write("records.endReview", () => this.closeRuns(id, { review: ending })),
    endRuns: (id: string, endings: { author?: Ending; review?: Ending }) =>
      this.write("records.endRuns", () => this.closeRuns(id, endings)),
    abandon: (id: string, role: Role) =>
      this.write("records.abandon", () => {
        this.update(id, (task) => ({
          ...task,
          status: role === "author" ? "open" : task.status,
          runs: task.runs.filter((run) => !(run.open && run.role === role)),
        }));
      }),
    park: (id: string, reason: string, endings: Endings = {}) =>
      this.write("records.park", () => {
        this.closeRuns(id, {
          author: endings.author ?? "released",
          review: endings.review ?? "released",
        });
        this.update(id, (task) => ({ ...task, status: "open", parked: reason }));
      }),
    markFailure: (id: string, rung: string) =>
      this.write("records.markFailure", () =>
        this.update(id, (task) => ({
          ...task,
          charges: [...task.charges, { rung, run: newestRun(task), forgiven: false }],
        })),
      ),
    unpark: (id: string) =>
      this.write("records.unpark", () =>
        this.update(id, (task) => ({ ...task, parked: undefined })),
      ),
    clearFailure: (id: string, rung: string) =>
      this.write("records.clearFailure", () =>
        this.update(id, (task) => ({
          ...task,
          charges: task.charges.map((one) =>
            one.rung === rung ? { ...one, forgiven: true } : one,
          ),
        })),
      ),
    markDiagnostic: () => this.write("records.markDiagnostic", () => undefined),
    clearDiagnostic: () => this.write("records.clearDiagnostic", () => undefined),
    release: (id: string, endings: Endings = {}) =>
      this.write("records.release", () => {
        this.closeRuns(id, {
          author: endings.author ?? "released",
          review: endings.review ?? "released",
        });
        this.update(id, (task) => ({ ...task, status: "open" }));
        return "open" as const;
      }),
    // Run ids climb in the order runs open, so the newest id stands in for the
    // newest start.
    lastStarts: Effect.sync(() => {
      const startsOf = (role: Role): ReadonlyMap<string, Date> =>
        new Map(
          [...this.tasks.values()]
            .flatMap((task) => task.runs)
            .filter((run) => run.role === role)
            .toSorted((a, b) => a.id - b.id)
            .flatMap((run) =>
              run.rung === undefined ? [] : [[run.rung, new Date(run.id)] as const],
            ),
        );
      return { author: startsOf("author"), review: startsOf("review") };
    }),
    children: () => Effect.succeed([]),
    countRound: () => this.write("records.countRound", () => 1),
  };

  readonly repository = {
    checkoutOf: (folder: string) => Effect.succeed<string | undefined>(folder),
    scriptsOf: () => Effect.succeed({ verify: undefined, preview: undefined }),
    isFree: () =>
      Effect.succeed<Hold>(
        this.clean === "held"
          ? { _tag: "Held", reason: "dirty", detail: "held" }
          : this.checkedOut !== undefined
            ? { _tag: "Held", reason: "busy", detail: "busy", branch: this.checkedOut }
            : { _tag: "Clean" },
      ),
    dirty: () => Effect.sync(() => this.treeDirty),
    head: () => Effect.sync(() => this.headCommit),
    holdsWork: (directory: string) => Effect.sync(() => this.dirty.has(directory)),
    commitWork: (directory: string, _branch: string, message: string) =>
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
      branch: string,
      commit: string,
      _verify: string | undefined,
      _proving: string,
      message: string,
    ) =>
      this.write("repository.merge", () => {
        this.leave(branch);
        this.merged.push(commit);
        this.mergeMessages.push(message);
        return this.landing;
      }),
    check: (_directory: string, commit: string, base: string, command: string) =>
      this.write("repository.check", () => {
        this.checked.push([commit, command]);
        this.checkBases.push(base);
        return this.checking;
      }),
    // Worktrees are the fleet adapter's concern; the world's fleet is faked whole.
    worktrees: () => Effect.die("unused"),
    addWorktree: () => Effect.die("unused"),
    removeWorktree: () => Effect.die("unused"),
    restoreBranch: () => Effect.die("unused"),
    checkoutBranch: () => Effect.die("unused"),
    leaveBranch: () => Effect.die("unused"),
    push: (_directory: string, commit: string, branch: string) =>
      this.write("repository.push", () => void this.pushed.push([branch, commit])),
    // The remote head named by `remoteHeads` comes into the branch when it
    // descends from it, which `ancestors` says.
    fetchBranch: (_directory: string, branch: string) =>
      this.write("repository.fetchBranch", () => {
        const head = this.remoteHeads.get(branch);
        const local = this.branches.get(branch);
        if (
          head === undefined ||
          local === undefined ||
          !this.ancestors.has(`${local.tip}..${head}`)
        ) {
          return "Diverged" as const;
        }
        this.branches.set(branch, { ...local, tip: head });
        return "Updated" as const;
      }),
    descends: (_directory: string, ancestor: string, descendant: string) =>
      Effect.sync(() => this.ancestors.has(`${ancestor}..${descendant}`)),
    dropBranch: (_directory: string, branch: string) =>
      this.write("repository.dropBranch", () => {
        this.removed.push(branch);
        this.branches.delete(branch);
      }),
    trunkBranch: () => Effect.succeed("main"),
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
    const found = this.tasks.get(id);
    const opened = (found === undefined ? 0 : (newestRun(found) ?? 0)) + 1;
    this.update(id, (task) => ({
      ...task,
      runs: [
        ...task.runs,
        {
          id: opened,
          task: id,
          role: run.work === "review" ? "review" : "author",
          rung: run.rung,
          node: run.node,
          commit: run.commit,
          base: run.base,
          ending: undefined,
          rounds: undefined,
          open: true,
          landed: false,
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
              // A named exit keeps the commit it was named on.
              commit:
                run.role === "author" && run.ending === undefined
                  ? (endings.commit ?? run.commit)
                  : run.commit,
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
  instructions: (names: ReadonlyArray<string>) =>
    Effect.succeed(new Map(names.map((name) => [name, ""]))),
  agent: (block: AgentNode, run: AgentRun) =>
    Effect.succeed(block.role === "author" ? "author" : `review from ${run.base}`),
  onboard: () => Effect.succeed("onboard"),
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
// A pipelines file of the tests' own, so the operator's drawings stay out of
// them. The fixture project draws the standard worktree pipeline before each
// test, because its tasks run side by side; a test that needs another drawing
// writes its own.
const operatorPipelines = process.env["FOREMAN_PIPELINES"];
process.env["FOREMAN_PIPELINES"] = join(policies, "pipelines.json");
beforeEach(() =>
  writeFileSync(
    join(policies, "pipelines.json"),
    JSON.stringify({ version: 4, pipelines: { test: STANDARD_PIPELINES.worktree } }),
  ),
);
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
        ladder: [
          { name: "cheap", harness: "test", level: 0, model: undefined, provider: undefined },
        ],
        // A reviewer with the rung's name, on no account either.
        reviewers: [
          { name: "cheap", harness: "test", model: "cheap", provider: undefined, thinking: "high" },
        ],
        otlpEndpoint: "http://localhost:4318",
        pollInterval: 60,
        staleAfter: 24,
        coachWindow: 60,
        stallGrace: 5,
        landedWindow: 7,
        attemptsPerLevel: 2,
      }),
      Layer.succeed(Fleet, world.fleet),
      Layer.succeed(Records, world.records),
      Layer.succeed(Tracker, world.tracker),
      Layer.succeed(Repository, world.repository),
      world.github,
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

/** Runs `foreman exit` for the agent of the task's open run. */
const exit = (world: World, id: string, name: string) =>
  Effect.runPromise(
    Dispatcher.use((dispatcher) => dispatcher.exit(id, name)).pipe(Effect.provide(layerFor(world))),
  );

describe("Dispatcher tick", () => {
  test("kills a live attempt, logs the reason, and requeues without climbing", async () => {
    const task = item("ts-kill", "in_progress", [], "test", [
      stoppedRun("cheap"),
      authorRun("cheap"),
    ]);
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
    expect(world.tasks.get(task.id)?.labels).toEqual([]);
    expect(world.tasks.get(task.id)?.charges).toEqual([]);
    expect(attemptsOf(world.tasks.get(task.id)!, ["cheap"])).toBe(1);
    expect(world.logs).toEqual([
      [task.id, "foreman: operator killed this attempt: tests caught the wrong path"],
    ]);
  });

  test("writes the bare kill note and refills the freed slot", async () => {
    const task = item("ts-kill-default", "in_progress", [], "test", [
      stoppedRun("cheap"),
      authorDone("cheap"),
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
    expect(world.tasks.get(task.id)?.labels).toEqual([]);
    expect(world.tasks.get(task.id)?.charges).toEqual([]);
    expect(attemptsOf(world.tasks.get(task.id)!, ["cheap"])).toBe(1);
    expect(world.logs).toContainEqual([task.id, "foreman: operator killed this attempt"]);
    expect(world.spawned).toEqual([[task.id, "author"]]);
  });

  test("settles an author handoff without climbing", async () => {
    const task = item("ts-author", "in_progress", [], "test", [authorDone("cheap")]);
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
    expect(world.tasks.get(task.id)?.charges).toEqual([]);
    expect(reviewerOf(world, task.id)).toBe("cheap");
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("allows a settled role to receive the next dispatch", async () => {
    const task = item("ts-settled", "in_progress", [], "test", [authorDone("cheap")]);
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
      expect(attemptsOf(world.tasks.get(task.id)!, ["cheap"])).toBe(1);

      world.workers.set(task.id, vanished);
      await tick(world);

      expect(failuresOf(world.tasks.get(task.id)!)).toContain("cheap");
    }
  });

  test("sweeps a merged branch only after its task leaves the pipeline", async () => {
    const swept = item("ts-swept", "canceled", []);
    const kept = item("ts-kept", "in_progress", [], "test", [authorDone("cheap")]);
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
    // The author named its exit; the pane is idle and settle has not yet
    // closed the run. Placement stands it ended at the author, settle closes
    // it, and the next reading places it at review waiting.
    const task = item("ts-empty", "in_progress", [], "test", [
      authorRun("cheap", { ending: "done", commit: "c1" }),
    ]);
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
      { role: "author", open: false, ending: "done", commit: "c1" },
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
    const task = item("ts-empty", "in_progress", [], "test", [authorDone("cheap")]);
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
    const task = item("ts-already-done", "in_progress", [], "test", [
      authorRun("cheap", { open: false, ending: "already-done" }),
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

    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("closes an already-done task the reviewer approved, merging nothing", async () => {
    const task = item("ts-confirmed", "in_progress", [], "test", [
      authorRun("cheap", { open: false, ending: "already-done" }),
      reviewRun("cheap", { ending: "approved", commit: "c1", open: false }),
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
    const task = item("ts-research", "in_progress", ["research"], "test", [authorDone("cheap")]);
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
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("closes a research task the reviewer approved, merging nothing", async () => {
    const task = item("ts-research-confirmed", "in_progress", ["research"], "test", [
      authorDone("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1", open: false }),
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
    const focused = { ...item("ts-focus", "open", ["focus"]), parked: "waits for a person" };
    const world = new World(focused);

    await tick(world);

    expect(world.spawned).toEqual([]);
    expect(world.notifications).not.toContain("Focus complete");
  });

  test("lands an approved task without a worker", async () => {
    const task = item("ts-approved", "in_progress", [], "test", [
      authorDone("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1", open: false }),
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
    const task = item("ts-voided", "in_progress", [], "test", [
      authorDone("cheap"),
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
    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
    expect(world.spawned).toEqual([[task.id, "review"]]);
    expect(world.tasks.get(task.id)?.runs.at(-1)).toMatchObject({
      role: "review",
      open: true,
      commit: "c2",
    });
  });

  test("land refuses a tip that moved after it was observed", async () => {
    const task = item("ts-moved", "in_progress", [], "test", [
      authorDone("cheap"),
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
    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
  });

  test("a landing merges the approved commit and closes the lap's runs", async () => {
    // The landing takes the task's terminals down, so no later settle sees
    // them: the runs must be closed here or never.
    const task = item("ts-landed", "in_progress", [], "test", [
      authorDone("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1", open: false }),
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

describe("naming an exit", () => {
  /** A review of c1 under way, and a branch at c2 that a correction round committed. */
  const afterRound = () => {
    const task = item("ts-round", "in_progress", [], "test", [
      authorDone("cheap"),
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

  test("records the tip it is named on, so an approval after a round lands the round's tip", async () => {
    const { task, world } = afterRound();

    expect(await exit(world, task.id, "approved")).toEqual({
      _tag: "Named",
      block: "review",
      commit: "c2",
    });
    await tick(world);
    // The first tick closes the run the reviewer named its exit on; the next lands.
    await tick(world);

    expect(world.merged).toEqual(["c2"]);
    expect(world.tasks.get(task.id)?.status).toBe("done");
  });

  test("an approval named before a round stays on the old tip, and lands nothing", async () => {
    const { task, world } = afterRound();
    world.branches.set(`foreman/${task.id}`, {
      ...world.branches.get(`foreman/${task.id}`)!,
      tip: "c1",
    });
    await exit(world, task.id, "approved");
    world.branches.set(`foreman/${task.id}`, {
      ...world.branches.get(`foreman/${task.id}`)!,
      tip: "c2",
    });
    await tick(world);

    expect(world.merged).toEqual([]);
    expect(world.tasks.get(task.id)?.runs.find((run) => run.ending === "approved")?.commit).toBe(
      "c1",
    );
  });

  test("refuses a name the block does not declare, lists the ones it does, and writes nothing", async () => {
    const { task, world } = afterRound();
    const before = world.tasks.get(task.id);

    expect(await exit(world, task.id, "shipped")).toEqual({
      _tag: "Undeclared",
      block: "review",
      declared: ["approved", "returned"],
    });
    expect(world.tasks.get(task.id)).toEqual(before);
  });

  test("a second exit in the same run replaces the first", async () => {
    const { task, world } = afterRound();
    await exit(world, task.id, "approved");
    await exit(world, task.id, "returned");

    const review = world.tasks.get(task.id)?.runs.filter((run) => run.role === "review");
    expect(review?.map((run) => run.ending)).toEqual(["returned"]);
    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
  });

  test("an author's done sends the task to review", async () => {
    const task = item("ts-done", "in_progress", [], "test", [authorRun("cheap")]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });

    await exit(world, task.id, "done");

    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
    expect(world.tasks.get(task.id)?.runs[0]).toMatchObject({ ending: "done", commit: "c1" });
  });
});

/** Runs `foreman dispatch` on one task after one reading, as the command does. */
const author = (world: World, task: Item, rung: Option.Option<string>) =>
  Effect.runPromise(
    Dispatcher.use((dispatcher) =>
      dispatcher.read.pipe(Effect.andThen(dispatcher.author(task, rung))),
    ).pipe(Effect.provide(layerFor(world))),
  );

describe("starting an author by hand", () => {
  test("starts a queued task on the rung a tick would choose, and names it", async () => {
    const task = item("ts-hand", "open", []);
    const world = new World(task);

    expect(await author(world, task, Option.none())).toEqual({ _tag: "Started", rung: "cheap" });
    expect(world.spawned).toEqual([[task.id, "author"]]);
  });

  test("starts nothing for a task whose route has no author block ahead, and says so", async () => {
    // Its author is done, so its route stands at review: no author block is left.
    const task = item("ts-reviewing", "in_progress", [], "test", [authorDone("cheap")]);
    const world = new World(task);

    expect(await author(world, task, Option.none())).toEqual({
      _tag: "NoAuthorBlock",
      project: "test",
    });
    expect(world.spawned).toEqual([]);
  });

  test("starts nothing on a rung foreman cannot dispatch, and lists the ones it can", async () => {
    const task = item("ts-named", "open", []);
    const world = new World(task);

    expect(await author(world, task, Option.some("missing"))).toEqual({
      _tag: "UnknownRung",
      rung: "missing",
      rungs: ["cheap"],
    });
    expect(world.spawned).toEqual([]);
  });

  test("starts nothing for a task every rung has failed, and says the ladder is spent", async () => {
    const task = { ...item("ts-spent", "open", []), charges: [charged("cheap")] };
    const world = new World(task);

    expect(await author(world, task, Option.none())).toEqual({
      _tag: "NoSeat",
      seat: "Exhausted",
      model: "ladder",
    });
    expect(world.spawned).toEqual([]);
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
    const settled = item("ts-settled", "in_progress", [], "test", [authorDone("cheap")]);
    const approved = item("ts-approved", "in_progress", [], "test", [
      authorDone("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1", open: false }),
    ]);
    const swept = item("ts-swept", "canceled", []);
    const stale = {
      ...item("ts-stale", "in_progress", [], "test", [authorRun("cheap")]),
      lastActivityAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    };
    const abandoned = item("ts-abandoned", "done", [], "test", [authorDone("cheap")]);
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
        "records.release",
        "records.write",
        "fleet.spawn",
      ]),
    );
    expect(policyText()).not.toBe(before);
  });

  test("a project whose tracker does not answer takes no step and orphans no worker", async () => {
    usePolicy(everything);
    const world = busy();
    // The fixture's workers stand in a checkout named `project`, its spaces in `test`.
    for (const project of ["test", "project"]) world.unreachable.add(project);
    world.workers.set("ts-gone", worker("ts-gone", "author", "working"));

    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const dispatcher = yield* Dispatcher;
        yield* dispatcher.tick;
        return yield* SubscriptionRef.get(dispatcher.state);
      }).pipe(Effect.provide(layerFor(world))),
    );

    expect(world.writes).toEqual([]);
    expect(state.orphans).toEqual([]);
    expect(state.held.map((held) => [held.project, held.reason])).toEqual([
      ["test", "unreachable"],
      ["project", "unreachable"],
    ]);
    expect(world.branches.has("foreman/ts-swept")).toBe(true);

    // The control: the same world, once the tracker answers, writes from every pass.
    world.unreachable.clear();
    await tick(world);

    expect(world.writes).toEqual(expect.arrayContaining(["repository.remove", "fleet.spawn"]));
  });

  test("a GitHub project reads unreachable while gh is signed out, asked once when the loop starts", async () => {
    usePolicy({ ...everything, projects: { test: { tracker: "github" } } });
    const world = busy();
    world.answerGh = (args) =>
      args.join(" ") === "auth status"
        ? { exitCode: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." }
        : { exitCode: 0, stdout: "", stderr: "" };

    // A one-shot reading never runs the loop, so it asks nothing of gh's sign-in.
    await tick(world);
    expect(world.ghCalls.filter((args) => args.join(" ") === "auth status")).toHaveLength(0);

    const left = [false];
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const dispatcher = yield* Dispatcher;
        yield* dispatcher
          .run(Effect.sync(() => left.shift() ?? true))
          .pipe(Effect.timeout("5 seconds"));
        return yield* SubscriptionRef.get(dispatcher.state);
      }).pipe(Effect.scoped, Effect.provide(layerFor(world))),
    );

    const held = state.held.find((one) => one.project === "test");
    expect(held?.reason).toBe("unreachable");
    expect(held?.detail).toContain("not logged into any GitHub hosts");
    expect(state.projects.map((project) => project.name)).toContain("test");
    expect(world.ghCalls.filter((args) => args.join(" ") === "auth status")).toHaveLength(1);
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
          ladder: [
            { name: "cheap", harness: "test", level: 0, model: "openai/gpt", provider: undefined },
          ],
          reviewers: [],
          otlpEndpoint: "http://localhost:4318",
          pollInterval: 60,
          staleAfter: 24,
          coachWindow: 60,
          stallGrace: 5,
          landedWindow: 7,
          attemptsPerLevel: 2,
        }),
        Layer.succeed(Fleet, world.fleet),
        Layer.succeed(Records, world.records),
        Layer.succeed(Tracker, world.tracker),
        Layer.succeed(Repository, world.repository),
        world.github,
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

describe("a spent account and the reviewers", () => {
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
            { name: "cheap", harness: "test", level: 0, model: "openai/gpt", provider: undefined },
            {
              name: "dear",
              harness: "test",
              level: 1,
              model: "anthropic/claude",
              provider: undefined,
            },
          ],
          // One reviewer on each account; "cheap" shares the author's model.
          reviewers: [
            {
              name: "cheap",
              harness: "test",
              model: "openai/gpt",
              provider: undefined,
              thinking: "high",
            },
            {
              name: "dear",
              harness: "test",
              model: "anthropic/claude",
              provider: undefined,
              thinking: "high",
            },
          ],
          otlpEndpoint: "http://localhost:4318",
          pollInterval: 60,
          staleAfter: 24,
          coachWindow: 60,
          stallGrace: 5,
          landedWindow: 7,
          attemptsPerLevel: 2,
        }),
        Layer.succeed(Fleet, world.fleet),
        Layer.succeed(Records, world.records),
        Layer.succeed(Tracker, world.tracker),
        Layer.succeed(Repository, world.repository),
        world.github,
        quotaSpending(spent),
        prompts,
        BunServices.layer,
      ),
    );

  /** A task whose author finished, waiting to be read. */
  const awaiting = (id: string) => {
    const task = item(id, "in_progress", [], "test", [authorDone("cheap")]);
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

  test("reviews with a reviewer on another account rather than waiting on money", async () => {
    // "cheap" wrote it on openai, and the wall on openai says nothing about
    // "dear", which reads on anthropic.
    const world = awaiting("ts-skips");
    await tickWith(world, ["openai"]);

    expect(world.spawned).toEqual([["ts-skips", "review"]]);
    expect(reviewerOf(world, "ts-skips")).toBe("dear");
  });

  test("leaves the task alone when every reviewer's account is spent", async () => {
    const world = awaiting("ts-walled");
    await tickWith(world, ["openai", "anthropic"]);

    // No reviewer, and nothing written: the rung is untouched and no attempt is
    // counted, so the task is read again unchanged once an allowance resets.
    expect(world.spawned).toEqual([]);
    expect(world.tasks.get("ts-walled")?.labels).toEqual([]);
    expect(world.tasks.get("ts-walled")?.charges).toEqual([]);
    expect(world.tasks.get("ts-walled")?.status).toBe("in_progress");
  });

  test("substitutes a reviewer without climbing the task's own rung", async () => {
    // A dearer reviewer is what the wallet forced, not what the work earned, so
    // the task keeps the rung it had and its next author is unchanged.
    const task = item("ts-rung", "in_progress", [], "test", [
      stoppedRun("cheap"),
      authorDone("cheap"),
    ]);
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

    expect(world.tasks.get(task.id)?.labels).toEqual([]);
    expect(world.tasks.get(task.id)?.charges).toEqual([]);
    expect(attemptsOf(world.tasks.get(task.id)!, ["cheap"])).toBe(1);
    expect(reviewerOf(world, task.id)).toBe("dear");
  });

  test("reads with another model first, and with the author's own model when no other can pay", async () => {
    const other = awaiting("ts-other");
    await tickWith(other, []);
    expect(reviewerOf(other, "ts-other")).toBe("dear");

    const same = awaiting("ts-same");
    await tickWith(same, ["anthropic"]);
    expect(reviewerOf(same, "ts-same")).toBe("cheap");
  });

  test("takes the cheapest rung nothing has recorded against the task", async () => {
    const world = new World(item("ts-fresh", "open", []));
    await tickWith(world, []);

    expect(world.spawned).toEqual([["ts-fresh", "author"]]);
    expect(authoredBy(world.tasks.get("ts-fresh")!)).toBe("cheap");
  });

  test("dispatches an issue id, `<project>#<number>`, into a worktree of that name", async () => {
    const world = new World(item("test#7", "open", []));
    await tickWith(world, []);

    expect(world.spawned).toEqual([["test#7", "author"]]);
    expect(world.opened[0]).toEndWith("/worktrees/test/test#7");
  });

  test("dispatches a Linear issue id, `<project>#<identifier>`, and lands it locally", async () => {
    const world = new World(item("test#ENG-7", "open", []));
    await tickWith(world, []);
    expect(world.spawned).toEqual([["test#ENG-7", "author"]]);
    expect(world.opened[0]).toEndWith("/worktrees/test/test#ENG-7");

    const task = item("test#ENG-8", "in_progress", [], "test", [
      authorDone("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1", open: false }),
    ]);
    const landing = new World(task);
    landing.branches.set(`foreman/${task.id}`, {
      branch: `foreman/${task.id}`,
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });
    await tick(landing);
    expect(landing.tasks.get(task.id)?.status).toBe("done");
    expect(landing.closed).toContain(task.id);
  });

  test("takes the rung above a recorded failure", async () => {
    const world = new World({ ...item("ts-failed", "open", []), charges: [charged("cheap")] });
    await tickWith(world, []);

    expect(authoredBy(world.tasks.get("ts-failed")!)).toBe("dear");
  });

  test("steps an author over a spent account rather than parking the task", async () => {
    // Nothing is recorded against the task: the wall is the wallet's, so the
    // cheap rung is chosen again the moment the account resets.
    const world = new World(item("ts-money", "open", []));
    await tickWith(world, ["openai"]);

    expect(authoredBy(world.tasks.get("ts-money")!)).toBe("dear");
    expect(failuresOf(world.tasks.get("ts-money")!)).toEqual([]);
  });

  test("waits in the queue when every rung is walled, and records nothing", async () => {
    const world = new World(item("ts-broke", "open", []));
    await tickWith(world, ["openai", "anthropic"]);

    expect(world.spawned).toEqual([]);
    expect(world.tasks.get("ts-broke")?.status).toBe("open");
    expect(world.tasks.get("ts-broke")?.labels).toEqual([]);
    expect(world.tasks.get("ts-broke")?.charges).toEqual([]);
    expect(world.tasks.get("ts-broke")?.parked).toBeUndefined();
  });

  test("dispatches nothing for a task every rung has failed", async () => {
    // The ladder is exhausted by evidence, which is the operator's column —
    // and unlike a wall, no reset clears it.
    const world = new World({
      ...item("ts-exhausted", "open", []),
      charges: [charged("cheap"), charged("dear")],
    });
    await tickWith(world, []);

    expect(world.spawned).toEqual([]);
    expect(world.tasks.get("ts-exhausted")?.status).toBe("open");
  });

  test("records the rung that ran, not the one that comes next", async () => {
    // A reviewer sending work back is a judgement about the model that wrote
    // the code, so what lands on the task is that model's failure.
    const task = item("ts-sent-back", "open", [], "test", [
      authorDone("cheap"),
      reviewRun("dear", { ending: "returned", commit: "c1" }),
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

    await tickWith(world, []);

    expect(failuresOf(world.tasks.get(task.id)!)).toEqual(["cheap"]);
  });
});

/**
 * Ticks once, then reads back the asks that tick published. Asks are part of
 * the reading, so the test sees what `foreman approve` and the Foreman pane would.
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
    const task = item("ts-ask-review", "in_progress", [], "test", [authorDone("cheap")]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, unmerged(task.id));

    const asks = await asksAfter(world);

    expect(asks).toEqual([{ task: task.id, step: "review", rung: "cheap" }]);
    expect(world.spawned).toEqual([]);
    expect(world.writes).toEqual([]);
  });

  test("approving a review ask starts exactly that review on the next tick", async () => {
    const task = item("ts-approve-review", "in_progress", [], "test", [authorDone("cheap")]);
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
    const task = item("ts-ask-land", "in_progress", [], "test", [
      authorDone("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1", open: false }),
    ]);
    const world = new World(task);
    world.branches.set(`foreman/${task.id}`, unmerged(task.id));

    const asks = await asksAfter(world);

    expect(asks).toEqual([{ task: task.id, step: "land", rung: "cheap" }]);
    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
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
    const task = item("ts-approve-real", "in_progress", [], "test", [authorDone("cheap")]);
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
    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
  });
});

describe("unassign", () => {
  test("ends a stale review with no failure, so the same rung may review again", async () => {
    const task = item("ts-stale", "open", [], "test", [authorDone("low"), reviewRun("mid")]);
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
  const ladder: Ladder = [
    {
      name: "free",
      harness: "opencode",
      level: 0,
      model: "opencode/free-model",
      provider: undefined,
    },
    { name: "dear", harness: "test", level: 1, model: "anthropic/claude", provider: undefined },
  ];
  /** The same two models as reviewers, each named after its rung. */
  const reviewers: ReadonlyArray<Reviewer> = [
    {
      name: "free",
      harness: "opencode",
      model: "opencode/free-model",
      provider: undefined,
      thinking: "high",
    },
    {
      name: "dear",
      harness: "test",
      model: "anthropic/claude",
      provider: undefined,
      thinking: "high",
    },
  ];
  const seats = { ladder, reviewers };
  const layerFor = (world: World) =>
    Layer.provideMerge(
      Dispatcher.Default,
      Layer.mergeAll(
        Layer.succeed(Settings, {
          ladder,
          reviewers,
          otlpEndpoint: "http://localhost:4318",
          pollInterval: 60,
          staleAfter: 24,
          coachWindow: 60,
          stallGrace: 5,
          landedWindow: 7,
          attemptsPerLevel: 2,
        }),
        Layer.succeed(Fleet, world.fleet),
        Layer.succeed(Records, world.records),
        Layer.succeed(Tracker, world.tracker),
        Layer.succeed(Repository, world.repository),
        world.github,
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

    const walled = world.tasks.get("ts-walled")!;
    expect(world.commits).toHaveLength(1);
    expect(world.commits[0]).toContain("stopped on a usage limit before verifying");
    expect(walledBy(walled, seats)).toEqual(["opencode"]);
    expect(attemptsOf(walled, ["free"])).toBe(0);
    expect(failuresOf(walled)).toEqual([]);
    expect(world.tasks.get("ts-walled")?.runs[0]).toMatchObject({ open: false, ending: "walled" });
    expect(world.logs.map(([, message]) => message).join("\n")).toContain("opencode");
    // Settle runs before fill in the same tick, so the next author is already
    // dispatched onto the rung on the other account.
    expect(authoredBy(world.tasks.get("ts-walled")!)).toBe("dear");
    expect(world.spawned).toContainEqual(["ts-walled", "author"]);
  });

  test("hands a review to another account without recording a reviewer failure", async () => {
    const task = item("ts-review-wall", "in_progress", [], "test", [
      authorDone("free"),
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
    expect(found?.status).toBe("in_progress");
    expect(walledBy(found!, seats)).toEqual(["opencode"]);
    expect(found?.runs.some((run) => run.ending === "stopped")).toBe(false);
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
    expect(walledBy(world.tasks.get("ts-walled-clean")!, seats)).toEqual(["opencode"]);
  });

  test("a stop with no wall text on its screen goes through the retry path as before", async () => {
    const world = stoppedOn("ts-plain", "all done\n  ctrl+p commands", true);

    await tick(world);

    const plain = world.tasks.get("ts-plain")!;
    expect(attemptsOf(plain, ["free"])).toBe(1);
    expect(walledBy(plain, seats)).toEqual([]);
    expect(world.commits).toHaveLength(0);
    expect(world.tasks.get("ts-plain")?.runs[0]).toMatchObject({
      open: false,
      ending: "stopped",
    });
  });

  /** Dates the author pane's idle turn `minutes` ago; the stall grace is 5 minutes. */
  const idleFor = (world: World, id: string, minutes: number) => {
    const since = Date.now() - minutes * 60_000;
    const current = world.workers.get(id)!;
    world.workers.set(id, {
      ...current,
      since,
      roles: new Map([["author", { state: "settled", since }]]),
    });
  };

  test("an author idle within the stall grace is left for the operator to steer", async () => {
    const world = stoppedOn("ts-idle", "all done\n  ctrl+p commands", true);
    idleFor(world, "ts-idle", 1);

    await tick(world);

    expect(world.tasks.get("ts-idle")?.runs[0]).toMatchObject({ open: true });
    expect(world.stopped).toEqual([]);
    expect(world.closed).toEqual([]);
  });

  test("past the stall grace the pane closes, and the next author continues from the worktree", async () => {
    const world = stoppedOn("ts-stalled", "all done\n  ctrl+p commands", true);
    idleFor(world, "ts-stalled", 10);

    await tick(world);

    expect(world.stopped).toContainEqual(["ts-stalled", "author"]);
    expect(world.closed).not.toContain("ts-stalled");
    expect(attemptsOf(world.tasks.get("ts-stalled")!, ["free"])).toBe(1);
    expect(world.logs.map(([, message]) => message).join("\n")).toContain(
      "continue from what is there",
    );
  });

  test("past the stall grace an empty worktree is removed", async () => {
    const world = stoppedOn("ts-stalled-empty", "all done\n  ctrl+p commands", false);
    idleFor(world, "ts-stalled-empty", 10);

    await tick(world);

    expect(world.closed).toContain("ts-stalled-empty");
  });

  test("a quoted wall higher up the screen than the stop is no wall", async () => {
    const quoted = "Free usage limit reached is the message foreman looks for.";
    const world = stoppedOn(
      "ts-quoted",
      [quoted, ...Array.from({ length: 20 }, (_, i) => `working line ${i}`)].join("\n"),
      false,
    );

    await tick(world);

    expect(walledBy(world.tasks.get("ts-quoted")!, seats)).toEqual([]);
  });
});

describe("a new commit in foreman's own checkout", () => {
  /** Runs the dispatcher with a code check that answers `answers` in turn, then true. */
  const runWith = (world: World, answers: ReadonlyArray<boolean>) => {
    const left = [...answers];
    return Effect.runPromise(
      Effect.scoped(
        Dispatcher.use((dispatcher) =>
          dispatcher.run(Effect.sync(() => left.shift() ?? true)).pipe(Effect.timeout("5 seconds")),
        ),
      ).pipe(Effect.provide(layerFor(world))),
    );
  };

  test("leaves a queued task dispatched while the code stands still", async () => {
    const world = new World(item("ts-fresh", "open", [], "test", []));
    await tick(world);
    expect(world.spawned).toEqual([["ts-fresh", "author"]]);
  });

  test("ends the run before it reads the world", async () => {
    const world = new World(item("ts-fresh", "open", [], "test", []));
    await runWith(world, []);
    expect(world.spawned).toEqual([]);
    expect(world.writes).toEqual([]);
  });

  test("ends the run before fill when the tick's own passes moved it", async () => {
    const world = new World(item("ts-fresh", "open", [], "test", []));
    await runWith(world, [false]);
    expect(world.spawned).toEqual([]);
  });
});

describe("a policy change", () => {
  test("is published within a second, not at the next poll", async () => {
    usePolicy({ ...ALLOWED, paused: true });
    const waited = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dispatcher = yield* Dispatcher;
          yield* Effect.forkScoped(dispatcher.run());
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

describe("a route's workspace blocks", () => {
  const drawn = join(policies, "pipelines.json");
  const draw = (nodes: ReadonlyArray<PipelineNode>) =>
    writeFileSync(drawn, JSON.stringify({ version: 4, pipelines: { test: { nodes } } }));
  afterEach(() => rmSync(drawn, { force: true }));

  const BRANCH_ONLY = STANDARD_PIPELINES.checkout.nodes;
  const DIRECT = STANDARD_PIPELINES.direct.nodes;

  const settled = (world: World, id: string, role: "author" | "review") => {
    const current = world.workers.get(id);
    if (current === undefined) throw new Error(`${id} has no worker`);
    world.workers.set(id, {
      ...current,
      roles: new Map([[role, { state: "settled", since: undefined }]]),
      state: "settled",
    });
  };
  const authorRuns = (world: World, id: string) =>
    world.tasks.get(id)?.runs.filter((run) => run.role === "author") ?? [];

  /**
   * Takes one task from the queue to the end of its route through the real
   * tick and `foreman exit`: the author commits and names `done`, the reviewer
   * names `approved` on the tip it read, and the task ends. `commit` stands
   * for the author's commit in git: a branch tip, or the checkout's HEAD moving.
   * Each exit takes one tick to close its run, once its pane is idle.
   */
  const drive = async (world: World, id: string, commit: () => void) => {
    await tick(world);
    expect(world.spawned.at(-1)).toEqual([id, "author"]);

    commit();
    await exit(world, id, "done");
    settled(world, id, "author");
    await tick(world);
    await tick(world);
    expect(world.spawned.at(-1)).toEqual([id, "review"]);

    await exit(world, id, "approved");
    settled(world, id, "review");
    await tick(world);
    await tick(world);
    expect(world.tasks.get(id)?.status).toBe("done");
  };
  const onBranch = (world: World, id: string) => () =>
    void world.branches.set(`foreman/${id}`, {
      branch: `foreman/${id}`,
      tip: "c1",
      merged: false,
      empty: false,
      stale: undefined,
    });

  test("worktree: the author works in its own worktree, and the approved commit merges", async () => {
    const task = item("ts-tree", "open", []);
    const world = new World(task);

    await drive(world, task.id, onBranch(world, task.id));

    expect(world.opened[0]).toBe(directoryFor("test", task.id));
    expect(world.prompts).toEqual(["author", "review from base"]);
    expect(world.merged).toEqual(["c1"]);
    expect(authorRuns(world, task.id)[0]?.base).toBeUndefined();
  });

  test("a landing whose completion failed after its records is completed by the next landing", async () => {
    const task = item("ts-unfinished", "open", []);
    const world = new World(task);
    world.completeFails.add(task.id);

    await tick(world);
    onBranch(world, task.id)();
    await exit(world, task.id, "done");
    settled(world, task.id, "author");
    await tick(world);
    await tick(world);
    await exit(world, task.id, "approved");
    settled(world, task.id, "review");
    await tick(world);
    await tick(world);

    expect(world.merged).toEqual(["c1"]);
    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
    expect(authorRuns(world, task.id).at(-1)?.landed).toBe(true);

    // The commits are in, so the retry finds the branch in the checkout and
    // completes the task without merging it again.
    world.landing = { _tag: "Present" };
    await tick(world);
    expect(world.tasks.get(task.id)?.status).toBe("done");
  });

  test("direct: a completion that failed after its records is completed by the next tick", async () => {
    draw(DIRECT);
    const task = item("ts-direct-unfinished", "open", []);
    const world = new World(task);
    world.completeFails.add(task.id);

    await tick(world);
    world.headCommit = "h1";
    await exit(world, task.id, "done");
    settled(world, task.id, "author");
    await tick(world);
    await tick(world);
    await exit(world, task.id, "approved");
    settled(world, task.id, "review");
    await tick(world);
    await tick(world);
    expect(world.tasks.get(task.id)?.status).toBe("in_progress");

    await tick(world);
    expect(world.tasks.get(task.id)?.status).toBe("done");
  });

  test("branch only: the author works in the operator's checkout, and the approved commit merges", async () => {
    draw(BRANCH_ONLY);
    const task = item("ts-branch", "open", []);
    const world = new World(task);

    await drive(world, task.id, onBranch(world, task.id));

    expect(world.opened[0]).toBe("/build/test");
    expect(world.workers.get(task.id)?.worktree).toBeUndefined();
    expect(world.merged).toEqual(["c1"]);
  });

  test("direct: the author commits on the operator's branch, the reviewer reads from where it started, and done merges nothing", async () => {
    draw(DIRECT);
    const task = item("ts-direct", "open", []);
    const world = new World(task);

    await drive(world, task.id, () => {
      world.headCommit = "h1";
    });

    expect(world.opened[0]).toBe("/build/test");
    expect(authorRuns(world, task.id)[0]?.base).toBe("h0");
    expect(world.prompts).toEqual(["author", "review from h0"]);
    // The reviewer's approval holds for the commit the checkout had when it read.
    expect(world.tasks.get(task.id)?.runs.find((run) => run.role === "review")?.commit).toBe("h1");
    expect(world.merged).toEqual([]);
    expect(
      world.logs.some(([id, line]) => id === task.id && line.includes("completed at done")),
    ).toBe(true);
  });

  test("direct: a check runs on the checkout's HEAD against where the first author started", async () => {
    draw(
      DIRECT.flatMap((node): ReadonlyArray<PipelineNode> =>
        node.kind === "agent" && node.role === "author"
          ? [
              { ...node, exits: node.exits.map((exit) => ({ ...exit, to: "lint-gate" })) },
              { kind: "gate", id: "lint-gate", step: "review", next: "lint" },
              {
                kind: "check",
                id: "lint",
                command: "bun run lint",
                exits: [
                  { name: "passed", to: "review-gate" },
                  { name: "failed", to: "queue", fails: "author" },
                ],
              },
            ]
          : [node],
      ),
    );
    const task = item("ts-direct-lint", "in_progress", [], "test", [
      authorRun("cheap", { base: "h0", open: false, ending: "done", commit: "h1" }),
    ]);
    const world = new World(task);
    world.headCommit = "h1";

    await tick(world);

    expect(world.checked).toEqual([["h1", "bun run lint"]]);
    expect(world.checkBases).toEqual(["h0"]);
    expect(world.tasks.get(task.id)?.runs.find((run) => run.role === "check")?.ending).toBe(
      "passed",
    );
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  test("direct: an exit after a correction round records the checkout's HEAD", async () => {
    draw(DIRECT);
    const task = item("ts-direct-round", "in_progress", [], "test", [
      authorRun("cheap", { base: "h0", open: false, ending: "done", commit: "h1" }),
      reviewRun("cheap", { commit: "h1" }),
    ]);
    const world = new World(task);
    world.headCommit = "h2";

    await Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.exit(task.id, "approved")).pipe(
        Effect.provide(layerFor(world)),
      ),
    );

    expect(world.tasks.get(task.id)?.runs.find((run) => run.role === "review")?.commit).toBe("h2");
  });

  test("direct: a commit after the approval stops the task completing, and it goes to review again", async () => {
    draw(DIRECT);
    const task = item("ts-moved", "in_progress", [], "test", [
      authorRun("cheap", { base: "h0", open: false, ending: "done", commit: "h1" }),
      reviewRun("cheap", { ending: "approved", commit: "h1", open: false }),
    ]);
    const world = new World(task);
    world.headCommit = "h2";

    await tick(world);

    expect(world.tasks.get(task.id)?.status).toBe("in_progress");
    expect(world.spawned).toEqual([[task.id, "review"]]);
  });

  for (const [shape, nodes] of [
    ["branch only", BRANCH_ONLY],
    ["direct", DIRECT],
  ] as const) {
    test(`${shape}: the checkout takes one task at a time, even with two candidates in one tick`, async () => {
      draw(nodes);
      usePolicy({ ...ALLOWED, slots: 2 });
      const first = item("ts-first", "open", []);
      const second = item("ts-second", "open", []);
      const world = new World(first, second);

      await tick(world);
      expect(world.spawned).toEqual([[first.id, "author"]]);

      // Its author stops and is sent back: the task still holds the checkout.
      settled(world, first.id, "author");
      await Effect.runPromise(world.records.release(first.id, { author: "returned" }));
      world.workers.delete(first.id);
      await tick(world);
      expect(world.spawned.map(([id]) => id)).not.toContain(second.id);

      await Effect.runPromise(
        world.records.write(first.id, {
          ...NO_WRITES,
          move: "complete",
          close: { author: "released", review: "released" },
          land: "committed",
        }),
      );
      // The landing those records stand for checks the operator's branch out again.
      world.checkedOut = undefined;
      await tick(world);
      expect(world.spawned.at(-1)).toEqual([second.id, "author"]);
    });
  }

  const reading = (world: World) =>
    Effect.runPromise(
      Dispatcher.use((dispatcher) =>
        dispatcher.tick.pipe(Effect.andThen(SubscriptionRef.get(dispatcher.state))),
      ).pipe(Effect.provide(layerFor(world))),
    );

  test("a task branch out in the checkout holds every other task, and not its own review", async () => {
    draw(BRANCH_ONLY);
    const own = item("ts-own", "in_progress", [], "test", [authorDone("cheap", "c1")]);
    const other = item("ts-other", "open", []);
    const world = new World(own, other);
    world.checkedOut = `foreman/${own.id}`;
    onBranch(world, own.id)();

    const state = await reading(world);

    expect(world.spawned).toEqual([[own.id, "review"]]);
    expect(world.opened).toEqual(["/build/test"]);
    expect(world.tasks.get(other.id)?.status).toBe("open");
    expect(state.held).toEqual([
      { project: "test", reason: "busy", detail: "busy", branch: `foreman/${own.id}` },
    ]);
  });

  test("branch only: queued tasks with earlier author runs hold nothing while no branch is out", async () => {
    draw(BRANCH_ONLY);
    const stopped = () => authorRun("cheap", { open: false, ending: "stopped" });
    const first = item("ts-queued-a", "open", [], "test", [stopped()]);
    const second = item("ts-queued-b", "open", [], "test", [stopped()]);
    const world = new World(first, second);

    const state = await reading(world);

    expect(state.held).toEqual([]);
    expect(world.spawned).toEqual([[first.id, "author"]]);
  });

  test("direct: queued tasks whose author runs recorded no base hold nothing", async () => {
    draw(DIRECT);
    const elsewhere = () => authorRun("cheap", { open: false, ending: "stopped" });
    const first = item("ts-moved-a", "open", [], "test", [elsewhere()]);
    const second = item("ts-moved-b", "open", [], "test", [elsewhere()]);
    const world = new World(first, second);

    const state = await reading(world);

    expect(state.held).toEqual([]);
    expect(world.spawned).toEqual([[first.id, "author"]]);
  });

  test("a direct task in the checkout holds another task's landing, and names itself", async () => {
    // Tasks labelled `direct` take a route with no branch; the rest take the standard one.
    draw([
      { kind: "source", id: "queue", filter: "", next: "which" },
      {
        kind: "router",
        id: "which",
        routes: [{ when: "label:direct", to: "d-start" }],
        else: "branch",
      },
      ...STANDARD_PIPELINES.worktree.nodes.filter((node) => node.kind !== "source"),
      { kind: "gate", id: "d-start", step: "author", next: "d-author" },
      {
        kind: "agent",
        id: "d-author",
        role: "author",
        model: "ladder",
        exits: [
          { name: "done", to: "d-review-gate" },
          { name: "already-done", to: "d-review-gate" },
        ],
      },
      { kind: "gate", id: "d-review-gate", step: "review", next: "d-review" },
      {
        kind: "agent",
        id: "d-review",
        role: "review",
        model: "reviewers",
        exits: [
          { name: "approved", to: "d-land-gate" },
          { name: "returned", to: "queue", fails: "author" },
        ],
      },
      { kind: "gate", id: "d-land-gate", step: "land", next: "d-done" },
      { kind: "done", id: "d-done" },
    ]);
    const direct = item("ts-direct", "in_progress", ["direct"], "test", [
      authorRun("cheap", { base: "h0" }),
    ]);
    const approved = item("ts-approved", "in_progress", [], "test", [
      authorDone("cheap", "c1"),
      reviewRun("cheap", { ending: "approved", commit: "c1", open: false }),
    ]);
    const world = new World(direct, approved);
    world.workers.set(direct.id, {
      ...worker(direct.id, "author", "working"),
      directory: "/build/test",
      repository: "/build/test",
      worktree: undefined,
    });
    onBranch(world, approved.id)();

    const state = await reading(world);

    expect(world.merged).toEqual([]);
    expect(world.tasks.get(approved.id)?.status).toBe("in_progress");
    expect(state.held).toEqual([
      {
        project: "test",
        reason: "busy",
        detail: `${direct.id} works in the checkout until it leaves the pipeline`,
        branch: `foreman/${direct.id}`,
      },
    ]);

    await Effect.runPromise(
      world.records.write(direct.id, {
        ...NO_WRITES,
        move: "complete",
        close: { author: "released", review: "released" },
        land: "committed",
      }),
    );
    await tick(world);
    expect(world.merged).toEqual(["c1"]);
  });

  test("a dirty checkout holds a start there, and not a worktree start", async () => {
    draw(DIRECT);
    const direct = item("ts-dirty", "open", []);
    const world = new World(direct);
    world.treeDirty = true;

    await tick(world);
    expect(world.spawned).toEqual([]);

    draw(STANDARD_PIPELINES.worktree.nodes);
    await tick(world);
    expect(world.spawned).toEqual([[direct.id, "author"]]);
  });

  test("a canceled task in the checkout has its workspace ended, which hands the checkout back", async () => {
    draw(BRANCH_ONLY);
    const task = item("ts-cancel-branch", "canceled", [], "test", [authorRun("cheap")]);
    const world = new World(task);
    world.workers.set(task.id, {
      ...worker(task.id, "author", "gone"),
      directory: "/build/test",
      repository: "/build/test",
      worktree: undefined,
    });

    await tick(world);

    expect(world.closed).toEqual([task.id]);
  });
});

describe("a reviewer that stops without naming an exit, and one that names returned", () => {
  /** Two reviewers on two accounts, so a review that stops has another to take. */
  const layerFor = (world: World) =>
    Layer.provideMerge(
      Dispatcher.Default,
      Layer.mergeAll(
        Layer.succeed(Settings, {
          ladder: [
            { name: "low", harness: "test", level: 0, model: "a/low", provider: undefined },
            { name: "mid", harness: "test", level: 1, model: "b/mid", provider: undefined },
            { name: "high", harness: "test", level: 2, model: "c/high", provider: undefined },
          ],
          reviewers: [
            { name: "mid", harness: "test", model: "b/mid", provider: undefined, thinking: "high" },
            {
              name: "high",
              harness: "test",
              model: "c/high",
              provider: undefined,
              thinking: "high",
            },
          ],
          otlpEndpoint: "http://localhost:4318",
          pollInterval: 60,
          staleAfter: 24,
          coachWindow: 60,
          stallGrace: 5,
          landedWindow: 7,
          attemptsPerLevel: 2,
        }),
        Layer.succeed(Fleet, world.fleet),
        Layer.succeed(Records, world.records),
        Layer.succeed(Tracker, world.tracker),
        Layer.succeed(Repository, world.repository),
        world.github,
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
    const world = new World(item(id, "in_progress", [], "test", runs));
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

  test("keeps the task in review, charges no attempt, and dispatches another reviewer", async () => {
    const world = stopped("ts-stopped", [authorDone("low"), reviewRun("mid")]);

    await tick(world);

    const task = world.tasks.get("ts-stopped");
    expect(task?.status).toBe("in_progress");
    expect(task?.labels).toEqual([]);
    expect(task?.charges).toEqual([]);
    expect(task?.parked).toBeUndefined();
    expect(task?.runs.slice(1)).toMatchObject([
      { rung: "mid", open: false, ending: "stopped" },
      { rung: "high", open: true },
    ]);
    expect(world.spawned).toEqual([["ts-stopped", "review"]]);
  });

  test("keeps recorded reviewer failures and the already-done claim when a spawn fails", async () => {
    const world = stopped("ts-spawn", [
      authorRun("low", { open: false, ending: "already-done" }),
      reviewRun("mid"),
    ]);
    world.spawnFails.add("ts-spawn");

    await tick(world).catch(() => undefined);

    const runs = world.tasks.get("ts-spawn")?.runs ?? [];
    expect(runs).toMatchObject([
      { role: "author", ending: "already-done" },
      { rung: "mid", open: false, ending: "stopped" },
    ]);
    expect(world.tasks.get("ts-spawn")?.status).toBe("in_progress");
  });

  test("hands the task to the operator when no reviewer is left", async () => {
    const world = stopped("ts-last", [
      authorDone("low"),
      reviewRun("mid", { open: false, ending: "stopped" }),
      reviewRun("high"),
    ]);

    await tick(world);

    const task = world.tasks.get("ts-last");
    expect(task?.status).toBe("open");
    expect(task?.labels).toEqual([]);
    expect(task?.parked).toContain("no reviewer is left");
    expect(world.spawned).toEqual([]);
  });

  test("a standard returned review keeps its workspace and claim, then authors a rung up through climb", async () => {
    const id = "ts-returned";
    const world = new World(item(id, "open", []));
    const exitNamed = (name: string) =>
      Effect.runPromise(
        Dispatcher.use((dispatcher) => dispatcher.exit(id, name)).pipe(
          Effect.provide(layerFor(world)),
        ),
      );
    const settle = (role: "author" | "review") =>
      world.workers.set(id, {
        ...world.workers.get(id)!,
        roles: new Map([[role, { state: "settled", since: undefined }]]),
        state: "settled",
      });

    await tick(world);
    expect(authoredBy(world.tasks.get(id)!)).toBe("low");
    world.branches.set(`foreman/${id}`, {
      branch: `foreman/${id}`,
      tip: "c1",
      merged: false,
      empty: false,
      stale: undefined,
    });
    await exitNamed("done");
    settle("author");
    await tick(world);
    await tick(world);
    expect(world.spawned.at(-1)).toEqual([id, "review"]);

    const workspace = world.workers.get(id)?.directory;
    await exitNamed("returned");
    expect(world.tasks.get(id)?.status).toBe("in_progress");
    settle("review");
    usePolicy({ ...ALLOWED, default: { ...ALLOWED.default, climb: "ask" } });
    await Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.tick).pipe(Effect.provide(layerFor(world))),
    );

    expect(failuresOf(world.tasks.get(id)!)).toContain("low");
    expect(world.spawned.at(-1)).toEqual([id, "review"]);
    const store = scratchStore();
    const printed: string[] = [];
    await Effect.runPromise(
      Command.runWith(pipelineCommand(layerFor(world)), { version: "test" })(["place"]).pipe(
        Effect.provideService(Console.Console, {
          ...console,
          log: (...args: ReadonlyArray<string>) => printed.push(args.join(" ")),
        }),
        Effect.provide(Layer.merge(BunServices.layer, store.layer)),
        Effect.ensuring(Effect.sync(store.cleanup)),
      ),
    );
    expect(printed).toEqual([
      `${id}  test  at author waiting  gates: climb (climb)  ahead: 2  ${id}`,
    ]);
    await tick(world);
    expect(world.spawned.at(-1)).toEqual([id, "author"]);
    expect(authoredBy(world.tasks.get(id)!)).toBe("mid");
    expect(world.workers.get(id)?.directory).toBe(workspace);
    expect(world.opened.every((directory) => directory === workspace)).toBe(true);
    expect(world.writes).not.toContain("records.release");
    expect(world.rows.map((row) => row.move)).not.toContain("reopen");
    expect(world.closed).toEqual([]);
    expect(world.removed).toEqual([]);
  });

  test("a charging exit wired back to the author, not the queue, charges the author's rung when its run closes", async () => {
    const drawn = join(policies, "pipelines.json");
    const nodes = STANDARD_PIPELINES.worktree.nodes.map((node) =>
      node.id === "review" && node.kind === "agent"
        ? {
            ...node,
            exits: [
              { name: "approved", to: "land-gate" },
              { name: "returned", to: "start", fails: "author" as const },
            ],
          }
        : node,
    );
    writeFileSync(drawn, JSON.stringify({ version: 4, pipelines: { test: { nodes } } }));
    try {
      const id = "ts-looped";
      const world = new World(item(id, "open", []));
      const exitNamed = (name: string) =>
        Effect.runPromise(
          Dispatcher.use((dispatcher) => dispatcher.exit(id, name)).pipe(
            Effect.provide(layerFor(world)),
          ),
        );
      const settle = (role: "author" | "review") =>
        world.workers.set(id, {
          ...world.workers.get(id)!,
          roles: new Map([[role, { state: "settled", since: undefined }]]),
          state: "settled",
        });

      await tick(world);
      world.branches.set(`foreman/${id}`, {
        branch: `foreman/${id}`,
        tip: "c1",
        merged: false,
        empty: false,
        stale: undefined,
      });
      await exitNamed("done");
      settle("author");
      await tick(world);
      await tick(world);
      expect(world.spawned.at(-1)).toEqual([id, "review"]);

      await exitNamed("returned");
      expect(world.tasks.get(id)?.status).toBe("in_progress");
      settle("review");
      await tick(world);

      expect(failuresOf(world.tasks.get(id)!)).toContain("low");
      // The wire leads back to the author, so the same tick dispatches the next
      // author a rung up, with no trip through the queue.
      expect(world.spawned.at(-1)).toEqual([id, "author"]);
      expect(authoredBy(world.tasks.get(id)!)).toBe("mid");
    } finally {
      rmSync(drawn, { force: true });
    }
  });
});

describe("a drawn pipeline", () => {
  const drawn = join(policies, "pipelines.json");
  const draw = (nodes: ReadonlyArray<PipelineNode>) =>
    writeFileSync(drawn, JSON.stringify({ version: 4, pipelines: { test: { nodes } } }));
  afterEach(() => rmSync(drawn, { force: true }));

  /** The standard pipeline with `change` made to its author block. */
  const withAuthor = (change: (author: AgentNode) => ReadonlyArray<PipelineNode>) =>
    STANDARD_PIPELINES.worktree.nodes.flatMap((node) =>
      node.kind === "agent" && node.id === "author" ? change(node) : [node],
    );

  /** A task its author handed off on commit c1, which is its branch's tip. */
  const handedOver = (id: string) => {
    const world = new World(item(id, "in_progress", [], "test", [authorDone("cheap", "c1")]));
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
                  {
                    name: "cheap",
                    harness: "test",
                    level: 0,
                    model: undefined,
                    provider: undefined,
                  },
                  {
                    name: "dear",
                    harness: "test",
                    level: 1,
                    model: undefined,
                    provider: undefined,
                  },
                ],
                reviewers: [],
                otlpEndpoint: "http://localhost:4318",
                pollInterval: 60,
                staleAfter: 24,
                coachWindow: 60,
                stallGrace: 5,
                landedWindow: 7,
                attemptsPerLevel: 2,
              }),
              Layer.succeed(Fleet, world.fleet),
              Layer.succeed(Records, world.records),
              Layer.succeed(Tracker, world.tracker),
              Layer.succeed(Repository, world.repository),
              world.github,
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
      STANDARD_PIPELINES.worktree.nodes
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

    expect(world.tasks.get("ts-parked")?.labels).toEqual(["hold"]);
    expect(world.tasks.get("ts-parked")?.parked).toBeDefined();
    expect(world.writes.filter((write) => write === "records.park")).toHaveLength(1);
    expect(world.spawned).toEqual([]);
  });

  describe("with a check after the author", () => {
    beforeEach(() =>
      draw(
        withAuthor((author) => [
          { ...author, exits: author.exits.map((exit) => ({ ...exit, to: "lint-gate" })) },
          { kind: "gate", id: "lint-gate", step: "review", next: "lint" },
          {
            kind: "check",
            id: "lint",
            command: "bun run lint",
            exits: [
              { name: "passed", to: "review-gate" },
              { name: "failed", to: "queue", fails: "author" },
            ],
          },
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
      await Effect.runPromise(world.records.endReview("ts-moved", "approved"));
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
      expect(failuresOf(task!)).toContain("cheap");
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
      item("ts-approved", "in_progress", [], "test", [authorDone("cheap", "c1")]),
      [reviewRun("cheap", { ending: "approved", commit: "c1", open: false })],
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
          ...console,
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

describe("foreman pipeline trace", () => {
  const drawn = join(policies, "pipelines.json");
  afterEach(() => rmSync(drawn, { force: true }));
  /** Three rungs on one bare harness, so a review always has a rung above its author. */
  const THREE: Ladder = [
    { name: "low", harness: "test", level: 0, model: "a/low", provider: undefined },
    { name: "mid", harness: "test", level: 1, model: "b/mid", provider: undefined },
    { name: "high", harness: "test", level: 2, model: "c/high", provider: undefined },
  ];
  /** A free opencode rung, whose screen can show a usage wall, then a rung on another account. */
  const WALLED: Ladder = [
    {
      name: "free",
      harness: "opencode",
      level: 0,
      model: "opencode/free-model",
      provider: undefined,
    },
    { name: "dear", harness: "test", level: 1, model: "anthropic/claude", provider: undefined },
  ];

  /**
   * Each rung above the bottom as a reviewer of its own name and model, so a
   * review of the bottom's work and of the next rung's work each has a reader
   * of another model.
   */
  const reviewersOf = (ladder: Ladder): ReadonlyArray<Reviewer> =>
    ladder.slice(1).map((rung) => ({
      name: rung.name,
      harness: rung.harness,
      model: rung.model ?? rung.name,
      provider: rung.provider,
      thinking: "high",
    }));

  const layerWith = (world: World, ladder: Ladder) =>
    Layer.provideMerge(
      Dispatcher.Default,
      Layer.mergeAll(
        Layer.succeed(Settings, {
          ladder,
          reviewers: reviewersOf(ladder),
          otlpEndpoint: "http://localhost:4318",
          pollInterval: 60,
          staleAfter: 24,
          coachWindow: 60,
          stallGrace: 5,
          landedWindow: 7,
          attemptsPerLevel: 2,
        }),
        Layer.succeed(Fleet, world.fleet),
        Layer.succeed(Records, world.records),
        Layer.succeed(Tracker, world.tracker),
        Layer.succeed(Repository, world.repository),
        world.github,
        Layer.succeed(Quota, {
          usage: (provider: string) =>
            Effect.succeed({ provider, plan: undefined, allowances: [] }),
        }),
        prompts,
        BunServices.layer,
      ),
    );

  /**
   * Plays the events in a world, as an agent's pane, the operator and the
   * proving ground would make them, and answers where the task stands after
   * the start and after each event. A check or a landing is held until its
   * event says how it ends, so the task waits at that block as the trace's
   * does.
   */
  const played = async (ladder: Ladder, pipeline: Pipeline, events: ReadonlyArray<TraceEvent>) => {
    const id = "ts-traced";
    const branch = `foreman/${id}`;
    const world = new World(item(id, "open", []));
    world.branches.set(branch, {
      branch,
      tip: "c0",
      merged: false,
      empty: false,
      stale: undefined,
    });
    const run = <A, E>(effect: Effect.Effect<A, E, Dispatcher>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layerWith(world, ladder))));
    const settle = async () => {
      for (let round = 0; round < 3; round++) await run(Dispatcher.use((d) => d.tick));
      hold(world);
      world.screens.delete(id);
      const task = world.tasks.get(id)!;
      return place(pipeline, factsOf({ ...task, tip: world.branches.get(branch)!.tip }, pipeline));
    };

    hold(world);
    const placements = [await settle()];
    for (const event of events) {
      await happen(world, id, event, pipeline, run);
      placements.push(await settle());
    }
    return { placements, parked: world.tasks.get(id)!.parked };
  };

  const hold = (world: World) => {
    world.checking = { _tag: "Held", detail: "held for the trace" };
    world.landing = { _tag: "Held", detail: "held for the trace" };
  };

  /** How the proving ground ends a held check or landing, by the trace's event. */
  const OUTCOMES: Record<string, (world: World) => void> = {
    passed: (world) => (world.checking = { _tag: "Passed", verified: true }),
    failed: (world) => (world.checking = { _tag: "Failed", output: "lint: 3 problems" }),
    landed: (world) => (world.landing = { _tag: "Merged", verified: true }),
  };

  /**
   * Makes one event happen to the task's open agent: an author commits on the
   * next made-up commit before its exit, a wall shows on its screen, and its
   * pane goes idle. A check's or a landing's event sets its outcome.
   */
  const happen = async (
    world: World,
    id: string,
    event: TraceEvent,
    pipeline: Pipeline,
    run: (effect: Effect.Effect<unknown, unknown, Dispatcher>) => Promise<unknown>,
  ) => {
    OUTCOMES[event]?.(world);
    const role = openAgentOf(pipeline, world.tasks.get(id)!)?.block.role;
    if (role === undefined) return;
    const branch = world.branches.get(`foreman/${id}`)!;
    if (event.startsWith("exit:")) {
      if (role === "author") {
        world.branches.set(branch.branch, {
          ...branch,
          tip: `c${Number(branch.tip.slice(1)) + 1}`,
        });
      }
      await run(Dispatcher.use((d) => d.exit(id, event.slice("exit:".length))));
    }
    if (event === "wall") world.screens.set(id, "Free usage limit reached. Connect a provider");
    world.workers.set(id, {
      ...world.workers.get(id)!,
      roles: new Map([[role, { state: "settled", since: undefined }]]),
      state: "settled",
    });
  };

  /** Runs the events through the dispatcher and through the trace, and compares where each puts the task. */
  const agree = async (ladder: Ladder, pipeline: Pipeline, events: ReadonlyArray<TraceEvent>) => {
    if (pipeline !== STANDARD_PIPELINES.worktree) {
      writeFileSync(drawn, JSON.stringify({ version: 4, pipelines: { test: pipeline } }));
    }
    const world = await played(ladder, pipeline, events);
    const trace = traceOf({ labels: [], size: undefined, priority: 1, parent: undefined }, events, {
      ladder,
      reviewers: reviewersOf(ladder),
      attemptsPerLevel: 2,
      pipeline,
    });
    expect(trace.refused).toBeUndefined();
    expect(trace.steps.map((step) => step.placement)).toEqual(world.placements);
    expect(trace.steps.at(-1)?.parked).toBe(world.parked);
    return trace;
  };

  /** The standard pipeline with `change` made to its author block. */
  const withAuthor = (change: (author: AgentNode) => ReadonlyArray<PipelineNode>): Pipeline => ({
    nodes: STANDARD_PIPELINES.worktree.nodes.flatMap((node) =>
      node.kind === "agent" && node.id === "author" ? change(node) : [node],
    ),
  });

  test("an approved review lands", async () => {
    const trace = await agree(THREE, STANDARD_PIPELINES.worktree, [
      "exit:done",
      "exit:approved",
      "landed",
    ]);
    expect(trace.steps.at(-1)?.placement).toEqual({ _tag: "Outside" });
  });

  test("a returned review fails its author, and the next author climbs", async () => {
    const trace = await agree(THREE, STANDARD_PIPELINES.worktree, [
      "exit:done",
      "exit:returned",
      "exit:done",
      "exit:approved",
    ]);
    expect(
      trace.steps.map((step) => step.rung?._tag === "Dispatch" && step.rung.seat.name),
    ).toEqual(["low", "mid", "mid", "high", false]);
    expect(trace.steps.at(-1)?.tip).toBe("c2");
  });

  test("stops spend a rung's attempts, then climb", async () => {
    const trace = await agree(THREE, STANDARD_PIPELINES.worktree, ["stop", "stop", "stop"]);
    expect(
      trace.steps.map((step) => step.rung?._tag === "Dispatch" && step.rung.seat.name),
    ).toEqual(["low", "low", "mid", "mid"]);
    // The test harness prints no wall text foreman knows, so a wall reads as a stop.
    expect(trace.steps[0]?.offers).not.toContain("wall");
  });

  test("a wall moves the author to another account", async () => {
    const trace = await agree(WALLED, STANDARD_PIPELINES.worktree, ["wall"]);
    expect(trace.steps[0]?.offers).toContain("wall");
    expect(trace.steps.at(-1)?.rung).toMatchObject({ _tag: "Dispatch", seat: { name: "dear" } });
  });

  test("a failed check returns the task, and a pass sends it on to review", async () => {
    const trace = await agree(
      THREE,
      withAuthor((author) => [
        { ...author, exits: author.exits.map((exit) => ({ ...exit, to: "lint-gate" })) },
        { kind: "gate", id: "lint-gate", step: "review", next: "lint" },
        {
          kind: "check",
          id: "lint",
          command: "bun run lint",
          exits: [
            { name: "passed", to: "review-gate" },
            { name: "failed", to: "queue", fails: "author" },
          ],
        },
      ]),
      ["exit:done", "failed", "exit:done", "passed", "exit:approved", "landed"],
    );
    expect(trace.steps.map((step) => step.offers[0])).toEqual([
      "exit:done",
      "passed",
      "exit:done",
      "passed",
      "exit:approved",
      "landed",
      undefined,
    ]);
  });

  test("a block that parks a stop parks the task, and offers nothing", async () => {
    const trace = await agree(
      THREE,
      withAuthor((author) => [{ ...author, stopped: "park" }]),
      ["stop"],
    );
    expect(trace.steps.at(-1)?.parked).toContain("stopped without naming an exit");
    expect(trace.steps.at(-1)?.offers).toEqual([]);
  });
});

describe("a pull-request landing", () => {
  const drawn = join(policies, "pipelines.json");
  // The standard worktree pipeline, landing by pull request, with a publish
  // gate between the review and the land gate.
  const PULL_REQUEST: Pipeline = {
    nodes: [
      ...STANDARD_PIPELINES.worktree.nodes.map((node): PipelineNode =>
        node.kind === "land"
          ? { ...node, how: "pull-request" }
          : node.kind === "agent" && node.role === "review"
            ? {
                ...node,
                exits: node.exits.map((exit) =>
                  exit.to === "land-gate" ? { ...exit, to: "publish-gate" } : exit,
                ),
              }
            : node,
      ),
      { kind: "gate", id: "publish-gate", step: "publish", next: "land-gate" },
    ],
  };
  beforeEach(() =>
    writeFileSync(drawn, JSON.stringify({ version: 4, pipelines: { test: PULL_REQUEST } })),
  );

  const steps = (modes: { publish: string; land: string }, extra: object = {}) =>
    usePolicy({
      slots: 1,
      default: { author: "off", climb: "off", review: "off", ...modes },
      ...extra,
    });

  interface Pull {
    readonly number: number;
    readonly url: string;
    readonly state: "OPEN" | "CLOSED" | "MERGED";
    readonly headRefOid: string;
    readonly mergeStateStatus: string;
    readonly reviews: ReadonlyArray<{ readonly commit: { readonly oid: string } }>;
  }
  const pull = (overrides: Partial<Pull> = {}): Pull => ({
    number: 7,
    url: "https://github.com/o/r/pull/7",
    state: "OPEN",
    headRefOid: "c1",
    mergeStateStatus: "CLEAN",
    reviews: [],
    ...overrides,
  });

  /**
   * A task approved on c1, whose branch the world holds at c1, over a GitHub
   * that holds `pulls` for its branch and answers `checks` for any PR. A
   * `pr create` fails while `createFails` is set.
   */
  const approvedOn = (
    pulls: Array<Pull>,
    checks: ReadonlyArray<{ name: string; bucket: string }> = [{ name: "ci", bucket: "pass" }],
  ) => {
    const task = item("ts-pr", "in_progress", [], "test", [
      authorDone("cheap"),
      reviewRun("cheap", { ending: "approved", commit: "c1", open: false }),
    ]);
    const world = new World(task);
    world.branches.set("foreman/ts-pr", {
      branch: "foreman/ts-pr",
      merged: false,
      empty: false,
      stale: undefined,
      tip: "c1",
    });
    const github = { pulls, createFails: false };
    world.answerGh = (args) => {
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      const [noun, verb] = args;
      if (noun === "repo") return ok("o/r\n");
      if (noun !== "pr") return { exitCode: 1, stdout: "", stderr: `unexpected gh ${noun}` };
      switch (verb) {
        case "list":
          return ok(JSON.stringify(github.pulls));
        case "checks":
          return checks.length === 0
            ? {
                exitCode: 1,
                stdout: "",
                stderr: "no required checks reported on the 'foreman/ts-pr' branch",
              }
            : ok(JSON.stringify(checks));
        case "create":
          if (github.createFails) return { exitCode: 1, stdout: "", stderr: "HTTP 502" };
          github.pulls.push(pull());
          return ok("https://github.com/o/r/pull/7\n");
        default:
          return ok("");
      }
    };
    return { task, world, github };
  };
  const verbs = (world: World) =>
    world.ghCalls.filter(([noun]) => noun === "pr").map(([, verb]) => verb);

  test("publish pushes the approved commit and opens a pull request", async () => {
    steps({ publish: "on", land: "off" });
    const { world } = approvedOn([]);

    await tick(world);

    expect(world.pushed).toEqual([["foreman/ts-pr", "c1"]]);
    const create = world.ghCalls.find(([noun, verb]) => noun === "pr" && verb === "create")!;
    expect(create).toEqual(expect.arrayContaining(["--head", "foreman/ts-pr", "--base", "main"]));
    expect(world.merged).toEqual([]);
    expect(world.tasks.get("ts-pr")?.status).toBe("in_progress");
  });

  test("a publish stopped after its push pushes again and opens one pull request", async () => {
    steps({ publish: "on", land: "off" });
    const { world, github } = approvedOn([]);
    github.createFails = true;

    await tick(world);
    expect(world.pushed).toEqual([["foreman/ts-pr", "c1"]]);
    expect(github.pulls).toEqual([]);

    github.createFails = false;
    await tick(world);
    await tick(world);

    expect(world.pushed).toEqual([
      ["foreman/ts-pr", "c1"],
      ["foreman/ts-pr", "c1"],
    ]);
    expect(github.pulls).toHaveLength(1);
    expect(verbs(world).filter((verb) => verb === "create")).toHaveLength(2);
  });

  test("an open pull request behind the approved commit takes the push and no new PR", async () => {
    steps({ publish: "on", land: "off" });
    const { world } = approvedOn([pull({ headRefOid: "c0" })]);
    world.ancestors.add("c0..c1");

    await tick(world);

    expect(world.pushed).toEqual([["foreman/ts-pr", "c1"]]);
    expect(verbs(world)).not.toContain("create");
  });

  test("publish off pushes nothing; publish ask asks for it", async () => {
    steps({ publish: "off", land: "on" });
    const { world } = approvedOn([]);
    await tick(world);
    expect(world.pushed).toEqual([]);

    steps({ publish: "ask", land: "on" });
    expect(await asksAfter(world)).toEqual([{ task: "ts-pr", step: "publish", rung: "cheap" }]);
    expect(world.pushed).toEqual([]);
  });

  test("land on posts a comment review and merges at the approved commit", async () => {
    steps({ publish: "on", land: "on" });
    const { world } = approvedOn([pull()]);

    await tick(world);

    const review = world.ghCalls.find(([, verb]) => verb === "review")!;
    expect(review).toContain("--comment");
    const merge = world.ghCalls.find(([, verb]) => verb === "merge")!;
    expect(merge).toEqual(expect.arrayContaining(["--merge", "--match-head-commit", "c1"]));
    // GitHub merges; the task completes on the reading that says so.
    expect(world.tasks.get("ts-pr")?.status).toBe("in_progress");
  });

  test("a review already posted on the approved commit is not posted again", async () => {
    steps({ publish: "on", land: "on" });
    const { world } = approvedOn([pull({ reviews: [{ commit: { oid: "c1" } }] })]);

    await tick(world);

    expect(verbs(world)).not.toContain("review");
    expect(verbs(world)).toContain("merge");
  });

  test("the approve kind posts an approval with the token its variable names", async () => {
    process.env["FOREMAN_TEST_REVIEW_TOKEN"] = "secret";
    steps(
      { publish: "on", land: "on" },
      {
        projects: {
          test: { pullRequest: { review: "approve", reviewTokenEnv: "FOREMAN_TEST_REVIEW_TOKEN" } },
        },
      },
    );
    const { world } = approvedOn([pull()]);

    await tick(world);
    delete process.env["FOREMAN_TEST_REVIEW_TOKEN"];

    const at = world.ghCalls.findIndex(([, verb]) => verb === "review");
    expect(world.ghCalls[at]).toContain("--approve");
    expect(world.ghOptions[at]?.env).toEqual({ GH_TOKEN: "secret" });
  });

  test("the approve kind with its variable unset reads as unreachable and takes no step", async () => {
    steps(
      { publish: "on", land: "on" },
      {
        projects: {
          test: { pullRequest: { review: "approve", reviewTokenEnv: "FOREMAN_TEST_UNSET" } },
        },
      },
    );
    const { world } = approvedOn([pull()]);

    await tick(world);

    expect(verbs(world)).toEqual([]);
  });

  test("land ask posts the review, asks, and merges nothing until approved", async () => {
    steps({ publish: "on", land: "ask" });
    const { world } = approvedOn([pull()]);

    expect(await asksAfter(world)).toEqual([{ task: "ts-pr", step: "land", rung: "cheap" }]);
    expect(verbs(world)).toContain("review");
    expect(verbs(world)).not.toContain("merge");

    steps(
      { publish: "on", land: "ask" },
      { grants: [{ scope: "ts-pr", steps: ["land"], remaining: 1, admitted: [] }] },
    );
    await tick(world);
    expect(verbs(world)).toContain("merge");
  });

  test("the reading says which pull requests the plan merges, a land grant included", async () => {
    const mergingAfter = (world: World) =>
      Effect.runPromise(
        Dispatcher.use((dispatcher) =>
          dispatcher.tick.pipe(
            Effect.andThen(SubscriptionRef.get(dispatcher.state)),
            Effect.map((state) => [...state.merging]),
          ),
        ).pipe(Effect.provide(layerFor(world))),
      );
    steps({ publish: "on", land: "off" });
    const { world } = approvedOn([pull()]);
    expect(await mergingAfter(world)).toEqual([]);

    steps(
      { publish: "on", land: "off" },
      { grants: [{ scope: "ts-pr", steps: ["land"], remaining: 1, admitted: [] }] },
    );
    expect(await mergingAfter(world)).toEqual(["ts-pr"]);
  });

  test("land off posts the review and leaves the merge to the operator", async () => {
    steps({ publish: "on", land: "off" });
    const { world, github } = approvedOn([pull()]);

    await tick(world);
    expect(verbs(world)).toContain("review");
    expect(verbs(world)).not.toContain("merge");

    github.pulls[0] = pull({ state: "MERGED" });
    await tick(world);

    expect(world.tasks.get("ts-pr")?.status).toBe("done");
    expect(world.removed).toContain("foreman/ts-pr");
    expect(world.closed).toContain("ts-pr");
  });

  test("required checks still pending hold the merge", async () => {
    steps({ publish: "on", land: "on" });
    const { world } = approvedOn([pull()], [{ name: "ci", bucket: "pending" }]);

    await tick(world);

    expect(verbs(world)).not.toContain("merge");
  });

  test("a repo with no required checks merges on review alone, and says so", async () => {
    steps({ publish: "on", land: "on" });
    const { world } = approvedOn([pull()], []);

    await tick(world);

    expect(verbs(world)).toContain("merge");
    expect(world.logs.some(([, line]) => line.includes("merges on review alone"))).toBe(true);
  });

  test("a head that moved is fetched into the branch, which voids the approval", async () => {
    steps({ publish: "on", land: "on" });
    const { world } = approvedOn([pull({ headRefOid: "c9" })]);
    world.remoteHeads.set("foreman/ts-pr", "c9");
    world.ancestors.add("c1..c9");

    await tick(world);

    expect(world.branches.get("foreman/ts-pr")?.tip).toBe("c9");
    expect(verbs(world)).not.toContain("merge");
    expect(world.pushed).toEqual([]);
  });

  test("a head rewritten past the branch parks the task", async () => {
    steps({ publish: "on", land: "on" });
    const { world } = approvedOn([pull({ headRefOid: "c9" })]);
    world.remoteHeads.set("foreman/ts-pr", "c9");

    await tick(world);

    expect(world.tasks.get("ts-pr")?.parked).toContain("was rewritten");
  });

  test("a conflict returns the task to the queue at the same rung", async () => {
    steps({ publish: "on", land: "on" });
    const { world } = approvedOn([pull({ mergeStateStatus: "DIRTY" })]);

    await tick(world);

    expect(world.tasks.get("ts-pr")?.status).toBe("open");
    expect(world.tasks.get("ts-pr")?.charges).toEqual([]);
    expect(verbs(world)).not.toContain("merge");
  });

  test("a failed required check returns the task a rung up, with the checks in its log", async () => {
    steps({ publish: "on", land: "on" });
    const { world } = approvedOn([pull()], [{ name: "ci", bucket: "fail" }]);

    await tick(world);

    const task = world.tasks.get("ts-pr")!;
    expect(task.status).toBe("open");
    expect(failuresOf(task)).toEqual(["cheap"]);
    expect(world.logs.some(([, line]) => line.includes("fail\tci"))).toBe(true);
    expect(verbs(world)).not.toContain("merge");
  });

  test("a pull request closed without a merge parks the task by default", async () => {
    steps({ publish: "on", land: "on" });
    const { world } = approvedOn([pull({ state: "CLOSED" })]);

    await tick(world);

    expect(world.tasks.get("ts-pr")?.parked).toContain("closed without a merge");
  });

  test("closed: requeue returns the task to the queue with no charge", async () => {
    steps(
      { publish: "on", land: "on" },
      { projects: { test: { pullRequest: { closed: "requeue" } } } },
    );
    const { world } = approvedOn([pull({ state: "CLOSED" })]);

    await tick(world);

    const task = world.tasks.get("ts-pr")!;
    expect(task.status).toBe("open");
    expect(task.parked).toBeUndefined();
    expect(task.charges).toEqual([]);
  });

  test("closed: cancel cancels the task", async () => {
    steps(
      { publish: "on", land: "on" },
      { projects: { test: { pullRequest: { closed: "cancel" } } } },
    );
    const { world } = approvedOn([pull({ state: "CLOSED" })]);

    await tick(world);

    expect(world.tasks.get("ts-pr")?.status).toBe("canceled");
  });

  test("a pull request closed at another commit is passed over, and publish opens a new one", async () => {
    steps({ publish: "on", land: "off" });
    const { world, github } = approvedOn([pull({ state: "CLOSED", headRefOid: "c0" })]);

    await tick(world);

    expect(world.pushed).toEqual([["foreman/ts-pr", "c1"]]);
    expect(github.pulls).toHaveLength(2);
  });

  test("a paused project reads its pull request and writes nothing", async () => {
    steps({ publish: "on", land: "on" }, { projects: { test: { paused: true } } });
    const { world } = approvedOn([pull({ state: "MERGED" })]);

    await tick(world);

    expect(world.tasks.get("ts-pr")?.status).toBe("in_progress");
    expect(world.writes).toEqual([]);
  });
});

describe("ladder levels", () => {
  /** Three peers between a bottom and a top level, all on one bare harness. */
  const LEVELS: Ladder = [
    { name: "low", harness: "test", level: 0, model: undefined, provider: undefined },
    { name: "one", harness: "test", level: 1, model: undefined, provider: undefined },
    { name: "two", harness: "test", level: 1, model: undefined, provider: undefined },
    { name: "three", harness: "test", level: 1, model: undefined, provider: undefined },
    { name: "high", harness: "test", level: 2, model: undefined, provider: undefined },
  ];
  const layerFor = (world: World) =>
    Layer.provideMerge(
      Dispatcher.Default,
      Layer.mergeAll(
        Layer.succeed(Settings, {
          ladder: LEVELS,
          reviewers: [],
          otlpEndpoint: "http://localhost:4318",
          pollInterval: 60,
          staleAfter: 24,
          coachWindow: 60,
          stallGrace: 5,
          landedWindow: 7,
          attemptsPerLevel: 2,
        }),
        Layer.succeed(Fleet, world.fleet),
        Layer.succeed(Records, world.records),
        Layer.succeed(Tracker, world.tracker),
        Layer.succeed(Repository, world.repository),
        world.github,
        Quota.Default,
        prompts,
        BunServices.layer,
      ),
    );
  const tick = (world: World) =>
    Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.tick).pipe(Effect.provide(layerFor(world))),
    );
  /** A queued task the bottom level has failed. */
  const pastLow = (id: string) => ({ ...item(id, "open", []), charges: [charged("low")] });
  const authors = (world: World) =>
    [...world.tasks.values()].map((task) => authoredBy(task)).filter((rung) => rung !== undefined);

  test("one tick spreads its free slots over the peers of a level", async () => {
    usePolicy({ ...ALLOWED, slots: 3 });
    const world = new World(pastLow("ts-a"), pastLow("ts-b"), pastLow("ts-c"));
    await tick(world);

    expect(authors(world).toSorted()).toEqual(["one", "three", "two"]);
  });

  test("the next tick takes the peer that started longest ago", async () => {
    const world = new World(pastLow("ts-first"));
    await tick(world);
    expect(authors(world)).toEqual(["one"]);

    world.tasks.set("ts-second", pastLow("ts-second"));
    usePolicy({ ...ALLOWED, slots: 2 });
    await tick(world);
    expect(authors(world)).toEqual(["one", "two"]);
  });

  test("one failure on a peer sends the task past the whole level", async () => {
    const world = new World({ ...item("ts-up", "open", []), charges: [charged("two")] });
    await tick(world);

    expect(authors(world)).toEqual(["high"]);
  });

  test("descend takes back every charge at the highest failed level", async () => {
    const task = {
      ...item("ts-down", "open", []),
      charges: [charged("low"), charged("one"), charged("three")],
    };
    const world = new World(task);
    await Effect.runPromise(
      Dispatcher.use((dispatcher) => dispatcher.descend(task)).pipe(
        Effect.provide(layerFor(world)),
      ),
    );

    expect([...world.tasks.values()].map(failuresOf)).toEqual([["low"]]);
  });
});
