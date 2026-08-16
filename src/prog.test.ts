import { describe, expect, test } from "bun:test";
import {
  agentLog,
  attemptsOf,
  authoredBy,
  isApproved,
  isPlan,
  reviewedBy,
  type Item,
} from "./prog.ts";

const item = (labels: ReadonlyArray<string>): Item => ({
  id: "ts-123456",
  title: "Test task",
  status: "reviewing",
  project: "foreman",
  type: "task",
  priority: 1,
  labels,
  description: null,
  last_activity_at: new Date(),
});

describe("task attribution", () => {
  test("keeps author and current reviewer distinct", () => {
    const task = item(["by-opencode", "review-by-claude", "approved"]);

    expect(authoredBy(task)).toBe("opencode");
    expect(reviewedBy(task)).toBe("claude");
    expect(isApproved(task)).toBe(true);
  });

  test("names the rung and the model the agent reported", () => {
    const rung = { name: "sol", harness: "opencode", model: "opencode/gpt-5.6-sol" };
    expect(agentLog("author", rung, { kind: "opencode", model: "openai/gpt-5.6-sol" })).toBe(
      "foreman: author assigned to sol (openai/gpt-5.6-sol)",
    );
  });

  test("falls back to the model foreman asked for when none is reported", () => {
    const rung = { name: "sonnet", harness: "opencode", model: "opencode/claude-sonnet-5" };
    expect(agentLog("review", rung, { kind: "opencode", model: undefined })).toBe(
      "foreman: review assigned to sonnet (opencode/claude-sonnet-5)",
    );
  });

  test("names the harness for a rung that lets the harness choose", () => {
    const rung = { name: "claude", harness: "claude", model: undefined };
    expect(agentLog("author", rung, { kind: "claude", model: undefined })).toBe(
      "foreman: author assigned to claude (claude)",
    );
  });
});

describe("plan label", () => {
  test("recognises a plan epic", () => {
    expect(isPlan(item(["plan"]))).toBe(true);
    expect(isPlan(item(["onboard"]))).toBe(false);
  });
});

describe("unfinished attempts on a rung", () => {
  test("reads zero for a rung that was never tried", () => {
    expect(attemptsOf(item([]), "deepseek")).toBe(0);
    expect(attemptsOf(item(["by-opencode"]), "deepseek")).toBe(0);
  });

  test("reads the count recorded for the named rung", () => {
    expect(attemptsOf(item(["attempt-deepseek-1"]), "deepseek")).toBe(1);
    expect(attemptsOf(item(["attempt-deepseek-2"]), "deepseek")).toBe(2);
  });

  test("ignores a count a rung the task left recorded", () => {
    // The count follows its rung, so a task pinned elsewhere starts fresh and
    // a climb-away clears nothing it might meet again.
    expect(attemptsOf(item(["attempt-deepseek-2"]), "sol")).toBe(0);
    expect(attemptsOf(item(["attempt-deepseek-2", "attempt-sol-1"]), "sol")).toBe(1);
  });

  test("reads the newest count when more than one was written", () => {
    expect(attemptsOf(item(["attempt-deepseek-1", "attempt-deepseek-3"]), "deepseek")).toBe(3);
  });

  test("keeps two rungs whose names share a prefix apart", () => {
    expect(attemptsOf(item(["attempt-deepseek-flash-2"]), "deepseek")).toBe(0);
    expect(attemptsOf(item(["attempt-deepseek-flash-2"]), "deepseek-flash")).toBe(2);
  });

  test("ignores a count that is not a plain number", () => {
    expect(attemptsOf(item(["attempt-deepseek-x"]), "deepseek")).toBe(0);
    expect(attemptsOf(item(["attempt-deepseek-2.5"]), "deepseek")).toBe(0);
  });
});
