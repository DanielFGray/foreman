import { describe, expect, test } from "bun:test";
import {
  agentNameFor,
  opencodeCommand,
  paneFor,
  resolveClose,
  resolveOpen,
  stillRunning,
  workerStateOf,
  type WorktreeRecord,
} from "./herdr.ts";
import type { Worker } from "./fleet.ts";

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

describe("opencodeCommand", () => {
  const configIn = (command: string): Record<string, unknown> => {
    const match = /^OPENCODE_CONFIG_CONTENT='([^']*)' opencode --standalone --auto$/.exec(command);
    expect(match).not.toBeNull();
    return JSON.parse(match?.[1] ?? "");
  };

  test("carries the model in the config and runs opencode on a private server", () => {
    const config = configIn(opencodeCommand("opencode-go/terra", "/home/dan/build/quill"));

    expect(config["model"]).toBe("opencode-go/terra");
    expect(config["permission"]).toEqual({
      bash: { "git push*": "deny" },
      external_directory: {
        "/home/dan/build/quill": "deny",
        "/home/dan/build/quill/**": "deny",
      },
    });
  });

  test("denies pushing and the operator's checkout, and omits an unchosen model", () => {
    const config = configIn(opencodeCommand(undefined, undefined));

    expect("model" in config).toBe(false);
    expect(config["permission"]).toEqual({ bash: { "git push*": "deny" } });
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
    expect(
      paneFor([pane("w1:p1", { label: "foreman-author", agent_status: "working" })])?.pane_id,
    ).toBe("w1:p1");
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

const worker = (task: string, worktree: string | undefined): Worker => ({
  task,
  workspace: "w1",
  pane: "w1:p1",
  directory: worktree ?? "/home/dan/build/project",
  repository: "/home/dan/build/project",
  worktree,
  state: "gone",
  roles: new Map(),
});

const worktree = (
  branch: string | undefined,
  overrides: Partial<WorktreeRecord> = {},
): WorktreeRecord => ({
  branch,
  path: `/worktrees/${branch ?? "detached"}`,
  is_prunable: false,
  ...overrides,
});

const openFor = (task: string) => ({
  task,
  repository: "/home/dan/build/project",
  branch: `foreman/${task}`,
  directory: `/worktrees/${task}`,
});

describe("resolveOpen", () => {
  test("a workspace carrying the task's label wins outright", () => {
    const resolution = resolveOpen(
      [worker("ts-1", "/worktrees/ts-1")],
      [worktree("foreman/ts-1")],
      openFor("ts-1"),
    );

    expect(resolution).toEqual({ kind: "workspace", worker: worker("ts-1", "/worktrees/ts-1") });
  });

  test("a worktree git still has is adopted when the workspace is gone", () => {
    const registered = worktree("foreman/ts-1");
    const resolution = resolveOpen([], [registered], openFor("ts-1"));

    expect(resolution).toEqual({ kind: "worktree", worktree: registered });
  });

  test("a prunable registration has nothing to adopt", () => {
    // The directory is gone, so opening it would fail; creating takes over.
    const resolution = resolveOpen(
      [],
      [worktree("foreman/ts-1", { is_prunable: true })],
      openFor("ts-1"),
    );

    expect(resolution).toEqual({ kind: "create" });
  });

  test("another task's worktree is not this task's", () => {
    const resolution = resolveOpen([], [worktree("foreman/ts-2")], openFor("ts-1"));

    expect(resolution).toEqual({ kind: "create" });
  });

  test("nothing registered means create both", () => {
    expect(resolveOpen([], [], openFor("ts-1"))).toEqual({ kind: "create" });
  });
});

describe("resolveClose", () => {
  test("a worktree worker is removed through its workspace", () => {
    const resolution = resolveClose([worker("ts-1", "/worktrees/ts-1")], [], "ts-1");

    expect(resolution).toEqual({ kind: "worktree", worker: worker("ts-1", "/worktrees/ts-1") });
  });

  test("a workspace on a checkout that was already there is only closed", () => {
    const resolution = resolveClose([worker("ts-1", undefined)], [], "ts-1");

    expect(resolution).toEqual({ kind: "workspace", worker: worker("ts-1", undefined) });
  });

  test("a workspace whose workspace died is removed by adopting the worktree", () => {
    const resolution = resolveClose([], [worktree("foreman/ts-1")], "ts-1");

    expect(resolution).toEqual({ kind: "worktree", worker: undefined });
  });

  test("nothing to tear down", () => {
    expect(resolveClose([], [], "ts-1")).toEqual({ kind: "nothing" });
  });
});

describe("stillRunning", () => {
  test("work in progress is what a second agent would collide with", () => {
    expect(stillRunning("working")).toBe(true);
    expect(stillRunning("blocked")).toBe(true);
  });

  // Reading a settled agent as a reason to refuse is a stall with no exit:
  // nothing ends that agent, so the task returns to the queue and the same
  // dispatch fails again every poll, forever.
  test("a settled agent is spent, not a reason to refuse the next dispatch", () => {
    expect(stillRunning("settled")).toBe(false);
    expect(stillRunning("gone")).toBe(false);
  });
});
