import { describe, expect, test } from "bun:test";
import { above, authorFor, HUMAN, isYours, type Ladder, reviewerFor, topOf } from "./ladder.ts";

const ladder: Ladder = [
  { name: "cheap", harness: "opencode", model: "opencode/deepseek-v4-pro" },
  { name: "middle", harness: "opencode", model: "opencode/claude-sonnet-5" },
  { name: "top", harness: "claude", model: undefined },
];

describe("authorFor", () => {
  test("starts an unmarked task at the bottom", () => {
    expect(authorFor(ladder, undefined)?.name).toBe("cheap");
  });

  test("sends a marked task to the rung it names", () => {
    expect(authorFor(ladder, "middle")?.model).toBe("opencode/claude-sonnet-5");
  });

  test("gives a task at an unknown rung to the operator", () => {
    // The config no longer has the rung this task earned. Guessing at what it
    // meant would silently downgrade work that had already climbed.
    expect(authorFor(ladder, "retired")).toBeUndefined();
    expect(authorFor(ladder, HUMAN)).toBeUndefined();
    expect(isYours(ladder, "retired")).toBe(true);
    expect(isYours(ladder, undefined)).toBe(false);
  });
});

describe("above", () => {
  test("climbs one rung at a time", () => {
    expect(above(ladder, undefined)).toBe("middle");
    expect(above(ladder, "cheap")).toBe("middle");
    expect(above(ladder, "middle")).toBe("top");
  });

  test("stops at the operator rather than cycling", () => {
    expect(above(ladder, "top")).toBe(HUMAN);
    expect(above(ladder, HUMAN)).toBe(HUMAN);
  });
});

describe("reviewerFor", () => {
  test("reads a rung's work with the rung above it", () => {
    expect(reviewerFor(ladder, "cheap").name).toBe("middle");
    expect(reviewerFor(ladder, "middle").name).toBe("top");
  });

  test("has the top rung review itself rather than dispatching a person", () => {
    // Review stays between agents: a person intervenes by taking the pane over.
    expect(reviewerFor(ladder, "top").name).toBe("top");
  });

  test("gives unattributed work to the top, since nothing says it is easy", () => {
    expect(reviewerFor(ladder, undefined).name).toBe("top");
  });

  test("reviews with the top of a one-rung ladder", () => {
    const uniform: Ladder = [{ name: "only", harness: "opencode", model: undefined }];
    expect(reviewerFor(uniform, "only").name).toBe("only");
    expect(topOf(uniform).name).toBe("only");
    expect(above(uniform, "only")).toBe(HUMAN);
  });
});
