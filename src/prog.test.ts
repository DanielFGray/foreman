import { describe, expect, test } from "bun:test";
import { agentLog, authoredBy, isPlan, reviewedBy, type Item } from "./prog.ts";

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
    const task = item(["by-opencode", "review-by-claude"]);

    expect(authoredBy(task)).toBe("opencode");
    expect(reviewedBy(task)).toBe("claude");
  });

  test("records the role, kind, and reported model", () => {
    expect(agentLog("author", { kind: "opencode", model: "openai/gpt-5.6-sol" })).toBe(
      "foreman: author assigned to opencode (openai/gpt-5.6-sol)",
    );
  });

  test("omits a model the agent did not report", () => {
    expect(agentLog("review", { kind: "claude", model: undefined })).toBe(
      "foreman: review assigned to claude",
    );
  });
});

describe("plan label", () => {
  test("recognises a plan epic", () => {
    expect(isPlan(item(["plan"]))).toBe(true);
    expect(isPlan(item(["onboard"]))).toBe(false);
  });
});
