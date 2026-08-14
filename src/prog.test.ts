import { describe, expect, test } from "bun:test";
import { authoredBy, reviewedBy, type Item } from "./prog.ts";

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
});
