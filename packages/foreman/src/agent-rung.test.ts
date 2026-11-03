import { describe, expect, test } from "bun:test";
import type { Run } from "tasks";
import { rungAt } from "./agent-rung.ts";
import type { Ladder } from "./ladder.ts";
import type { AgentNode } from "./pipeline.ts";
import { authorDone, charged } from "./task-fixture.ts";

const LADDER: Ladder = [
  { name: "cheap", harness: "test", model: undefined, provider: undefined },
  { name: "dear", harness: "test", model: undefined, provider: undefined },
];

const author = (model: string): AgentNode => ({
  kind: "agent",
  id: "author",
  role: "author",
  model,
  exits: [
    { name: "done", to: "review-gate" },
    { name: "already-done", to: "review-gate" },
  ],
});

const reviewer = (model: string): AgentNode => ({
  kind: "agent",
  id: "review",
  role: "review",
  model,
  exits: [
    { name: "approved", to: "land-gate" },
    { name: "returned", to: "queue", fails: "author" },
  ],
});

/** A task charged with failing on each rung in `failedBy`, with these runs. */
const task = (failedBy: ReadonlyArray<string>, runs: ReadonlyArray<Run> = []) => ({
  charges: failedBy.map((rung) => charged(rung)),
  runs,
});

const rungOf = (choice: ReturnType<typeof rungAt>) =>
  choice._tag === "Dispatch" ? choice.rung.name : choice._tag;

describe("the rung an agent block runs a task on", () => {
  test("ladder climbs above the task's failures", () => {
    expect(rungOf(rungAt(LADDER, author("ladder"), task([]), new Set()))).toBe("cheap");
    expect(rungOf(rungAt(LADDER, author("ladder"), task(["cheap"]), new Set()))).toBe("dear");
    expect(rungOf(rungAt(LADDER, author("ladder"), task(["cheap", "dear"]), new Set()))).toBe(
      "Exhausted",
    );
  });

  test("above takes the rung over the author", () => {
    const authored = task([], [authorDone("cheap")]);
    expect(rungOf(rungAt(LADDER, reviewer("above"), authored, new Set()))).toBe("dear");
    expect(rungOf(rungAt(LADDER, reviewer("above"), authored, new Set(["dear"])))).toBe("Waiting");
  });

  test("a pinned rung runs, waits for its account or for the operator to switch it on, or parks once it has failed the task", () => {
    expect(rungOf(rungAt(LADDER, author("dear"), task([]), new Set()))).toBe("dear");
    expect(rungOf(rungAt(LADDER, author("dear"), task([]), new Set(["dear"])))).toBe("Waiting");
    const offDuty: Ladder = [
      { ...LADDER[0]!, enabled: false },
      { ...LADDER[1]!, author: false },
    ];
    expect(rungOf(rungAt(offDuty, author("cheap"), task([]), new Set()))).toBe("Waiting");
    expect(rungOf(rungAt(offDuty, author("dear"), task([]), new Set()))).toBe("Waiting");
    // A pinned block has no other rung to climb to, so a failure on it is the
    // operator's to answer.
    expect(rungOf(rungAt(LADDER, author("cheap"), task(["cheap"]), new Set()))).toBe("Exhausted");
  });
});
