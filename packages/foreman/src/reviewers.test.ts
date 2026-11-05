import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { type Ladder, providersOf } from "./ladder.ts";
import { drawnBy, type Reviewer, reviewerFor, seatOf } from "./reviewers.ts";

const reviewer = (name: string, model: string, provider?: string): Reviewer => ({
  name,
  harness: "opencode",
  model,
  provider,
  thinking: "high",
  unmetered: false,
});

const opus = reviewer("opus", "opus", "anthropic");
const sol = reviewer("sol", "gpt-6.1-sol", "openai");
const sonnet = reviewer("sonnet", "sonnet", "anthropic");
const reviewers = [opus, sol, sonnet];

const author = {
  name: "cheap",
  harness: "claude",
  model: "haiku",
  provider: undefined,
  level: 0,
  enabled: true,
  author: true,
  unmetered: false,
};
const opusAuthor = {
  name: "opus-low",
  harness: "claude",
  model: "opus",
  provider: undefined,
  level: 1,
  enabled: true,
  author: true,
  unmetered: false,
};

describe("reviewerFor", () => {
  test("takes the reviewer whose last review started longest ago", () => {
    const lastStarts = new Map([
      ["opus", new Date(3)],
      ["sol", new Date(1)],
      ["sonnet", new Date(2)],
    ]);
    expect(reviewerFor(reviewers, author, new Set(), [], lastStarts)).toEqual({
      _tag: "Dispatch",
      reviewer: sol,
    });
  });

  test("passes over a reviewer on a spent account", () => {
    const lastStarts = new Map([
      ["opus", new Date(3)],
      ["sol", new Date(1)],
      ["sonnet", new Date(2)],
    ]);
    expect(reviewerFor(reviewers, author, new Set(["sol"]), [], lastStarts)).toEqual({
      _tag: "Dispatch",
      reviewer: sonnet,
    });
  });

  test("waits when every reviewer left is on a spent account", () => {
    expect(reviewerFor(reviewers, author, new Set(["opus", "sol", "sonnet"]))).toEqual({
      _tag: "Waiting",
    });
  });

  test("takes a reviewer whose model is not the author's before an older one that is", () => {
    const lastStarts = new Map([
      ["opus", new Date(1)],
      ["sol", new Date(2)],
    ]);
    expect(reviewerFor([opus, sol], opusAuthor, new Set(), [], lastStarts)).toEqual({
      _tag: "Dispatch",
      reviewer: sol,
    });
  });

  test("takes the author's own model when no other reviewer can pay", () => {
    expect(reviewerFor([opus, sol], opusAuthor, new Set(["sol"]))).toEqual({
      _tag: "Dispatch",
      reviewer: opus,
    });
  });

  test("passes over a reviewer that stopped with no verdict on this lap", () => {
    expect(reviewerFor([opus, sol], author, new Set(), ["opus"])).toEqual({
      _tag: "Dispatch",
      reviewer: sol,
    });
  });

  test("is exhausted, so the task parks, when every reviewer has stopped", () => {
    expect(reviewerFor([opus, sol], author, new Set(["sol"]), ["opus", "sol"])).toEqual({
      _tag: "Exhausted",
    });
  });

  test("is exhausted for an empty list", () => {
    expect(reviewerFor([], author)).toEqual({ _tag: "Exhausted" });
  });
});

describe("drawnBy", () => {
  test("draws every reviewer for the reviewers rule, and one for its name", () => {
    expect(drawnBy(reviewers, "reviewers")).toEqual(reviewers);
    expect(drawnBy(reviewers, "sol")).toEqual([sol]);
    expect(drawnBy(reviewers, "nobody")).toEqual([]);
  });
});

describe("seatOf", () => {
  const ladder: Ladder = [
    {
      name: "opus",
      harness: "claude",
      model: "opus",
      provider: undefined,
      level: 0,
      enabled: true,
      author: true,
      unmetered: false,
    },
  ];

  test("reads a review run's name in the reviewers, an author run's in the ladder", () => {
    const seats = { ladder, reviewers };
    expect(seatOf(seats, { role: "review", rung: Option.some("opus") })).toBe(opus);
    expect(seatOf(seats, { role: "author", rung: Option.some("opus") })).toBe(ladder[0]);
    expect(seatOf(seats, { role: "author", rung: Option.some("sol") })).toBeUndefined();
  });
});

describe("providersOf with reviewers", () => {
  test("names an account that only a reviewer spends", () => {
    const ladder: Ladder = [
      {
        name: "opus",
        harness: "claude",
        model: "opus",
        provider: undefined,
        level: 0,
        enabled: true,
        author: true,
        unmetered: false,
      },
    ];
    expect(providersOf(ladder, [sol])).toEqual(["claude", "openai"]);
  });
});
