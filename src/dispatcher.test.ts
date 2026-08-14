import { describe, expect, test } from "bun:test";
import { awaitingLanding, readyToLand } from "./dispatcher.ts";
import type { Item } from "./prog.ts";
import type { Worker, WorkerState } from "./fleet.ts";

const task = (labels: ReadonlyArray<string>, status = "reviewing"): Item => ({
  id: "ts-123456",
  title: "Test task",
  status,
  project: "foreman",
  type: "task",
  priority: 1,
  labels,
  last_activity_at: new Date(),
});

const worker = (state: WorkerState): Worker => ({
  task: "ts-123456",
  workspace: "w1",
  pane: "w1:p1",
  directory: "/tmp/worktree",
  worktree: "/tmp/worktree",
  state,
  authorState: "settled",
  reviewState: state,
});

describe("landing a reviewed branch", () => {
  test("waits for a reviewer that is still finishing its turn", () => {
    const approved = task(["by-opencode", "review-by-claude", "approved"]);

    // The pane stays "working" from the moment the reviewer writes its verdict
    // until its whole turn ends. Landing inside that window closes the
    // workspace with `worktree remove --force` and deletes the directory the
    // reviewer is standing in.
    expect(readyToLand(approved, worker("working"))).toBe(false);
    expect(readyToLand(approved, worker("settled"))).toBe(true);
    expect(readyToLand(approved, undefined)).toBe(true);
  });

  test("keeps an approved task out of the ordinary settle path either way", () => {
    const approved = task(["by-opencode", "review-by-claude", "approved"]);

    // The two filters in settle must agree. A task excluded from landing
    // because its reviewer is live must not fall through to the branch that
    // treats it as a reviewer who stopped without a verdict.
    expect(readyToLand(approved, worker("working"))).toBe(false);
    expect(awaitingLanding(approved)).toBe(true);
  });

  test("ignores a task without a verdict, and one that already left review", () => {
    expect(awaitingLanding(task(["by-opencode", "review-by-claude"]))).toBe(false);
    expect(awaitingLanding(task(["by-opencode", "approved"], "in_progress"))).toBe(false);
  });
});
