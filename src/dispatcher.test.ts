import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  awaitingLanding,
  excludeFailedTasks,
  failedTasks,
  handoffExpired,
  decisionsOf,
  isUnread,
  nextDispatch,
  nextFailure,
  recoverable,
  waiting,
  readyToLand,
  reviewable,
  scopeRoster,
  type Owned,
} from "./dispatcher.ts";
import { authoredBy, diagnosticIntent, reviewedBy, type Item } from "./prog.ts";
import type { AgentRole, Worker, WorkerState } from "./fleet.ts";

const task = (
  id: string,
  labels: ReadonlyArray<string>,
  status = "reviewing",
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
  last_activity_at: new Date(),
});

const worker = (state: WorkerState, id = "ts-123456"): Worker => ({
  task: id,
  workspace: "w1",
  pane: "w1:p1",
  directory: "/tmp/worktree",
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
  status: string,
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
    const approved = task("ts-123456", ["by-opencode", "review-by-claude", "approved"]);

    // The pane stays "working" from the moment the reviewer writes its verdict
    // until its whole turn ends. Landing inside that window closes the
    // workspace with `worktree remove --force` and deletes the directory the
    // reviewer is standing in.
    expect(readyToLand(approved, worker("working"))).toBe(false);
    expect(readyToLand(approved, worker("settled"))).toBe(true);
    expect(readyToLand(approved, undefined)).toBe(true);
  });

  test("keeps an approved task out of the ordinary settle path either way", () => {
    const approved = task("ts-123456", ["by-opencode", "review-by-claude", "approved"]);

    // The two filters in settle must agree. A task excluded from landing
    // because its reviewer is live must not fall through to the branch that
    // treats it as a reviewer who stopped without a verdict.
    expect(readyToLand(approved, worker("working"))).toBe(false);
    expect(awaitingLanding(approved)).toBe(true);
  });

  test("ignores a task without a verdict, and one that already left review", () => {
    expect(awaitingLanding(task("ts-123456", ["by-opencode", "review-by-claude"]))).toBe(false);
    expect(awaitingLanding(task("ts-123456", ["by-opencode", "approved"], "in_progress"))).toBe(
      false,
    );
  });

  test("lands nothing on size or priority alone", () => {
    // A branch reaches the operator's checkout on a reviewer's verdict and
    // nothing else, however small the task that produced it says it is.
    expect(awaitingLanding(task("ts-123456", ["by-opencode", "trivial"]))).toBe(false);
    expect(awaitingLanding(task("ts-123456", ["by-opencode"], "reviewing", 3))).toBe(false);
  });
});

describe("the author's pane after a handoff", () => {
  const at = (item: Item, when: Date): Item => ({ ...item, last_activity_at: when });
  const cutoff = DateTime.unsafeFromDate(new Date("2026-08-15T12:00:00Z"));

  test("keeps a fresh handoff alive for a reviewer to coach", () => {
    // The author's session is the only place its context exists, and a
    // mechanical finding sent back to it costs a fraction of the rung climb
    // that would otherwise re-derive all of it.
    const handed = at(task("ts-123456", ["by-opencode"]), new Date("2026-08-15T12:15:00Z"));

    expect(handoffExpired(handed, cutoff)).toBe(false);
  });

  test("closes one nobody reached inside the window", () => {
    // A second resident model per task in review is the cost, so a review
    // backlog must not accumulate one for every task waiting in it.
    const stranded = at(task("ts-123456", ["by-opencode"]), new Date("2026-08-15T11:15:00Z"));

    expect(handoffExpired(stranded, cutoff)).toBe(true);
  });
});

describe("diagnostic intervention", () => {
  test("derives its durable intent from the task label", () => {
    expect(diagnosticIntent(task("ts-1", ["by-opencode", "diagnosing-diagnose"]))).toBe("diagnose");
    expect(diagnosticIntent(task("ts-2", ["diagnosing-review"]))).toBe("review");
    expect(diagnosticIntent(task("ts-3", ["by-opencode"]))).toBeUndefined();
  });
});

describe("decisions", () => {
  test("surfaces an author or reviewer whose workspace is empty or gone", () => {
    const claimed = [active(task("ts-1", ["by-opencode"], "in_progress"), undefined)];
    const reviewing = [
      active(
        task("ts-2", ["by-opencode", "review-by-claude"], "reviewing"),
        worker("gone", "ts-2"),
      ),
    ];

    const decisions = decisionsOf(claimed, reviewing, []);
    expect(decisions.map((decision) => decision.task.id)).toEqual(["ts-1", "ts-2"]);
  });

  test("ignores a claimed or reviewing task that is still being worked", () => {
    const claimed = [
      active(task("ts-1", ["by-opencode"], "in_progress"), worker("working", "ts-1")),
    ];
    const reviewing = [
      active(
        task("ts-2", ["by-opencode", "review-by-claude"], "reviewing"),
        worker("working", "ts-2"),
      ),
    ];

    expect(decisionsOf(claimed, reviewing, [])).toEqual([]);
  });

  test("surfaces a workspace whose task is in any other status", () => {
    // A failed spawn leaves the by-* label on while the task returns to the
    // queue; the status is what makes it residue rather than a vanished author.
    const ownedWorkspaces = [
      owned("ts-3", "open", ["by-opencode"]),
      owned("ts-4", "done", []),
      owned("ts-5", "canceled", ["by-opencode"]),
    ];

    const decisions = decisionsOf([], [], ownedWorkspaces);
    expect(decisions.map((decision) => decision.task.id)).toEqual(["ts-3", "ts-4", "ts-5"]);
  });

  // A role proves the claim happened and was given up, because dispatch labels
  // the pane only when it spawns. Settle sweeps those itself; a workspace with
  // no role is the one case foreman cannot prove is spent.
  test("asks only about residue it cannot prove is spent", () => {
    const ownedWorkspaces = [
      owned("ts-3", "open", ["by-opencode"], ["author"]),
      owned("ts-4", "open", ["by-opencode", "review-by-claude"], ["author", "review"]),
      owned("ts-5", "open", ["by-opencode"]),
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
      task("ts-2", ["by-opencode", "review-by-claude", "approved"], "reviewing"),
      undefined,
    );
    const unfinished = active(
      task("ts-4", ["by-opencode", "review-by-claude"], "reviewing"),
      undefined,
    );

    const decisions = decisionsOf([], [approved, unfinished], []);
    expect(decisions.map((decision) => decision.task.id)).toEqual(["ts-4"]);
  });

  test("keeps claimed and reviewing workspaces out of the orphaned kind", () => {
    const ownedWorkspaces = [
      owned("ts-1", "in_progress", ["by-opencode"]),
      owned("ts-2", "reviewing", ["by-opencode", "review-by-claude"]),
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

  test("a twice-failed task is not ordinary queue work", () => {
    const first = nextFailure(new Map(), "ts-1", "open");
    const twice = nextFailure(first.failures, "ts-1", "open");
    const queued = [task("ts-1", [], "open"), task("ts-2", [], "open")];

    expect(excludeFailedTasks(queued, failedTasks(twice.failures)).map(({ id }) => id)).toEqual([
      "ts-2",
    ]);
  });
});

describe("work handed back for review", () => {
  test("sends a reviewer only at a branch that holds commits", () => {
    const written = active(task("ts-111111", ["by-opencode"]), undefined);
    const empty = active(task("ts-222222", ["by-opencode"]), undefined);
    const { review, unbacked } = reviewable([written, empty], new Set(["ts-111111"]));

    expect(review.map(({ task }) => task.id)).toEqual(["ts-111111"]);
    expect(unbacked.map(({ task }) => task.id)).toEqual(["ts-222222"]);
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

describe("scoping the roster to this daemon's projects", () => {
  test("keeps only workspaces whose task lives in a managed project", () => {
    const own = task("ts-111111", ["by-opencode"], "in_progress");
    const foreign = task("ts-222222", ["by-opencode"], "in_progress", 1, "elsewhere");

    const { owned, workers } = scopeRoster(
      [worker("working", own.id), worker("working", foreign.id)],
      new Map([
        [own.id, own],
        [foreign.id, foreign],
      ]),
      new Set(["foreman"]),
    );

    expect(workers.map(({ task }) => task)).toEqual([own.id]);
    expect(owned.map(({ task }) => task.id)).toEqual([own.id]);
  });

  test("a foreign daemon's live workspace fills none of this daemon's slots", () => {
    // Two foremen against different configs are not competing for the same
    // slots, so a foreign workspace must not appear in the roster slots are
    // counted from — at --slots 1 it fills the only one and nothing dispatches.
    const foreign = task("ts-222222", ["by-opencode"], "in_progress", 1, "elsewhere");

    const { owned, workers } = scopeRoster(
      [worker("working", foreign.id)],
      new Map([[foreign.id, foreign]]),
      new Set(["foreman"]),
    );

    expect(workers).toEqual([]);
    expect(owned).toEqual([]);
  });

  test("drops a workspace whose task the store no longer has", () => {
    // A workspace with no task has no project to scope by, and as residue it
    // must not eat a slot nothing will ever free.
    const { owned, workers } = scopeRoster(
      [worker("blocked", "ts-333333")],
      new Map(),
      new Set(["foreman"]),
    );

    expect(owned).toEqual([]);
    expect(workers).toEqual([]);
  });

  test("joins each kept workspace to its task with the role's state", () => {
    const reviewing = task("ts-444444", ["by-opencode", "review-by-claude"], "reviewing");

    const { owned } = scopeRoster(
      [worker("working", reviewing.id)],
      new Map([[reviewing.id, reviewing]]),
      new Set(["foreman"]),
    );

    expect(owned).toEqual([
      { task: reviewing, worker: worker("working", reviewing.id), kind: "claude" },
    ]);
  });

  test("ignores plan workspaces before and during their stages", () => {
    const openingEpic = task("ep-444444", ["plan"], "draft");
    const epic = task("ep-555555", ["plan"], "draft");
    const taskerEpic = task("ep-666666", ["plan"], "open");
    const opening = {
      ...worker("gone", openingEpic.id),
      roles: new Map(),
    };
    const planner = {
      ...worker("working", epic.id),
      roles: new Map([["planner", "working"] as const]),
    };
    const tasker = {
      ...worker("working", taskerEpic.id),
      roles: new Map([["tasker", "working"] as const]),
    };

    const { owned, workers } = scopeRoster(
      [opening, planner, tasker],
      new Map([
        [openingEpic.id, openingEpic],
        [epic.id, epic],
        [taskerEpic.id, taskerEpic],
      ]),
      new Set(["foreman"]),
    );

    expect(workers).toEqual([]);
    expect(owned).toEqual([]);
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

describe("the operator's dispatch intention", () => {
  test("cycles from widest to narrowest and back", () => {
    expect(nextDispatch("running")).toBe("draining");
    expect(nextDispatch("draining")).toBe("paused");
    expect(nextDispatch("paused")).toBe("running");
  });
});
