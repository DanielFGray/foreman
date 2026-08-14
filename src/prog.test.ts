import { describe, expect, test } from "bun:test";
import { agentLog, authoredBy, isApproved, isFocused, isPlan, reviewedBy, type Item } from "./prog.ts";

const item = (labels: ReadonlyArray<string>): Item => ({
  id: "ts-123456",
  title: "Test task",
  status: "reviewing",
  project: "foreman",
  type: "task",
  priority: 1,
  labels,
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

describe("focus label", () => {
  test("recognises a focused item", () => {
    expect(isFocused(item(["focus"]))).toBe(true);
    expect(isFocused(item(["plan"]))).toBe(false);
  });
});
