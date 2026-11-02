import { describe, expect, test } from "bun:test";
import type { Item } from "./records.ts";
import { newRunFor, poolFor } from "./run-record.ts";

const task = (overrides: Partial<Item> = {}) =>
  ({
    id: "ts-1",
    title: "Measure the stack-safety candidates",
    project: "quill",
    labels: [],
    status: "reviewing",
    ...overrides,
  }) as unknown as Item;

const run = (overrides: Partial<Parameters<typeof newRunFor>[0]> = {}) => ({
  task: task(),
  branch: "foreman/ts-1",
  harness: "opencode",
  model: "opencode-go/deepseek-v4-flash",
  rung: "cheap",
  provider: "opencode-go",
  role: "author" as const,
  node: "author",
  ...overrides,
});

describe("poolFor", () => {
  test("names an account as the trials table spells it", () => {
    expect(poolFor("openai")).toBe("OpenAI");
    expect(poolFor("opencode-go")).toBe("OpenCode Go");
    expect(poolFor("opencode")).toBe("OpenCode Zen");
    expect(poolFor("claude")).toBe("Anthropic");
  });

  test("writes an account it has no name for as itself", () => {
    // A wrong pool name is worse than a key nobody recognises: it silently
    // splits one account's history into two.
    expect(poolFor("brand-new")).toBe("brand-new");
  });
});

describe("newRunFor", () => {
  test("states the run foreman knows at dispatch and nothing it did not", () => {
    expect(newRunFor(run())).toEqual({
      project: "quill",
      task: "ts-1",
      slice: "Measure the stack-safety candidates",
      kind: "opencode",
      pool: "OpenCode Go",
      model: "opencode-go/deepseek-v4-flash",
      rung: "cheap",
      node: "author",
      work: "build",
      commit: undefined,
      size: undefined,
      evidence: "foreman/ts-1",
    });
  });

  test("reads size from the task's label", () => {
    expect(newRunFor(run({ task: task({ labels: ["size:2"] }) }))).toMatchObject({ size: 2 });
  });

  test("a review run is review work and records the tip it reads", () => {
    expect(newRunFor(run({ role: "review", node: "review", commit: "c1" }))).toMatchObject({
      work: "review",
      node: "review",
      commit: "c1",
    });
  });

  test("a research task's author does research", () => {
    expect(newRunFor(run({ task: task({ labels: ["research"] }) }))).toMatchObject({
      work: "research",
    });
  });

  test("names the harness when the account cannot be read", () => {
    // A rung with no derivable provider still ran; the harness is the honest
    // pool rather than an account foreman invented.
    expect(newRunFor(run({ provider: undefined, model: undefined }))).toMatchObject({
      pool: "opencode",
      model: "opencode",
    });
  });
});
