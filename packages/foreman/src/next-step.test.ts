import { describe, expect, test } from "bun:test";
import type { Run } from "tasks";
import { planFrom, reviewable } from "./dispatcher.ts";
import type { Ladder } from "./ladder.ts";
import { authoredBy, reviewedBy } from "./lap.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";
import { place, type Placement, STANDARD_PIPELINE } from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";
import type { Item, TaskStatus } from "./prog.ts";
import { queueFrom } from "./queue.ts";
import type { Landing } from "./repository.ts";
import type { TaskPhase } from "./task-phase.ts";
import { authorRun, authorDone, reviewRun, withRuns } from "./task-fixture.ts";

/**
 * The step a task takes next after each way settle can find a run ended, and
 * after each verdict a landing can return.
 *
 * Each row is the task as settle or land leaves it, and the step the tick
 * takes from there: `author` or `climb` for an author, `review`, `land`, or
 * `none` when no step is due (the task is done, parked, or its run is still
 * going). `step` is the step the fixed flow took before placement replaced
 * it, so the standard pipeline must take the same one. `at` is where the task
 * stands in the standard pipeline: the block, its state, and the gate on the
 * route to it.
 *
 * A task parked `needs-you` is placed waiting at the author, and takes no
 * step because the queue leaves it out for the operator.
 */

const LADDER: Ladder = [
  { name: "cheap", harness: "test", model: undefined, provider: undefined },
  { name: "dear", harness: "test", model: undefined, provider: undefined },
];

const task = (
  status: TaskStatus,
  labels: ReadonlyArray<string>,
  runs: ReadonlyArray<Run>,
  tip: string | undefined = "c1",
): Item =>
  withRuns(
    {
      id: "ts-1",
      title: "Task ts-1",
      status,
      project: "foreman",
      type: "task",
      priority: 1,
      labels,
      description: "",
      parent: undefined,
      lastActivityAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(0),
      definitionOfDone: undefined,
      runs: [],
      tip: undefined,
    },
    runs,
    tip,
  );

/** A reviewer sent the work back: its review run ended `returned`. */
const returned = (): Run => reviewRun("dear", { open: false, ending: "returned", commit: "c1" });

/** A reviewer approved c1 and has not been settled yet: its run is still open. */
const approved = (): Run => reviewRun("dear", { ending: "approved", commit: "c1" });

/** A reviewer whose run stopped without naming an exit. */
const stoppedReview = (rung: string): Run => reviewRun(rung, { open: false, ending: "stopped" });

const PHASES: ReadonlyArray<{
  readonly phase: TaskPhase;
  readonly after: string;
  readonly task: Item;
  readonly step: string;
  readonly at: string;
}> = [
  {
    phase: "Landed",
    after: "done",
    task: task("done", [], [authorDone("cheap")]),
    step: "none",
    at: "outside",
  },
  {
    phase: "Canceled",
    after: "canceled",
    task: task("canceled", [], [authorRun("cheap", { open: false, ending: "canceled" })]),
    step: "none",
    at: "outside",
  },
  {
    phase: "ReviewReturned",
    after: "released, the author's rung failed",
    task: task("open", ["failed-by:cheap"], [authorDone("cheap"), returned()]),
    step: "climb",
    at: "author waiting via climb",
  },
  {
    phase: "VanishedAttached",
    after: "left claimed",
    task: task("in_progress", [], [authorRun("cheap")]),
    step: "none",
    at: "author running via start",
  },
  {
    phase: "VanishedWithWork",
    after: "released with one attempt",
    task: task(
      "open",
      ["attempt:cheap:1"],
      [authorRun("cheap", { open: false, ending: "vanished" })],
    ),
    step: "climb",
    at: "author waiting via climb",
  },
  {
    phase: "VanishedEmpty",
    after: "released, the rung spent",
    task: task(
      "open",
      ["failed-by:cheap"],
      [authorRun("cheap", { open: false, ending: "vanished" })],
    ),
    step: "climb",
    at: "author waiting via climb",
  },
  {
    phase: "Blocked",
    after: "left claimed",
    task: task("in_progress", [], [authorRun("cheap")]),
    step: "none",
    at: "author running via start",
  },
  {
    phase: "ReviewWaiting",
    after: "the author's run closed handed off",
    task: task("reviewing", [], [authorDone("cheap", "c1")]),
    step: "review",
    at: "review waiting via review-gate",
  },
  {
    phase: "ReviewExpired",
    after: "the author's pane stopped",
    task: task("reviewing", [], [authorDone("cheap", "c1")]),
    step: "review",
    at: "review waiting via review-gate",
  },
  {
    phase: "ReviewStopped",
    after: "the review run ended without a verdict, a rung left",
    task: task("reviewing", [], [authorDone("cheap", "c1"), stoppedReview("cheap")]),
    step: "review",
    at: "review waiting via review-gate",
  },
  {
    phase: "ReviewStopped",
    after: "no reviewer left: released and parked",
    task: task("open", ["needs-you"], [authorDone("cheap", "c1"), stoppedReview("dear")]),
    step: "none",
    at: "author waiting via start",
  },
  {
    phase: "Residue",
    after: "its runs closed, still queued",
    task: task("open", [], [authorRun("cheap", { open: false, ending: "released" })]),
    step: "author",
    at: "author waiting via start",
  },
  {
    phase: "AuthorStopped",
    after: "released with one attempt",
    task: task(
      "open",
      ["attempt:cheap:1"],
      [authorRun("cheap", { open: false, ending: "stopped" })],
    ),
    step: "climb",
    at: "author waiting via climb",
  },
];

const LANDINGS: ReadonlyArray<{
  readonly result: Landing["_tag"];
  readonly after: string;
  readonly task: Item;
  readonly step: string;
  readonly at: string;
}> = [
  {
    result: "Merged",
    after: "completed",
    task: task("done", [], [authorDone("cheap", "c1"), approved()]),
    step: "none",
    at: "outside",
  },
  {
    result: "Present",
    after: "completed",
    task: task("done", [], [authorDone("cheap", "c1"), approved()]),
    step: "none",
    at: "outside",
  },
  {
    result: "Held",
    after: "still approved, the reviewer's run closed by settle",
    task: task("reviewing", [], [authorDone("cheap", "c1"), { ...approved(), open: false }]),
    step: "land",
    at: "land waiting via land-gate",
  },
  {
    result: "Rejected",
    after: "released with no evidence",
    task: task("open", [], [authorDone("cheap", "c1"), approved()]),
    step: "author",
    at: "author waiting via start",
  },
  {
    result: "Broke",
    after: "released, the author's rung failed",
    task: task("open", ["failed-by:cheap"], [authorDone("cheap", "c1"), approved()]),
    step: "climb",
    at: "author waiting via climb",
  },
];

/** Every step on `ask`, so each step the tick would take shows as an ask for it. */
const ASKING: Policy = {
  ...DEFAULT_POLICY,
  slots: 3,
  default: { author: "ask", climb: "ask", review: "ask", land: "ask" },
};

/** Where the task stands in the standard pipeline, in words. */
const at = (placement: Placement): string =>
  placement._tag === "Outside"
    ? "outside"
    : placement._tag === "Parked"
      ? `parked at ${placement.node}`
      : [
          placement.node.id,
          placement.state,
          ...placement.gates.map((gate) => `via ${gate.id}`),
        ].join(" ");

/** The step the placed plan takes: the queue and the review column, planned by placement. */
const placedStep = (item: Item): string => {
  const queue =
    item.status === "open"
      ? queueFrom({
          ready: [item],
          ladder: LADDER,
          projects: [item.project],
          epics: [],
          failed: new Set(),
          now: new Date(),
        }).queue
      : [];
  const review =
    item.status === "reviewing"
      ? reviewable(
          [{ task: item, worker: undefined, kind: reviewedBy(item) ?? authoredBy(item) }],
          new Set([item.id]),
        ).review
      : [];
  const steps = planFrom({
    workers: [],
    outOfQuota: new Set<string>(),
    queue,
    held: [],
    review,
    policy: ASKING,
    scopes: new Map<string, ReadonlySet<string>>(),
    pipelines: new Map([["foreman", { _tag: "Runs", pipeline: STANDARD_PIPELINE, drawn: false }]]),
    placed: [],
    dirty: new Set<string>(),
  }).asks.map(({ step }) => step);
  return steps.length === 0 ? "none" : steps.join(",");
};

describe("the next step after a run ends", () => {
  for (const row of PHASES) {
    test(`${row.phase} (${row.after}) → ${row.step} at ${row.at}`, () => {
      expect(at(place(STANDARD_PIPELINE, factsOf(row.task, STANDARD_PIPELINE)))).toBe(row.at);
      expect(placedStep(row.task)).toBe(row.step);
    });
  }
});

describe("the next step after a landing", () => {
  for (const row of LANDINGS) {
    test(`${row.result} (${row.after}) → ${row.step} at ${row.at}`, () => {
      expect(at(place(STANDARD_PIPELINE, factsOf(row.task, STANDARD_PIPELINE)))).toBe(row.at);
      expect(placedStep(row.task)).toBe(row.step);
    });
  }
});
