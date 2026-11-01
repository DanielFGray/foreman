import { describe, expect, test } from "bun:test";
import { placementOf, resolveOpen, stateOf, type Terminal, workersOf } from "./hc.ts";

const terminal = (
  overrides: Partial<Terminal> & { labels?: Record<string, string> },
): Terminal => ({
  address: "t1",
  cwd: "/state/worktrees/proj/ts-1",
  state: "live",
  created_ms: 1,
  status: { state: "working" },
  ...overrides,
  labels: {
    "fm.fleet": "foreman",
    "fm.task": "ts-1",
    "fm.role": "author",
    "fm.repo": "/build/proj",
    ...overrides.labels,
  },
});

describe("stateOf", () => {
  test("reads a live agent that has not reported yet as working", () => {
    // Reading it as settled would let a second agent into the worktree
    // before the first has started.
    expect(stateOf(terminal({ status: null }))).toBe("working");
  });

  test("reads the agent's own report", () => {
    expect(stateOf(terminal({ status: { state: "blocked" } }))).toBe("blocked");
    expect(stateOf(terminal({ status: { state: "idle" } }))).toBe("settled");
    expect(stateOf(terminal({ status: { state: "done" } }))).toBe("settled");
    expect(stateOf(terminal({ status: { state: "error" } }))).toBe("settled");
  });

  test("reads an exited program as gone, whatever it last reported", () => {
    expect(stateOf(terminal({ state: "finished", status: { state: "working" } }))).toBe("gone");
  });

  test("reads a shell kept in place of a killed agent as gone", () => {
    // herdr-app keeps the terminals it shows, so an agent the OOM killer ends
    // leaves a live shell that reports nothing and would read as starting up.
    const started = { labels: { "fm.pid": "100" }, status: null };
    expect(stateOf(terminal({ ...started, pid: 100 }))).toBe("working");
    expect(stateOf(terminal({ ...started, pid: 200 }))).toBe("gone");
  });
});

describe("workersOf", () => {
  test("joins a task's terminals into one worker with a state per role", () => {
    const [worker, ...rest] = workersOf([
      terminal({ address: "t1", status: { state: "idle" } }),
      terminal({ address: "t2", labels: { "fm.role": "review" }, status: { state: "working" } }),
    ]);
    expect(rest).toEqual([]);
    expect(worker!.task).toBe("ts-1");
    expect(worker!.worktree).toBe("/state/worktrees/proj/ts-1");
    expect(worker!.repository).toBe("/build/proj");
    expect([...worker!.roles]).toEqual([
      ["author", "settled"],
      ["review", "working"],
    ]);
    expect(worker!.state).toBe("working");
  });

  test("takes a role's state from its newest terminal", () => {
    // spawn ends the spent terminal only after the replacement starts.
    const [worker] = workersOf([
      terminal({ address: "t1", created_ms: 1, status: { state: "idle" } }),
      terminal({ address: "t2", created_ms: 2, status: null }),
    ]);
    expect(worker!.roles.get("author")).toBe("working");
  });

  test("marks a worker over the checkout itself as having no worktree", () => {
    // close deletes the worktree, and the operator's checkout is never one.
    const [worker] = workersOf([terminal({ cwd: "/build/proj" })]);
    expect(worker!.worktree).toBeUndefined();
  });

  test("ignores terminals that carry no task", () => {
    expect(workersOf([terminal({ labels: { "fm.task": undefined as never } })])).toEqual([]);
  });
});

describe("placementOf", () => {
  const open = (cwd: string, space: string, labels: Record<string, string> = {}) => ({
    cwd,
    labels: { "herdr.space": space, ...labels },
  });

  test("puts the task's tab in the space already open on its checkout", () => {
    expect(
      placementOf(
        [open("/elsewhere", "sp-x"), open("/build/proj/src", "sp-proj")],
        "ts-1",
        "/build/proj",
      ),
    ).toEqual({ space: "sp-proj", tab: "fm-ts-1" });
  });

  test("does not follow another task's worker, nor a sibling with a shared prefix", () => {
    expect(
      placementOf(
        [
          open("/build/proj", "fm-ts-2", { "fm.task": "ts-2" }),
          open("/build/project-two", "sp-other"),
        ],
        "ts-1",
        "/build/proj",
      ),
    ).toEqual({ space: "fm-ts-1", tab: "fm-ts-1" });
  });
});

describe("resolveOpen", () => {
  const options = { branch: "foreman/ts-1", directory: "/state/proj/ts-1" };
  const worktree = (path: string, branch: string | undefined, prunable = false) => ({
    path,
    branch,
    prunable,
  });

  test("adopts the worktree git has out for the branch, wherever it is", () => {
    expect(resolveOpen([worktree("/elsewhere", "foreman/ts-1")], options)).toEqual({
      kind: "adopt",
      path: "/elsewhere",
    });
  });

  test("puts a worktree at foreman's path back on its branch rather than colliding with it", () => {
    expect(resolveOpen([worktree("/state/proj/ts-1", undefined)], options)).toEqual({
      kind: "restore",
      path: "/state/proj/ts-1",
    });
  });

  test("creates only where git has nothing live registered", () => {
    expect(resolveOpen([worktree("/state/proj/ts-1", "foreman/ts-1", true)], options)).toEqual({
      kind: "create",
      path: "/state/proj/ts-1",
    });
  });
});
