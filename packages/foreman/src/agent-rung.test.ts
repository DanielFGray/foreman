import { describe, expect, test } from "bun:test";
import type { Run } from "tasks";
import { type PerRole, seatAt, taskWalls } from "./agent-rung.ts";
import type { Ladder } from "./ladder.ts";
import type { AgentNode } from "./pipeline.ts";
import type { Reviewer } from "./reviewers.ts";
import { authorDone, authorRun, charged, reviewRun } from "./task-fixture.ts";

const LADDER: Ladder = [
  { name: "cheap", harness: "test", level: 0, model: undefined, provider: undefined },
  { name: "dear", harness: "test", level: 1, model: undefined, provider: undefined },
];

// "dear" is also a reviewer's name: a run's role says which list it is in.
const REVIEWERS: ReadonlyArray<Reviewer> = [
  { name: "dear", harness: "test", model: "m-dear", provider: "acct-a", thinking: "high" },
  { name: "keen", harness: "test", model: "m-keen", provider: "acct-b", thinking: "high" },
];

/** No seat walled for either role, or these for the given role. */
const walls = (
  author: Iterable<string> = [],
  review: Iterable<string> = [],
): PerRole<ReadonlySet<string>> => ({
  author: new Set(author),
  review: new Set(review),
});

const author = (model: string): AgentNode => ({
  kind: "agent",
  id: "author",
  role: "author",
  model,
  exits: [
    { id: "done", name: "done", to: "review-gate" },
    { id: "already-done", name: "already-done", to: "review-gate" },
  ],
});

const reviewer = (model: string): AgentNode => ({
  kind: "agent",
  id: "review",
  role: "review",
  model,
  exits: [
    { id: "approved", name: "approved", to: "land-gate" },
    { id: "returned", name: "returned", to: "queue", fails: "author" },
  ],
});

/** A task charged with failing on each rung in `failedBy`, with these runs. */
const task = (failedBy: ReadonlyArray<string>, runs: ReadonlyArray<Run> = []) => ({
  charges: failedBy.map((rung) => charged(rung)),
  runs,
});

const seatOf = (choice: ReturnType<typeof seatAt>) =>
  choice._tag === "Dispatch" ? choice.seat.name : choice._tag;

const at = (ladder: Ladder, block: AgentNode, on: ReturnType<typeof task>, walled = walls()) =>
  seatOf(seatAt({ ladder, reviewers: REVIEWERS }, block, on, walled));

describe("the rung an agent block runs a task on", () => {
  test("ladder climbs above the task's failures", () => {
    expect(at(LADDER, author("ladder"), task([]))).toBe("cheap");
    expect(at(LADDER, author("ladder"), task(["cheap"]))).toBe("dear");
    expect(at(LADDER, author("ladder"), task(["cheap", "dear"]))).toBe("Exhausted");
  });

  test("reviewers takes a reviewer, never a rung, and waits when each is on a spent account", () => {
    const authored = task([], [authorDone("cheap")]);
    expect(at(LADDER, reviewer("reviewers"), authored)).toBe("dear");
    expect(at(LADDER, reviewer("reviewers"), authored, walls([], ["dear"]))).toBe("keen");
    // A rung walled under the same name does not wall the reviewer.
    expect(at(LADDER, reviewer("reviewers"), authored, walls(["dear"]))).toBe("dear");
    expect(at(LADDER, reviewer("reviewers"), authored, walls([], ["dear", "keen"]))).toBe(
      "Waiting",
    );
  });

  test("a review block passes over the reviewers that stopped this lap, and parks with none left", () => {
    const stopped = (name: string) => reviewRun(name, { open: false, ending: "stopped" });
    expect(
      at(LADDER, reviewer("reviewers"), task([], [authorDone("cheap"), stopped("dear")])),
    ).toBe("keen");
    expect(
      at(
        LADDER,
        reviewer("reviewers"),
        task([], [authorDone("cheap"), stopped("dear"), stopped("keen")]),
      ),
    ).toBe("Exhausted");
  });

  test("a review block pinned to a reviewer takes only that one", () => {
    const authored = task([], [authorDone("cheap")]);
    expect(at(LADDER, reviewer("keen"), authored)).toBe("keen");
    expect(at(LADDER, reviewer("keen"), authored, walls([], ["keen"]))).toBe("Waiting");
    const stopped = reviewRun("keen", { open: false, ending: "stopped" });
    expect(at(LADDER, reviewer("keen"), task([], [authorDone("cheap"), stopped]))).toBe(
      "Exhausted",
    );
  });

  test("a pinned rung runs, waits for its account or for the operator to switch it on, or parks once it has failed the task", () => {
    expect(at(LADDER, author("dear"), task([]))).toBe("dear");
    expect(at(LADDER, author("dear"), task([]), walls(["dear"]))).toBe("Waiting");
    const offDuty: Ladder = [
      { ...LADDER[0]!, enabled: false },
      { ...LADDER[1]!, author: false },
    ];
    expect(at(offDuty, author("cheap"), task([]))).toBe("Waiting");
    expect(at(offDuty, author("dear"), task([]))).toBe("Waiting");
    // A pinned block has no other rung to climb to, so a failure on it is the
    // operator's to answer.
    expect(at(LADDER, author("cheap"), task(["cheap"]))).toBe("Exhausted");
  });
});

describe("the seats a task may not take", () => {
  test("a walled run's account walls the seats of its own role's list", () => {
    const ladder: Ladder = [
      { name: "dear", harness: "test", level: 0, model: undefined, provider: "acct-b" },
    ];
    const seats = { ladder, reviewers: REVIEWERS };
    // The review run "dear" ran on acct-a, the reviewer's account, not the rung's.
    const walledReview = task([], [reviewRun("dear", { open: false, ending: "walled" })]);
    expect(taskWalls(seats, walledReview, walls())).toEqual(walls([], ["dear"]));
    const walledAuthor = task([], [authorRun("dear", { open: false, ending: "walled" })]);
    expect(taskWalls(seats, walledAuthor, walls())).toEqual(walls(["dear"], ["keen"]));
  });
});
