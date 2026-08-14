import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { scopeOf, splitQueue } from "./focus.ts";
import type { Item, ReadyTask } from "./prog.ts";

const item = (id: string, type: "task" | "epic", project = "foreman"): Item => ({
  id,
  title: id,
  status: "open",
  project,
  type,
  priority: 1,
  labels: [],
  last_activity_at: new Date(),
});

const tree = (children: Record<string, ReadonlyArray<Item>>) => (id: string) =>
  Effect.succeed(children[id] ?? []);

const ready = (id: string, project: string, priority = 1): ReadyTask => ({
  id,
  title: id,
  priority,
  project,
  labels: [],
});

describe("scopeOf", () => {
  test("a focused task is its own scope", () => {
    const scope = Effect.runSync(scopeOf([item("ts-1", "task")], tree({})));

    expect([...scope.tasks]).toEqual(["ts-1"]);
    expect([...scope.projects]).toEqual(["foreman"]);
  });

  test("a focused epic brings every descendant task, however deep", () => {
    const scope = Effect.runSync(
      scopeOf(
        [item("ep-1", "epic")],
        tree({
          "ep-1": [item("ts-a", "task"), item("ep-2", "epic")],
          "ep-2": [item("ts-b", "task")],
        }),
      ),
    );

    expect([...scope.tasks].sort()).toEqual(["ts-a", "ts-b"]);
    expect([...scope.projects]).toEqual(["foreman"]);
  });

  test("two labelled epics are one larger scope", () => {
    const scope = Effect.runSync(
      scopeOf(
        [item("ep-1", "epic"), item("ep-2", "epic")],
        tree({
          "ep-1": [item("ts-a", "task")],
          "ep-2": [item("ts-b", "task")],
        }),
      ),
    );

    expect([...scope.tasks].sort()).toEqual(["ts-a", "ts-b"]);
  });

  test("collects every project a cross-project scope touches", () => {
    const scope = Effect.runSync(
      scopeOf(
        [item("ep-1", "epic", "alpha")],
        tree({
          "ep-1": [item("ts-a", "task", "alpha"), item("ts-b", "task", "beta")],
        }),
      ),
    );

    expect([...scope.projects].sort()).toEqual(["alpha", "beta"]);
  });
});

describe("splitQueue", () => {
  test("without focus the whole ready set is spillover", () => {
    const { focus, spillover } = splitQueue(
      [ready("a1", "a", 1), ready("b1", "b", 1)],
      new Set(),
      new Set(["a", "b"]),
      false,
    );

    expect(focus).toEqual([]);
    expect(spillover.map((t) => t.id)).toEqual(["a1", "b1"]);
  });

  test("the focused thread keeps prog order and excludes spillover", () => {
    const { focus, spillover } = splitQueue(
      [ready("hi", "p", 1), ready("lo", "p", 2), ready("p2", "p", 3), ready("other", "q", 1)],
      new Set(["lo", "hi"]),
      new Set(["p"]),
      true,
    );

    // Priority first, as prog ready returns it, not rotated between projects.
    expect(focus.map((t) => t.id)).toEqual(["hi", "lo"]);
    // Spillover is the rest, confined to the touched project: "other" is in q.
    expect(spillover.map((t) => t.id)).toEqual(["p2"]);
  });

  test("spillover is confined to the projects the scope touches", () => {
    const { spillover } = splitQueue(
      [ready("p1", "p", 1), ready("q1", "q", 1)],
      new Set(["p1"]),
      new Set(["p"]),
      true,
    );

    // q1 is outside the touched project, so it does not appear at all.
    expect(spillover.map((t) => t.id)).toEqual([]);
  });
});
