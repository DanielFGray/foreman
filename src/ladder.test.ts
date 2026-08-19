import { describe, expect, test } from "bun:test";
import {
  above,
  authorFor,
  below,
  HUMAN,
  isYours,
  type Ladder,
  providerOf,
  providersOf,
  reviewerFor,
  rungSpent,
  rungsOn,
  topOf,
} from "./ladder.ts";

const ladder: Ladder = [
  { name: "cheap", harness: "opencode", model: "opencode/deepseek-v4-pro", provider: undefined },
  { name: "middle", harness: "opencode", model: "opencode/claude-sonnet-5", provider: undefined },
  { name: "top", harness: "claude", model: undefined, provider: undefined },
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

describe("rungSpent", () => {
  test("retries in place until the rung's attempts run out", () => {
    // A crash, a timeout and a usage wall say nothing about the model, so the
    // first attemptsPerRung - 1 failures stay on the rung.
    expect(rungSpent(1, 2)).toBe(false);
    expect(rungSpent(2, 3)).toBe(false);
  });

  test("climbs on the attempt that reaches the limit", () => {
    expect(rungSpent(2, 2)).toBe(true);
    expect(rungSpent(3, 3)).toBe(true);
    expect(rungSpent(4, 2)).toBe(true);
  });

  test("with attemptsPerRung 1, every failure climbs", () => {
    expect(rungSpent(1, 1)).toBe(true);
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
    const uniform: Ladder = [
      { name: "only", harness: "opencode", model: undefined, provider: undefined },
    ];
    expect(reviewerFor(uniform, "only").name).toBe("only");
    expect(topOf(uniform).name).toBe("only");
    expect(above(uniform, "only")).toBe(HUMAN);
  });
});

describe("providerOf", () => {
  test("reads the account off the model's provider prefix", () => {
    expect(providerOf(ladder[0])).toBe("opencode");
  });

  test("prefers what the config states over what the model implies", () => {
    // The two can legitimately disagree: a gateway serves another vendor's
    // model under its own account, and it is the account that has the quota.
    expect(
      providerOf({
        name: "gateway",
        harness: "opencode",
        model: "openrouter/gpt-5.6-luna",
        provider: "openrouter-work",
      }),
    ).toBe("openrouter-work");
  });

  test("names no account for a rung that is only a generic harness", () => {
    // `opencode` running whatever it defaults to could be signed in to
    // anything, so nothing here can say whose allowance it spends.
    expect(
      providerOf({ name: "top", harness: "opencode", model: undefined, provider: undefined }),
    ).toBeUndefined();
  });

  test("reads the claude account from the claude harness", () => {
    // The claude binary is always signed into the claude.ai account, however
    // it picks its model, so the harness names the account where the model
    // does not.
    expect(
      providerOf({ name: "top", harness: "claude", model: undefined, provider: undefined }),
    ).toBe("claude");
    expect(
      providerOf({ name: "sonnet", harness: "claude", model: "sonnet", provider: undefined }),
    ).toBe("claude");
  });

  test("names no account for a model with no provider on the front", () => {
    // A bare model id is the harness's own default provider, which the harness
    // never tells us. Reading it as a provider called "gpt-5" would ask a
    // question no probe can answer.
    expect(
      providerOf({ name: "bare", harness: "opencode", model: "gpt-5", provider: undefined }),
    ).toBeUndefined();
  });
});

describe("providersOf", () => {
  test("names each account once, however many rungs draw on it", () => {
    expect(providersOf(ladder)).toEqual(["opencode", "claude"]);
  });
});

describe("rungsOn", () => {
  test("names every rung a spent account stops", () => {
    // The point of the whole reading: one exhausted account takes out every
    // rung behind it, so climbing within it buys nothing.
    expect(rungsOn(ladder, "opencode")).toEqual(["cheap", "middle"]);
    expect(rungsOn(ladder, "claude")).toEqual(["top"]);
  });
});
