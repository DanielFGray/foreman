import { describe, expect, test } from "bun:test";
import { agentNameFor, paneFor, workerStateOf } from "./herdr.ts";

const pane = (
  pane_id: string,
  overrides: Partial<{
    label: string;
    agent: string;
    agent_status: string;
  }> = {},
) => ({
  pane_id,
  workspace_id: "w1",
  cwd: "/tmp/wt",
  agent_status: "unknown",
  ...overrides,
});

describe("agentNameFor", () => {
  test("produces a valid name unique to the pane", () => {
    const first = agentNameFor("workspace/one:pane/123");
    const second = agentNameFor("workspace/one:pane/124");

    expect(first).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(first).not.toBe(second);
  });
});

describe("paneFor", () => {
  test("a fresh workspace's only pane is its own", () => {
    expect(paneFor([pane("w1:p1")])?.pane_id).toBe("w1:p1");
  });

  test("a root pane carrying the author label still resolves to that pane", () => {
    // The author now runs in the workspace's own pane, so the label lands on
    // the root. It must keep resolving to the same worker that re-dispatch
    // reuses and the reviewer splits from.
    expect(paneFor([pane("w1:p1", { label: "foreman-author", agent_status: "working" })])?.pane_id).toBe(
      "w1:p1",
    );
  });

  test("the author's pane wins over a reviewer split beside it", () => {
    expect(
      paneFor([
        pane("w1:p1", { label: "foreman-author", agent_status: "settled" }),
        pane("w1:p2", { label: "foreman-review", agent_status: "working" }),
      ])?.pane_id,
    ).toBe("w1:p1");
  });

  test("a workspace with no panes has no own pane", () => {
    expect(paneFor([])).toBeUndefined();
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
