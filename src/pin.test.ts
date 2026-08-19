import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { pinnedFirst, pinnedOf, scopeOf } from "./pin.ts";
import type { Item, ReadyTask } from "./prog.ts";

const item = (id: string, type: "task" | "epic", project = "foreman"): Item => ({
  id,
  title: id,
  status: "open",
  project,
  type,
  priority: 1,
  labels: [],
  description: null,
  last_activity_at: new Date(),
  created_at: new Date(),
});

const tree = (children: Record<string, ReadonlyArray<Item>>) => (id: string) =>
  Effect.succeed(children[id] ?? []);

const ready = (id: string, project: string, priority = 1): ReadyTask => ({
  id,
  title: id,
  priority,
  project,
  labels: [],
  description: null,
  created_at: new Date(),
});

describe("scopeOf", () => {
  test("a pinned task is its own scope", () => {
    const scope = Effect.runSync(scopeOf([item("ts-1", "task")], tree({})));

    expect([...scope]).toEqual(["ts-1"]);
  });

  test("a pinned epic brings every descendant task, however deep", () => {
    const scope = Effect.runSync(
      scopeOf(
        [item("ep-1", "epic")],
        tree({
          "ep-1": [item("ts-a", "task"), item("ep-2", "epic")],
          "ep-2": [item("ts-b", "task")],
        }),
      ),
    );

    expect([...scope].sort()).toEqual(["ts-a", "ts-b"]);
  });

  test("two pinned epics are one larger scope", () => {
    const scope = Effect.runSync(
      scopeOf(
        [item("ep-1", "epic"), item("ep-2", "epic")],
        tree({
          "ep-1": [item("ts-a", "task")],
          "ep-2": [item("ts-b", "task")],
        }),
      ),
    );

    expect([...scope].sort()).toEqual(["ts-a", "ts-b"]);
  });

  test("a pinned epic reaches descendants in another project", () => {
    const scope = Effect.runSync(
      scopeOf(
        [item("ep-1", "epic", "alpha")],
        tree({
          "ep-1": [item("ts-a", "task", "alpha"), item("ts-b", "task", "beta")],
        }),
      ),
    );

    expect([...scope].sort()).toEqual(["ts-a", "ts-b"]);
  });
});

describe("pinnedOf", () => {
  test("ignores pins outside the configured project allowlist", () => {
    const pinned = Effect.runSync(
      pinnedOf(
        [item("ep-other", "epic", "other")],
        new Set(["foreman"]),
        tree({ "ep-other": [item("ts-other", "task", "other")] }),
      ),
    );

    expect([...pinned]).toEqual([]);
  });

  test("keeps configured descendants of a configured cross-project root", () => {
    const pinned = Effect.runSync(
      pinnedOf(
        [item("ep-root", "epic", "alpha")],
        new Set(["alpha", "beta"]),
        tree({
          "ep-root": [item("ts-alpha", "task", "alpha"), item("ts-beta", "task", "beta")],
        }),
      ),
    );

    expect([...pinned].sort()).toEqual(["ts-alpha", "ts-beta"]);
  });
});

describe("pinnedFirst", () => {
  test("with nothing pinned the queue is the ordinary interleaved set", () => {
    const queue = pinnedFirst([ready("a1", "a"), ready("b1", "b")], new Set(), ["a", "b"]);

    expect(queue.map((task) => task.id)).toEqual(["a1", "b1"]);
  });

  test("pinned work leads, whatever its priority says", () => {
    const queue = pinnedFirst([ready("urgent", "p", 1), ready("dull", "p", 3)], new Set(["dull"]), [
      "p",
    ]);

    // Priority 3 beats priority 1 here only because it is pinned; a pin is an
    // absolute lead rather than a contribution to the score.
    expect(queue.map((task) => task.id)).toEqual(["dull", "urgent"]);
  });

  test("each half keeps the ordinary ordering rules inside it", () => {
    const queue = pinnedFirst(
      [
        ready("pin-lo", "p", 3),
        ready("pin-hi", "p", 1),
        ready("rest-lo", "p", 3),
        ready("rest-hi", "p", 1),
      ],
      new Set(["pin-lo", "pin-hi"]),
      ["p"],
    );

    expect(queue.map((task) => task.id)).toEqual(["pin-hi", "pin-lo", "rest-hi", "rest-lo"]);
  });

  test("unpinned work still runs — a pin orders the queue, it does not empty it", () => {
    const queue = pinnedFirst([ready("p1", "p"), ready("q1", "q")], new Set(["p1"]), ["p", "q"]);

    expect(queue.map((task) => task.id)).toEqual(["p1", "q1"]);
  });

  test("several pinned tasks all reach the queue rather than one at a time", () => {
    const queue = pinnedFirst(
      [ready("one", "p", 1), ready("two", "p", 1), ready("three", "p", 1)],
      new Set(["one", "two", "three"]),
      ["p"],
    );

    // Nothing here serializes: which of these may run together is what the
    // plan's blockers say, and prog.ready has already applied them.
    expect(queue).toHaveLength(3);
  });

  test("a pin naming a task outside the configured projects orders nothing", () => {
    const queue = pinnedFirst([ready("p1", "p"), ready("q1", "q")], new Set(["q1"]), ["p"]);

    expect(queue.map((task) => task.id)).toEqual(["p1"]);
  });
});
