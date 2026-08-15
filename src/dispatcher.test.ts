import { describe, expect, test } from "bun:test";
import {
  awaitingLanding,
  decisionsOf,
  readyToLand,
  reviewable,
  scopeRoster,
  type Owned,
} from "./dispatcher.ts";
import { authoredBy, reviewedBy, type Item } from "./prog.ts";
import type { Worker, WorkerState } from "./fleet.ts";

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

const owned = (id: string, status: string, labels: ReadonlyArray<string>): Owned => {
  const item = task(id, labels, status);
  return { task: item, worker: worker("gone", id), kind: reviewedBy(item) ?? authoredBy(item) };
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

  test("lands work small enough to skip the reviewer, with no verdict at all", () => {
    // The alternative is an author that merges for itself, which is the one
    // route past the clean-checkout and verification gate.
    expect(awaitingLanding(task("ts-123456", ["by-opencode", "trivial"]))).toBe(true);
    expect(awaitingLanding(task("ts-123456", ["by-opencode"], "reviewing", 3))).toBe(true);
    expect(awaitingLanding(task("ts-123456", ["by-opencode", "trivial"], "in_progress"))).toBe(
      false,
    );
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

  test("keeps claimed and reviewing workspaces out of the orphaned kind", () => {
    const ownedWorkspaces = [
      owned("ts-1", "in_progress", ["by-opencode"]),
      owned("ts-2", "reviewing", ["by-opencode", "review-by-claude"]),
    ];

    expect(decisionsOf([], [], ownedWorkspaces)).toEqual([]);
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
    // The stall that stalled the e2e rig: a second daemon at --slots 1 counted
    // the first daemon's live workspace as its own busy slot and dispatched
    // nothing. Two foremen against different configs are not competing for the
    // same slots, so the foreign workspace must not appear in the roster slots
    // are counted from.
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
