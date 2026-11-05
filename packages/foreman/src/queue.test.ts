import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import type { Ladder } from "./ladder.ts";
import { interleave, queueFrom } from "./queue.ts";
import type { Item } from "./records.ts";
import { charged } from "./task-fixture.ts";

const now = new Date("2026-08-14T00:00:00Z");

const task = (
  id: string,
  project: string,
  priority: number,
  createdAt = now,
  labels: ReadonlyArray<string> = [],
): Item => ({
  id,
  project,
  priority,
  title: id,
  labels,
  description: "",
  parent: Option.none(),
  createdAt: createdAt,
  updatedAt: new Date(0),
  lastActivityAt: new Date(0),
  definitionOfDone: Option.none(),
  type: "task",
  status: "open",
  runs: [],
  charges: [],
  parked: undefined,
  tip: undefined,
});

const bug = (id: string, project: string, priority: number, createdAt = now): Item =>
  task(id, project, priority, createdAt, ["bug"]);

const ancient = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

describe("interleave", () => {
  test("never rotates lower-priority work ahead", () => {
    const result = interleave(
      [task("a1", "a", 1), task("a2", "a", 1), task("b2", "b", 2)],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["a1", "a2", "b2"]);
  });

  test("rotates projects within a priority", () => {
    const result = interleave(
      [task("a1", "a", 1), task("a2", "a", 1), task("b1", "b", 1), task("b2", "b", 1)],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["a1", "b1", "a2", "b2"]);
  });

  test("keeps only configured projects from the global ready set", () => {
    const result = interleave(
      [task("a1", "a", 1), task("b1", "b", 1), task("c1", "c", 1)],
      ["a", "c"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["a1", "c1"]);
  });

  test("ages waiting tasks within the bounded score", () => {
    const result = interleave(
      [task("new-high", "a", 1), task("old-medium", "b", 2, new Date("2026-08-04T00:00:00Z"))],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["old-medium", "new-high"]);
  });

  test("does not let aging outrank fresh high priority work past the cap", () => {
    const result = interleave(
      [task("new-high", "a", 1), task("old-low", "b", 3, new Date("2026-07-01T00:00:00Z"))],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["new-high", "old-low"]);
  });

  test("rotates projects across nearby continuous scores", () => {
    const result = interleave(
      [task("a1", "a", 1), task("a2", "a", 1.1), task("b1", "b", 1.2), task("b2", "b", 1.3)],
      ["a", "b"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["a1", "b1", "a2", "b2"]);
  });

  // The case that started this: a backlog filed almost entirely at one priority
  // sorts by age alone, so a feature batch entered first drains ahead of every
  // defect discovered after it.
  test("puts a defect ahead of same-priority work no matter how long that has waited", () => {
    const result = interleave(
      [task("feature", "a", 1, ancient), bug("defect", "a", 1)],
      ["a"],
      now,
    );

    expect(result.map(({ id }) => id)).toEqual(["defect", "feature"]);
  });

  test("puts a defect ahead of fresh work one priority above it", () => {
    const result = interleave([task("feature", "a", 1), bug("defect", "a", 2)], ["a"], now);

    expect(result.map(({ id }) => id)).toEqual(["defect", "feature"]);
  });

  test("still ranks defects among themselves by priority", () => {
    const result = interleave([bug("low", "a", 3), bug("high", "a", 1)], ["a"], now);

    expect(result.map(({ id }) => id)).toEqual(["high", "low"]);
  });

  test("a task closing out its epic outranks unrelated same-priority work", () => {
    const result = interleave([task("feature", "a", 1), task("closer", "a", 1)], ["a"], now, (t) =>
      t.id === "closer" ? 0.99 : 0,
    );

    expect(result.map(({ id }) => id)).toEqual(["closer", "feature"]);
  });

  test("early epic progress barely moves the score", () => {
    // Half done earns only a quarter of the ceiling — nowhere near enough to
    // beat a full priority band's worth of ordinary priority.
    const result = interleave(
      [task("urgent", "a", 1), task("half-done-epic", "a", 2)],
      ["a"],
      now,
      (t) => (t.id === "half-done-epic" ? 0.5 : 0),
    );

    expect(result.map(({ id }) => id)).toEqual(["urgent", "half-done-epic"]);
  });
});

describe("queueFrom", () => {
  const rung = (name: string): Ladder[number] => ({
    name,
    harness: "opencode",
    model: undefined,
    provider: undefined,
    level: 0,
    enabled: true,
    author: true,
    unmetered: false,
  });
  const ladder: Ladder = [rung("cheap"), { ...rung("top"), level: 1 }];
  const reading = (ready: ReadonlyArray<Item>, failed: ReadonlyArray<string> = []) => ({
    ready,
    ladder,
    projects: ["a"],
    epics: [],
    failed: new Set(failed),
    now,
  });
  const ids = (tasks: ReadonlyArray<Item>) => tasks.map(({ id }) => id);

  test("parks a task every rung has failed, and one parked for the operator", () => {
    const split = queueFrom(
      reading([
        { ...task("spent", "a", 1), charges: [charged("cheap"), charged("top")] },
        { ...task("asked", "a", 1), parked: "asked" },
        { ...task("ready", "a", 1), charges: [charged("cheap")] },
      ]),
    );
    expect(ids(split.queue)).toEqual(["ready"]);
    expect(ids(split.yours)).toEqual(["spent", "asked"]);
  });

  test("keeps onboarding and twice-failed dispatches out of the queue", () => {
    const split = queueFrom(
      reading(
        [task("salvage", "a", 1, now, ["onboard"]), task("broken", "a", 1), task("ok", "a", 1)],
        ["broken"],
      ),
    );
    expect(ids(split.queue)).toEqual(["ok"]);
    expect(split.yours).toEqual([]);
  });

  test("leaves out projects that take no new work", () => {
    const split = queueFrom(
      reading([task("elsewhere", "b", 1), { ...task("asked", "b", 1), parked: "asked" }]),
    );
    expect(split.queue).toEqual([]);
    expect(split.yours).toEqual([]);
  });

  test("ranks a task under a nearly done epic ahead of its band", () => {
    const child = (id: string, status: Item["status"]): Item => ({
      id,
      title: id,
      status,
      project: "a",
      type: "task",
      priority: 2,
      labels: [],
      description: "",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: new Date(0),
      definitionOfDone: Option.none(),
      parent: Option.some("ep"),
      runs: [],
      charges: [],
      parked: undefined,
      tip: undefined,
    });
    const epic = { ...child("ep", "in_progress"), type: "epic" as const, parent: Option.none() };
    const split = queueFrom({
      ...reading([task("plain", "a", 2), task("last", "a", 2)]),
      epics: [{ epic, children: [child("done", "done"), child("last", "open")] }],
    });
    expect(ids(split.queue)).toEqual(["last", "plain"]);
  });
});
