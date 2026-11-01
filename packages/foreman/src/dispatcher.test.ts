import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  awaitingLanding,
  decisionsOf,
  dispatchesFor as plan,
  failedTasks,
  handoffExpired,
  isUnread,
  landedColumn,
  nextFailure,
  recoverable,
  readyToLand,
  reviewable,
  scopeRoster,
  ours,
  waiting,
  type Owned,
} from "./dispatcher.ts";
import { authoredBy, diagnosticIntent, reviewedBy, type Item, type TaskStatus } from "./prog.ts";
import type { AgentRole, Worker, WorkerState } from "./fleet.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";

const task = (
  id: string,
  labels: ReadonlyArray<string>,
  status: TaskStatus = "reviewing",
  priority = 1,
  project = "foreman",
): Item => ({
  id,
  title: `Task ${id}`,
  status,
  project,
  type: "task",
  priority,
  labels,
  description: null,
  parent: null,
  last_activity_at: new Date(),
  created_at: new Date(),
});

const worker = (state: WorkerState, id = "ts-123456"): Worker => ({
  task: id,
  directory: "/tmp/worktree",
  repository: "/home/dan/build/project",
  worktree: "/tmp/worktree",
  state,
  roles: new Map([
    ["author", "settled"],
    ["review", state],
  ]),
});

const active = (task: Item, worker: Worker | undefined) => ({
  task,
  worker,
  kind: reviewedBy(task) ?? authoredBy(task),
});

const owned = (
  id: string,
  status: TaskStatus,
  labels: ReadonlyArray<string>,
  roles: ReadonlyArray<AgentRole> = [],
): Owned => {
  const item = task(id, labels, status);
  return {
    task: item,
    worker: {
      ...worker("gone", id),
      roles: new Map(roles.map((role) => [role, "settled" as const])),
    },
    kind: reviewedBy(item) ?? authoredBy(item),
  };
};

describe("landing a reviewed branch", () => {
  test("waits for a reviewer that is still finishing its turn", () => {
    const approved = task("ts-123456", ["by:opencode", "review-by:claude", "approved"]);

    // The pane stays "working" from the moment the reviewer writes its verdict
    // until its whole turn ends. Landing inside that window closes the
    // workspace with `worktree remove --force` and deletes the directory the
    // reviewer is standing in.
    expect(readyToLand(approved, worker("working"))).toBe(false);
    expect(readyToLand(approved, worker("settled"))).toBe(true);
    expect(readyToLand(approved, undefined)).toBe(true);
  });

  test("keeps an approved task out of the ordinary settle path either way", () => {
    const approved = task("ts-123456", ["by:opencode", "review-by:claude", "approved"]);

    // The two filters in settle must agree. A task excluded from landing
    // because its reviewer is live must not fall through to the branch that
    // treats it as a reviewer who stopped without a verdict.
    expect(readyToLand(approved, worker("working"))).toBe(false);
    expect(awaitingLanding(approved)).toBe(true);
  });

  test("ignores a task without a verdict, and one that already left review", () => {
    expect(awaitingLanding(task("ts-123456", ["by:opencode", "review-by:claude"]))).toBe(false);
    expect(awaitingLanding(task("ts-123456", ["by:opencode", "approved"], "in_progress"))).toBe(
      false,
    );
  });

  test("lands nothing on size or priority alone", () => {
    // A branch reaches the operator's checkout on a reviewer's verdict and
    // nothing else, however small the task that produced it says it is.
    expect(awaitingLanding(task("ts-123456", ["by:opencode", "trivial"]))).toBe(false);
    expect(awaitingLanding(task("ts-123456", ["by:opencode"], "reviewing", 3))).toBe(false);
  });
});

describe("the author's pane after a handoff", () => {
  const at = (item: Item, when: Date): Item => ({ ...item, last_activity_at: when });
  const cutoff = DateTime.fromDateUnsafe(new Date("2026-08-15T12:00:00Z"));

  test("keeps a fresh handoff alive for a reviewer to coach", () => {
    // The author's session is the only place its context exists, and a
    // mechanical finding sent back to it costs a fraction of the rung climb
    // that would otherwise re-derive all of it.
    const handed = at(task("ts-123456", ["by:opencode"]), new Date("2026-08-15T12:15:00Z"));

    expect(handoffExpired(handed, cutoff)).toBe(false);
  });

  test("closes one nobody reached inside the window", () => {
    // A second resident model per task in review is the cost, so a review
    // backlog must not accumulate one for every task waiting in it.
    const stranded = at(task("ts-123456", ["by:opencode"]), new Date("2026-08-15T11:15:00Z"));

    expect(handoffExpired(stranded, cutoff)).toBe(true);
  });
});

describe("diagnostic intervention", () => {
  test("derives its durable intent from the task label", () => {
    expect(diagnosticIntent(task("ts-1", ["by:opencode", "diagnosing:diagnose"]))).toBe("diagnose");
    expect(diagnosticIntent(task("ts-2", ["diagnosing:review"]))).toBe("review");
    expect(diagnosticIntent(task("ts-3", ["by:opencode"]))).toBeUndefined();
  });
});

describe("decisions", () => {
  test("surfaces an author or reviewer whose workspace is empty or gone", () => {
    const claimed = [active(task("ts-1", ["by:opencode"], "in_progress"), undefined)];
    const reviewing = [
      active(
        task("ts-2", ["by:opencode", "review-by:claude"], "reviewing"),
        worker("gone", "ts-2"),
      ),
    ];

    const decisions = decisionsOf(claimed, reviewing, []);
    expect(decisions.map((decision) => decision.task.id)).toEqual(["ts-1", "ts-2"]);
  });

  test("ignores a claimed or reviewing task that is still being worked", () => {
    const claimed = [
      active(task("ts-1", ["by:opencode"], "in_progress"), worker("working", "ts-1")),
    ];
    const reviewing = [
      active(
        task("ts-2", ["by:opencode", "review-by:claude"], "reviewing"),
        worker("working", "ts-2"),
      ),
    ];

    expect(decisionsOf(claimed, reviewing, [])).toEqual([]);
  });

  test("surfaces a workspace whose task is in any other status", () => {
    // A failed spawn leaves the by-* label on while the task returns to the
    // queue; the status is what makes it residue rather than a vanished author.
    const ownedWorkspaces = [
      owned("ts-3", "open", ["by:opencode"]),
      owned("ts-4", "done", []),
      owned("ts-5", "canceled", ["by:opencode"]),
    ];

    const decisions = decisionsOf([], [], ownedWorkspaces);
    expect(decisions.map((decision) => decision.task.id)).toEqual(["ts-3", "ts-4", "ts-5"]);
  });

  // A role proves the claim happened and was given up, because dispatch labels
  // the pane only when it spawns. Settle sweeps those itself; a workspace with
  // no role is the one case foreman cannot prove is spent.
  test("asks only about residue it cannot prove is spent", () => {
    const ownedWorkspaces = [
      owned("ts-3", "open", ["by:opencode"], ["author"]),
      owned("ts-4", "open", ["by:opencode", "review-by:claude"], ["author", "review"]),
      owned("ts-5", "open", ["by:opencode"]),
    ];

    const decisions = decisionsOf([], [], ownedWorkspaces);
    expect(decisions.map((decision) => decision.task.id)).toEqual(["ts-5"]);
  });

  // The reviewer's pane closes the moment its verdict is written, so until the
  // checkout is clean the task has a review-by-* label and no worker — the
  // exact shape of a vanished reviewer. A held project would otherwise turn
  // every review it had passed into a question whose only answer is "wait".
  test("does not mistake a finished review waiting on a held project for a vanished one", () => {
    const approved = active(
      task("ts-2", ["by:opencode", "review-by:claude", "approved"], "reviewing"),
      undefined,
    );
    const unfinished = active(
      task("ts-4", ["by:opencode", "review-by:claude"], "reviewing"),
      undefined,
    );

    const decisions = decisionsOf([], [approved, unfinished], []);
    expect(decisions.map((decision) => decision.task.id)).toEqual(["ts-4"]);
  });

  test("keeps claimed and reviewing workspaces out of the orphaned kind", () => {
    const ownedWorkspaces = [
      owned("ts-1", "in_progress", ["by:opencode"]),
      owned("ts-2", "reviewing", ["by:opencode", "review-by:claude"]),
    ];

    expect(decisionsOf([], [], ownedWorkspaces)).toEqual([]);
  });
});

describe("dispatch failures", () => {
  test("counts the first failure as news and the second identical one as a decision", () => {
    const first = nextFailure(new Map(), "ts-1", "open: already exists");
    expect(first.report).toBe("first");
    expect(first.failures.get("ts-1")).toEqual({ detail: "open: already exists", count: 1 });

    const second = nextFailure(first.failures, "ts-1", "open: already exists");
    expect(second.report).toBe("repeat");
    expect(second.failures.get("ts-1")).toEqual({ detail: "open: already exists", count: 2 });

    // Past the decision nothing changes to report.
    const third = nextFailure(second.failures, "ts-1", "open: already exists");
    expect(third.report).toBe("quiet");
    expect(third.failures.get("ts-1")?.count).toBe(3);
  });

  test("resets the tally when the error changes", () => {
    const first = nextFailure(new Map(), "ts-1", "open: already exists");
    const changed = nextFailure(first.failures, "ts-1", "spawn: already runs an author");

    expect(changed.report).toBe("first");
    expect(changed.failures.get("ts-1")).toEqual({
      detail: "spawn: already runs an author",
      count: 1,
    });
  });

  test("failedTasks names only tasks that failed twice with the same error", () => {
    const once = nextFailure(new Map(), "ts-1", "open");
    const twice = nextFailure(once.failures, "ts-1", "open");
    const otherOnce = nextFailure(twice.failures, "ts-2", "spawn");

    expect(failedTasks(otherOnce.failures).map(([task]) => task)).toEqual(["ts-1"]);
  });
});

describe("work handed back for review", () => {
  test("sends a reviewer only at a branch that holds commits", () => {
    const written = active(task("ts-111111", ["by:opencode"]), undefined);
    const empty = active(task("ts-222222", ["by:opencode"]), undefined);
    const { review, unbacked } = reviewable([written, empty], new Set(["ts-111111"]));

    expect(review.map(({ task }) => task.id)).toEqual(["ts-111111"]);
    expect(unbacked.map(({ task }) => task.id)).toEqual(["ts-222222"]);
  });

  test("reviews an empty branch whose author claims the trunk already satisfies it", () => {
    // The one ending that closes a task the backlog outlived. Read as
    // unfinished, it returns to the queue and buys the same discovery again a
    // rung up, forever.
    const claimed = active(task("ts-444444", ["by:opencode", "satisfied"]), undefined);
    const { review, unbacked } = reviewable([claimed], new Set());

    expect(review.map(({ task }) => task.id)).toEqual(["ts-444444"]);
    expect(unbacked).toEqual([]);
  });

  test("reviews an empty branch whose task's deliverable is a research report", () => {
    // A research task's product is in its log, so its branch is legitimately
    // empty; read as unbacked it would be returned for having no commits.
    const report = active(task("ts-555555", ["by:opencode", "research"]), undefined);
    const { review, unbacked } = reviewable([report], new Set());

    expect(review.map(({ task }) => task.id)).toEqual(["ts-555555"]);
    expect(unbacked).toEqual([]);
  });

  test("leaves work foreman did not author alone, committed or not", () => {
    // `reviewing` is a status anyone can set by hand. Without a by-* label the
    // branch is not foreman's to review, land or return to its queue.
    const theirs = active(task("ts-333333", []), undefined);
    const { review, unbacked } = reviewable([theirs], new Set(["ts-333333"]));

    expect(review).toEqual([]);
    expect(unbacked).toEqual([]);
  });
});

const dispatchesFor = (...args: Parameters<typeof plan>) => plan(...args).dispatches;

describe("the policy gate on dispatch", () => {
  const ready = (id: string, labels: ReadonlyArray<string> = []) => ({
    id,
    title: `Task ${id}`,
    priority: 1,
    project: "foreman",
    labels,
  });

  const allowing = (
    steps: Partial<Policy["default"]>,
    overrides: Partial<Policy> = {},
  ): Policy => ({
    ...DEFAULT_POLICY,
    slots: 3,
    default: { ...DEFAULT_POLICY.default, ...steps },
    ...overrides,
  });

  const dispatchState = (policy: Policy, overrides: Record<string, unknown> = {}) => ({
    workers: [],
    queue: [],
    held: [],
    review: [],
    outOfQuota: new Set<string>(),
    policy,
    scopes: new Map<string, ReadonlySet<string>>(),
    ...overrides,
  });

  const planned = (dispatches: ReturnType<typeof dispatchesFor>) =>
    dispatches.map(({ role, task }) => `${role}:${task.id}`);

  test("a paused policy starts nothing, with every slot free", () => {
    const policy = allowing({ author: "on", review: "on" }, { paused: true });
    const dispatches = dispatchesFor(
      dispatchState(policy, {
        queue: [ready("ts-a")],
        review: [active(task("ts-r", ["by:cheap"]), undefined)],
      }),
    );

    expect(dispatches).toEqual([]);
  });

  test("with authoring off, reviews still drain the pipeline", () => {
    const dispatches = dispatchesFor(
      dispatchState(allowing({ review: "on" }), {
        queue: [ready("ts-a")],
        review: [active(task("ts-r", ["by:cheap"]), undefined)],
      }),
    );

    expect(planned(dispatches)).toEqual(["review:ts-r"]);
  });

  test("a task an attempt already failed needs climb, not author", () => {
    const dispatches = dispatchesFor(
      dispatchState(allowing({ author: "on" }), {
        queue: [ready("ts-retry", ["failed-by:cheap"]), ready("ts-fresh")],
      }),
    );

    expect(planned(dispatches)).toEqual(["author:ts-fresh"]);
  });

  test("the policy's slots bound the pass", () => {
    const dispatches = dispatchesFor(
      dispatchState(allowing({ author: "on" }, { slots: 2 }), {
        queue: [ready("ts-a"), ready("ts-b"), ready("ts-c")],
      }),
    );

    expect(planned(dispatches)).toEqual(["author:ts-a", "author:ts-b"]);
  });

  test("an epic grant admits its tasks and no others, up to its count in one pass", () => {
    const policy = allowing(
      {},
      { grants: [{ scope: "ep-1", steps: ["author"], remaining: 1, admitted: [] }] },
    );
    const dispatches = dispatchesFor(
      dispatchState(policy, {
        queue: [ready("ts-outside"), ready("ts-a"), ready("ts-b")],
        scopes: new Map([["ep-1", new Set(["ts-a", "ts-b"])]]),
      }),
    );

    expect(planned(dispatches)).toEqual(["author:ts-a"]);
    expect(dispatches[0]?.permit).toEqual({ _tag: "Granted", scope: "ep-1", admits: true });
  });

  test("a review step set to ask is listed with the author's rung, and not dispatched", () => {
    const { dispatches, asks } = plan(
      dispatchState(allowing({ review: "ask" }), {
        review: [active(task("ts-r", ["by:cheap"]), undefined)],
      }),
    );

    expect(dispatches).toEqual([]);
    expect(asks.map(({ task, step, rung }) => [task.id, step, rung])).toEqual([
      ["ts-r", "review", "cheap"],
    ]);
  });

  test("an author ask lists at most the policy's slots", () => {
    const { dispatches, asks } = plan(
      dispatchState(allowing({ author: "ask" }, { slots: 2 }), {
        queue: [ready("ts-a"), ready("ts-b"), ready("ts-c")],
      }),
    );

    expect(dispatches).toEqual([]);
    expect(asks.map(({ task }) => task.id)).toEqual(["ts-a", "ts-b"]);
  });

  test("author asks are bounded by slots, not by the free count", () => {
    const { asks } = plan(
      dispatchState(allowing({ author: "ask" }, { slots: 2 }), {
        workers: [worker("working", "ts-w1"), worker("working", "ts-w2")],
        queue: [ready("ts-a"), ready("ts-b"), ready("ts-c")],
      }),
    );

    expect(asks.map(({ task }) => task.id)).toEqual(["ts-a", "ts-b"]);
  });

  test("with every slot full, a review ask and a climb ask are still listed", () => {
    const { dispatches, asks } = plan(
      dispatchState(allowing({ review: "ask", climb: "ask" }, { slots: 1 }), {
        workers: [worker("working", "ts-w1")],
        queue: [ready("ts-c", ["attempt:cheap:1"])],
        review: [active(task("ts-r", ["by:cheap"]), undefined)],
      }),
    );

    expect(dispatches).toEqual([]);
    expect(asks.map(({ task, step }) => `${step}:${task.id}`)).toEqual([
      "review:ts-r",
      "climb:ts-c",
    ]);
  });

  test("asks ahead in the queue hold no slot from a granted task behind them", () => {
    const { dispatches, asks } = plan(
      dispatchState(
        allowing(
          { review: "ask", climb: "ask", author: "off" },
          {
            slots: 1,
            grants: [{ scope: "ts-g", steps: ["climb"], remaining: 1, admitted: [] }],
          },
        ),
        {
          queue: [
            ready("ts-c1", ["attempt:cheap:1"]),
            ready("ts-c2", ["attempt:cheap:1"]),
            ready("ts-g", ["attempt:cheap:1"]),
          ],
          review: [active(task("ts-r", ["by:cheap"]), undefined)],
          scopes: new Map([["ts-g", new Set(["ts-g"])]]),
        },
      ),
    );

    expect(planned(dispatches)).toEqual(["author:ts-g"]);
    expect(asks.map(({ task }) => task.id)).toEqual(["ts-r", "ts-c1", "ts-c2"]);
  });
});

describe("scoping the roster to this daemon's checkouts", () => {
  const CHECKOUTS = new Set(["/home/dan/build/foreman"]);
  const inRepo = (id: string, repository: string | undefined): Worker => ({
    ...worker("working", id),
    repository,
  });

  test("keeps only workspaces whose worktree is in a managed checkout", () => {
    const own = inRepo("ts-111111", "/home/dan/build/foreman");
    const foreign = inRepo("ts-222222", "/home/dan/build/elsewhere");

    expect(ours([own, foreign], CHECKOUTS)).toEqual([own]);
  });

  test("a foreign daemon's live workspace fills none of this daemon's slots", () => {
    // Two foremen against different configs are not competing for the same
    // slots, so a foreign workspace must not appear in the roster slots are
    // counted from — at --slots 1 it fills the only one and nothing dispatches.
    expect(ours([inRepo("ts-222222", "/home/dan/build/elsewhere")], CHECKOUTS)).toEqual([]);
  });

  test("a workspace with no worktree belongs to nobody", () => {
    // Foreman never opens one, so a workspace in its label namespace without a
    // worktree was made by hand and has no checkout to be scoped by.
    expect(ours([inRepo("ts-333333", undefined)], CHECKOUTS)).toEqual([]);
  });

  test("scopes before the store is asked, so a deleted task is still classifiable", () => {
    // The task's project would answer this too, right up until the task is
    // deleted — which is exactly when a workspace needs to be told from residue.
    const own = inRepo("ts-444444", "/home/dan/build/foreman");
    expect(ours([own], CHECKOUTS)).toEqual([own]);
    expect(scopeRoster([own], new Map()).workers).toEqual([]);
  });
});

describe("joining the scoped roster to the store", () => {
  test("drops a workspace whose task the store no longer has", () => {
    // It has no status to settle and no claim to release, and as residue it
    // must not eat a slot nothing will ever free. observe surfaces it as an
    // orphan instead.
    const { owned, workers } = scopeRoster([worker("blocked", "ts-333333")], new Map());

    expect(owned).toEqual([]);
    expect(workers).toEqual([]);
  });

  test("joins each kept workspace to its task with the role's state", () => {
    const reviewing = task("ts-444444", ["by:opencode", "review-by:claude"], "reviewing");

    const { owned } = scopeRoster(
      [worker("working", reviewing.id)],
      new Map([[reviewing.id, reviewing]]),
    );

    expect(owned).toEqual([
      { task: reviewing, worker: worker("working", reviewing.id), kind: "claude" },
    ]);
  });
});

describe("unread branches", () => {
  const branch = (merged: boolean, status: string | undefined) => ({ merged, status });

  test("names only the branches that have fallen out of every mechanism", () => {
    // Finished, and yet the commits never reached the checkout: the landing
    // stopped part way, and nothing reaches a done task to finish it.
    expect(isUnread(branch(false, "done"))).toBe(true);
    // Somebody decided this work should not happen, and the commits outlived
    // the decision. Shown, but never recovered automatically.
    expect(isUnread(branch(false, "canceled"))).toBe(true);
    // The task was deleted outright, which is why git is asked and not prog.
    expect(isUnread(branch(false, undefined))).toBe(true);
  });

  test("leaves alone every branch something still reaches", () => {
    // Back in the queue. Not abandoned — next in line, and the queue already
    // works oldest first. Dispatching a reviewer here reads a half-written
    // diff and takes the verdict on it.
    expect(isUnread(branch(false, "open"))).toBe(false);
    // A claim: worked, or vanished and therefore already a decision, and
    // reclaimed back to the queue once it goes stale.
    expect(isUnread(branch(false, "in_progress"))).toBe(false);
    expect(isUnread(branch(false, "reviewing"))).toBe(false);
    // Merged, so the commits are in and the sweep takes the ref. An untouched
    // branch is merged by definition, so nothing empty reaches the column.
    expect(isUnread(branch(true, "done"))).toBe(false);
  });
});

describe("recovering an unread branch", () => {
  const row = (task: string, status: string | undefined, activity: Date | undefined) => ({
    project: "amux",
    branch: `foreman/${task}`,
    task,
    title: `Task ${task}`,
    status,
    activity,
  });

  test("recovers finished work whose landing never completed, and nothing else", () => {
    // Done says somebody meant to keep this, and unmerged commits behind it
    // mean a landing that stopped part way — foreman's own doing, so foreman
    // corrects it without asking.
    expect(recoverable(row("ts-1", "done", new Date()))).toBe(true);
    // A cancellation is a decision a person made. Reviewing it automatically
    // spends a rung relitigating that decision.
    expect(recoverable(row("ts-2", "canceled", new Date()))).toBe(false);
    // No id left to dispatch against.
    expect(recoverable(row("ts-3", undefined, undefined))).toBe(false);
  });

  test("orders by how long the work has waited, unreachable first", () => {
    const rows = [
      row("ts-new", "done", new Date("2026-08-16T00:00:00Z")),
      row("ts-old", "done", new Date("2026-08-10T00:00:00Z")),
      row("ts-gone", undefined, undefined),
    ].sort((first, second) => waiting(first) - waiting(second));

    // A branch whose task is gone has no activity to read and leads: it is the
    // one nothing recovers on its own, so it must not sit under the rows
    // foreman is already working off.
    expect(rows.map((entry) => entry.task)).toEqual(["ts-gone", "ts-old", "ts-new"]);
    // One per tick, oldest first: submitting this one is what makes the next
    // tick find a different oldest.
    expect(rows.find(recoverable)?.task).toBe("ts-old");
  });
});

describe("the quota gate", () => {
  const ready = (id: string, project = "foreman") => ({
    id,
    title: `Task ${id}`,
    priority: 1,
    project,
    labels: [],
  });

  const state = (overrides: Record<string, unknown> = {}) => ({
    workers: [],
    queue: [],
    held: [],
    review: [],
    outOfQuota: new Set<string>(),
    policy: {
      ...DEFAULT_POLICY,
      slots: 3,
      default: { author: "on", climb: "on", review: "on", land: "on" } as const,
    },
    scopes: new Map<string, ReadonlySet<string>>(),
    ...overrides,
  });

  test("passes over a queued task whose rung has no allowance left", () => {
    const dispatches = dispatchesFor(
      state({ queue: [ready("ts-walled"), ready("ts-open")], outOfQuota: new Set(["ts-walled"]) }),
    );

    expect(dispatches.map((dispatch) => dispatch.task.id)).toEqual(["ts-open"]);
  });

  test("passes over a review whose reviewer's rung has no allowance left", () => {
    // The reviewer's rung is the one above the author's, so a review can be
    // stopped by an account the author never touched.
    const dispatches = dispatchesFor(
      state({
        review: [active(task("ts-walled", ["by:cheap"]), undefined)],
        outOfQuota: new Set(["ts-walled"]),
      }),
    );

    expect(dispatches).toEqual([]);
  });

  test("leaves the task in the queue rather than counting an attempt", () => {
    // The whole point of the gate: an account with nothing left says nothing
    // about the work or the model, so the task must stay exactly where it was
    // and climb nothing. A pass-over is the only thing that happens.
    const walled = ready("ts-walled");
    const current = state({ queue: [walled], outOfQuota: new Set([walled.id]) });

    expect(dispatchesFor(current)).toEqual([]);
    expect(current.queue).toHaveLength(1);
  });
});

describe("the landed column", () => {
  const at = (item: Item, when: Date): Item => ({ ...item, last_activity_at: when });
  const now = DateTime.fromDateUnsafe(new Date("2026-08-21T12:00:00Z"));

  test("orders by when each task landed, newest first", () => {
    // prog returns done tasks grouped by project in config order; the column
    // is history, so it reads in landing order instead.
    const landed = [
      at(task("ts-old", [], "done", 1, "other"), new Date("2026-08-19T09:00:00Z")),
      at(task("ts-new", [], "done"), new Date("2026-08-21T11:00:00Z")),
      at(task("ts-mid", [], "done", 1, "other"), new Date("2026-08-20T18:00:00Z")),
    ];

    expect(landedColumn(landed, now, 7).map((item) => item.id)).toEqual([
      "ts-new",
      "ts-mid",
      "ts-old",
    ]);
  });

  test("keeps only what landed inside the window", () => {
    const landed = [
      at(task("ts-stale", [], "done"), new Date("2026-08-13T00:00:00Z")),
      at(task("ts-fresh", [], "done"), new Date("2026-08-21T11:00:00Z")),
    ];

    expect(landedColumn(landed, now, 7).map((item) => item.id)).toEqual(["ts-fresh"]);
  });
});
