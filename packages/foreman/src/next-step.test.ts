import { describe, expect, test } from "bun:test";
import type { Run } from "tasks";
import { dispatchesFor, landAsks, reviewable } from "./dispatcher.ts";
import type { Ladder } from "./ladder.ts";
import { authoredBy, reviewedBy } from "./lap.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";
import type { Item, TaskStatus } from "./prog.ts";
import { queueFrom } from "./queue.ts";
import type { Landing } from "./repository.ts";
import type { TaskPhase } from "./task-phase.ts";
import { authorRun, handedOff, reviewRun, withRuns } from "./task-fixture.ts";

/**
 * The step a task takes next after each way settle can find a run ended, and
 * after each verdict a landing can return.
 *
 * Each row is the task as settle or land leaves it, and the step the tick
 * takes from there: `author` or `climb` for an author, `review`, `land`, or
 * `none` when no step is due (the task is done, parked, or its run is still
 * going).
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

/** A reviewer whose run ended without a verdict. */
const noVerdict = (rung: string): Run => reviewRun(rung, { open: false, ending: "no-verdict" });

const PHASES: ReadonlyArray<{
  readonly phase: TaskPhase;
  readonly after: string;
  readonly task: Item;
  readonly step: string;
}> = [
  { phase: "Landed", after: "done", task: task("done", [], [handedOff("cheap")]), step: "none" },
  {
    phase: "Canceled",
    after: "canceled",
    task: task("canceled", [], [authorRun("cheap", { open: false, ending: "canceled" })]),
    step: "none",
  },
  {
    phase: "ReviewReturned",
    after: "released, the author's rung failed",
    task: task("open", ["failed-by:cheap"], [handedOff("cheap"), returned()]),
    step: "climb",
  },
  {
    phase: "VanishedAttached",
    after: "left claimed",
    task: task("in_progress", [], [authorRun("cheap")]),
    step: "none",
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
  },
  {
    phase: "Blocked",
    after: "left claimed",
    task: task("in_progress", [], [authorRun("cheap")]),
    step: "none",
  },
  {
    phase: "ReviewWaiting",
    after: "the author's run closed handed off",
    task: task("reviewing", [], [handedOff("cheap", "c1")]),
    step: "review",
  },
  {
    phase: "ReviewExpired",
    after: "the author's pane stopped",
    task: task("reviewing", [], [handedOff("cheap", "c1")]),
    step: "review",
  },
  {
    phase: "ReviewStopped",
    after: "the review run ended without a verdict, a rung left",
    task: task("reviewing", [], [handedOff("cheap", "c1"), noVerdict("cheap")]),
    step: "review",
  },
  {
    phase: "ReviewStopped",
    after: "no reviewer left: released and parked",
    task: task("open", ["needs-you"], [handedOff("cheap", "c1"), noVerdict("dear")]),
    step: "none",
  },
  {
    phase: "Residue",
    after: "its runs closed, still queued",
    task: task("open", [], [authorRun("cheap", { open: false, ending: "released" })]),
    step: "author",
  },
  {
    phase: "Unfinished",
    after: "released with one attempt",
    task: task(
      "open",
      ["attempt:cheap:1"],
      [authorRun("cheap", { open: false, ending: "unfinished" })],
    ),
    step: "climb",
  },
];

const VERDICTS: ReadonlyArray<{
  readonly verdict: Landing["_tag"];
  readonly after: string;
  readonly task: Item;
  readonly step: string;
}> = [
  {
    verdict: "Merged",
    after: "completed",
    task: task("done", [], [handedOff("cheap", "c1"), approved()]),
    step: "none",
  },
  {
    verdict: "Present",
    after: "completed",
    task: task("done", [], [handedOff("cheap", "c1"), approved()]),
    step: "none",
  },
  {
    verdict: "Held",
    after: "still approved",
    task: task("reviewing", [], [handedOff("cheap", "c1"), approved()]),
    step: "land",
  },
  {
    verdict: "Rejected",
    after: "released with no evidence",
    task: task("open", [], [handedOff("cheap", "c1"), approved()]),
    step: "author",
  },
  {
    verdict: "Broke",
    after: "released, the author's rung failed",
    task: task("open", ["failed-by:cheap"], [handedOff("cheap", "c1"), approved()]),
    step: "climb",
  },
];

/** Every step on `ask`, so each step the tick would take shows as an ask for it. */
const ASKING: Policy = {
  ...DEFAULT_POLICY,
  slots: 3,
  default: { author: "ask", climb: "ask", review: "ask", land: "ask" },
};

/** The step the fixed flow takes: the queue's author step, the review pass, or a landing. */
const fixedStep = (item: Item): string => {
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
  const state = {
    workers: [],
    outOfQuota: new Set<string>(),
    queue,
    held: [],
    review,
    policy: ASKING,
    scopes: new Map<string, ReadonlySet<string>>(),
  };
  const steps = [...dispatchesFor(state).asks, ...landAsks(state)].map(({ step }) => step);
  return steps.length === 0 ? "none" : steps.join(",");
};

describe("the next step after a run ends", () => {
  for (const row of PHASES) {
    test(`${row.phase} (${row.after}) → ${row.step}`, () => {
      expect(fixedStep(row.task)).toBe(row.step);
    });
  }
});

describe("the next step after a landing", () => {
  for (const row of VERDICTS) {
    test(`${row.verdict} (${row.after}) → ${row.step}`, () => {
      expect(fixedStep(row.task)).toBe(row.step);
    });
  }
});
