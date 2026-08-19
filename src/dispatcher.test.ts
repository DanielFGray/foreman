import { describe, expect, test } from "bun:test";
import {
  awaitingLanding,
  decisionsOf,
  dispatchesFor,
  readyToLand,
  reviewable,
  type Owned,
} from "./dispatcher.ts";
import { authoredBy, reviewedBy, type Item } from "./prog.ts";
import type { Worker, WorkerState } from "./fleet.ts";

const task = (
  id: string,
  labels: ReadonlyArray<string>,
  status = "reviewing",
  priority = 1,
): Item => ({
  id,
  title: `Task ${id}`,
  status,
  project: "foreman",
  type: "task",
  priority,
  labels,
  last_activity_at: new Date(),
});

const worker = (state: WorkerState, id = "ts-123456"): Worker => ({
  task: id,
  workspace: "w1",
  pane: "w1:p1",
  directory: "/tmp/worktree",
  worktree: "/tmp/worktree",
  state,
  authorState: "settled",
  reviewState: state,
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

describe("focused dispatch", () => {
  const ready = (id: string, project = "foreman") => ({
    id,
    title: `Task ${id}`,
    priority: 1,
    project,
    labels: [],
  });

  const dispatchState = (overrides: Record<string, unknown> = {}) => ({
    workers: [],
    queue: [],
    focus: [],
    focused: true,
    focusScope: new Set<string>(),
    touched: new Set(["foreman"]),
    held: [],
    working: [],
    review: [],
    ...overrides,
  });

  test("reserves the only slot for the focused author ahead of a spillover review", () => {
    const focused = ready("ts-focus");
    const spilloverReview = active(task("ts-review", ["by-cheap"]), undefined);

    const dispatches = dispatchesFor(
      dispatchState({
        queue: [ready("ts-spill")],
        focus: [focused],
        focusScope: new Set([focused.id]),
        review: [spilloverReview],
      }),
      1,
    );

    expect(dispatches.map(({ role, task }) => `${role}:${task.id}`)).toEqual(["author:ts-focus"]);
  });

  test("uses only the remaining slot for spillover", () => {
    const focused = ready("ts-focus");
    const spilloverReview = active(task("ts-review", ["by-cheap"]), undefined);

    const dispatches = dispatchesFor(
      dispatchState({
        queue: [ready("ts-spill")],
        focus: [focused],
        focusScope: new Set([focused.id]),
        review: [spilloverReview],
      }),
      2,
    );

    expect(dispatches.map(({ role, task }) => `${role}:${task.id}`)).toEqual([
      "review:ts-review",
      "author:ts-focus",
    ]);
  });

  test("reserves the only slot for the focused reviewer", () => {
    const focusedReview = active(task("ts-focus", ["by-cheap"]), undefined);
    const spilloverReview = active(task("ts-review", ["by-cheap"]), undefined);

    const dispatches = dispatchesFor(
      dispatchState({
        focusScope: new Set([focusedReview.task.id]),
        review: [spilloverReview, focusedReview],
      }),
      1,
    );

    expect(dispatches.map(({ role, task }) => `${role}:${task.id}`)).toEqual(["review:ts-focus"]);
  });

  test("does not start a second focused task when several are already in flight", () => {
    const writing = active(
      task("ts-writing", ["by-cheap"], "in_progress"),
      worker("working", "ts-writing"),
    );
    const awaitingReview = active(task("ts-review", ["by-cheap"]), undefined);

    const dispatches = dispatchesFor(
      dispatchState({
        focusScope: new Set([writing.task.id, awaitingReview.task.id]),
        workers: [writing.worker],
        working: [writing],
        review: [awaitingReview],
      }),
      2,
    );

    expect(dispatches).toEqual([]);
  });

  test("drains one review when several focused tasks are awaiting review", () => {
    const first = active(task("ts-first", ["by-cheap"]), undefined);
    const second = active(task("ts-second", ["by-cheap"]), undefined);

    const dispatches = dispatchesFor(
      dispatchState({
        focusScope: new Set([first.task.id, second.task.id]),
        review: [first, second],
      }),
      2,
    );

    expect(dispatches.map(({ role, task }) => `${role}:${task.id}`)).toEqual(["review:ts-first"]);
  });
});
