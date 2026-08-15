import { describe, expect, test } from "bun:test";
import {
  above,
  authorFor,
  below,
  HUMAN,
  isYours,
  type Ladder,
  reviewerFor,
  topOf,
} from "./ladder.ts";

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

describe("below", () => {
  test("lowers one rung at a time", () => {
    expect(below(ladder, "middle")).toBe("cheap");
    expect(below(ladder, "top")).toBe("middle");
  });

  test("has nothing below the bottom rung", () => {
    // The ladder reads no label as the bottom, so a task lowered off the
    // bottom rung loses its label and starts fresh rather than carrying a
    // redundant rung-<bottom>.
    expect(below(ladder, undefined)).toBeUndefined();
    expect(below(ladder, "cheap")).toBeUndefined();
  });

  test("brings a task back down from the operator to the top rung", () => {
    expect(below(ladder, HUMAN)).toBe("top");
  });

  test("sends an unknown rung to the top, matching above", () => {
    // A config that no longer has the rung cannot say what sits under it, so
    // it is read like above reads it — as a claim the ladder cannot place.
    expect(below(ladder, "retired")).toBe("top");
  });
});

describe("below", () => {
  test("lowers one rung at a time", () => {
    expect(below(ladder, "middle")).toBe("cheap");
    expect(below(ladder, "top")).toBe("middle");
  });

  test("has nothing to write below the bottom rung", () => {
    // The ladder reads no label as the bottom, so descending off it removes
    // the label rather than pinning a redundant rung-<bottom>.
    expect(below(ladder, undefined)).toBeUndefined();
    expect(below(ladder, "cheap")).toBeUndefined();
  });

  test("brings a task back down from the operator", () => {
    // A person was never a model, so the first step down from HUMAN is the
    // strongest model, not a jump to the bottom.
    expect(below(ladder, HUMAN)).toBe("top");
  });

  test("reads a rung the config no longer has as sitting above the top", () => {
    // Like above(): an unreadable claim cannot be positioned, so it is treated
    // as though it sits just above the top rung.
    expect(below(ladder, "retired")).toBe("top");
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
