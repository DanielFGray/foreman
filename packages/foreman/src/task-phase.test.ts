import { describe, expect, test } from "bun:test";
import { phaseOf, type TaskPhaseInput } from "./task-phase.ts";

const input = (overrides: Partial<TaskPhaseInput> = {}): TaskPhaseInput => ({
  status: "in_progress",
  reviewer: undefined,
  worker: "settled" as const,
  attached: false,
  committed: false,
  holdsWork: false,
  handoffExpired: false,
  underReview: false,
  ...overrides,
});

describe("task phases", () => {
  test("prioritizes completion and review return", () => {
    expect(phaseOf(input({ status: "done" }))).toBe("Landed");
    expect(phaseOf(input({ status: "canceled" }))).toBe("Canceled");
    expect(phaseOf(input({ status: "open", reviewer: "claude" }))).toBe("ReviewReturned");
  });

  test("distinguishes vanished work from an empty worktree", () => {
    expect(phaseOf(input({ worker: "gone", committed: true }))).toBe("VanishedWithWork");
    expect(phaseOf(input({ worker: "gone" }))).toBe("VanishedEmpty");
    expect(phaseOf(input({ worker: "gone", attached: true }))).toBe("VanishedAttached");
  });

  test("keeps blocked and waiting work untouched", () => {
    expect(phaseOf(input({ worker: "blocked" }))).toBe("Blocked");
    expect(phaseOf(input({ underReview: true }))).toBe("ReviewWaiting");
    expect(phaseOf(input({ underReview: true, handoffExpired: true }))).toBe("ReviewExpired");
  });

  test("distinguishes stopped review, residue, and a stopped author", () => {
    expect(phaseOf(input({ underReview: true, reviewer: "claude" }))).toBe("ReviewStopped");
    expect(phaseOf(input({ status: "open" }))).toBe("Residue");
    expect(phaseOf(input())).toBe("AuthorStopped");
  });
});
