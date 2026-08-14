import { describe, expect, test } from "bun:test";
import { agentNameFor, workerStateOf } from "./herdr.ts";

describe("agentNameFor", () => {
  test("produces a valid name unique to the pane", () => {
    const first = agentNameFor("workspace/one:pane/123");
    const second = agentNameFor("workspace/one:pane/124");

    expect(first).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(first).not.toBe(second);
  });
});

describe("workerStateOf", () => {
  test("current work outranks an old settled pane", () => {
    expect(workerStateOf(["unknown", "done", "working"])).toBe("working");
  });

  test("blocked work still requires attention", () => {
    expect(workerStateOf(["done", "working", "blocked"])).toBe("blocked");
  });
});
