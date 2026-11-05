import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import type { Run } from "tasks";
import { planFrom, reviewable } from "./dispatcher.ts";
import type { Ladder } from "./ladder.ts";
import { authoredBy, reviewedBy } from "./lap.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";
import { isUnderReview, place, type Placement, STANDARD_PIPELINES } from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";
import type { Item, TaskStatus } from "./records.ts";
import { queueFrom } from "./queue.ts";
import type { Landing } from "./repository.ts";
import type { TaskPhase } from "./task-phase.ts";
import { authorRun, authorDone, charged, reviewRun, withRuns } from "./task-fixture.ts";

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
 * A parked task is placed waiting at the author, and takes no
 * step because the queue leaves it out for the operator.
 */

const LADDER: Ladder = [
  {
    name: "cheap",
    harness: "test",
    level: 0,
    model: undefined,
    provider: undefined,
    enabled: true,
    author: true,
    unmetered: false,
  },
  {
    name: "dear",
    harness: "test",
    level: 1,
    model: undefined,
    provider: undefined,
    enabled: true,
    author: true,
    unmetered: false,
  },
];

/**
 * The task with these runs, charged on each rung in `failedBy` after them (as
 * settle charges a rung once its run has closed), and parked when `parked` says why.
 */
const task = (
  status: TaskStatus,
  marks: { readonly failedBy?: ReadonlyArray<string>; readonly parked?: string },
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
      labels: [],
      description: "",
      parent: Option.none(),
      lastActivityAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(0),
      definitionOfDone: Option.none(),
      runs: [],
      charges: (marks.failedBy ?? []).map((rung) => charged(rung, runs.at(-1)?.id)),
      parked: marks.parked,
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
    task: task("done", {}, [authorDone("cheap")]),
    step: "none",
    at: "outside",
  },
  {
    phase: "Canceled",
    after: "canceled",
    task: task("canceled", {}, [authorRun("cheap", { open: false, ending: "canceled" })]),
    step: "none",
    at: "outside",
  },
  {
    phase: "ReviewReturned",
    after: "released, the author's rung failed",
    task: task("open", { failedBy: ["cheap"] }, [authorDone("cheap"), returned()]),
    step: "climb",
    at: "author waiting via climb",
  },
  {
    phase: "VanishedAttached",
    after: "left claimed",
    task: task("in_progress", {}, [authorRun("cheap")]),
    step: "none",
    at: "author running via start",
  },
  {
    phase: "VanishedWithWork",
    after: "released with one attempt",
    task: task("open", {}, [authorRun("cheap", { open: false, ending: "vanished" })]),
    step: "climb",
    at: "author waiting via climb",
  },
  {
    phase: "VanishedEmpty",
    after: "released, the rung spent",
    task: task("open", { failedBy: ["cheap"] }, [
      authorRun("cheap", { open: false, ending: "vanished" }),
    ]),
    step: "climb",
    at: "author waiting via climb",
  },
  {
    phase: "Blocked",
    after: "left claimed",
    task: task("in_progress", {}, [authorRun("cheap")]),
    step: "none",
    at: "author running via start",
  },
  {
    phase: "ReviewWaiting",
    after: "the author's run closed handed off",
    task: task("in_progress", {}, [authorDone("cheap", "c1")]),
    step: "review",
    at: "review waiting via review-gate",
  },
  {
    phase: "ReviewExpired",
    after: "the author's pane stopped",
    task: task("in_progress", {}, [authorDone("cheap", "c1")]),
    step: "review",
    at: "review waiting via review-gate",
  },
  {
    phase: "ReviewStopped",
    after: "the review run ended without a verdict, a rung left",
    task: task("in_progress", {}, [authorDone("cheap", "c1"), stoppedReview("cheap")]),
    step: "review",
    at: "review waiting via review-gate",
  },
  {
    phase: "ReviewStopped",
    after: "no reviewer left: released and parked",
    task: task("open", { parked: "no reviewer rung is left" }, [
      authorDone("cheap", "c1"),
      stoppedReview("dear"),
    ]),
    step: "none",
    at: "author waiting via start",
  },
  {
    phase: "Residue",
    after: "its runs closed, still queued",
    task: task("open", {}, [authorRun("cheap", { open: false, ending: "released" })]),
    step: "author",
    at: "author waiting via start",
  },
  {
    phase: "AuthorStopped",
    after: "released with one attempt",
    task: task("open", {}, [authorRun("cheap", { open: false, ending: "stopped" })]),
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
    task: task("done", {}, [authorDone("cheap", "c1"), approved()]),
    step: "none",
    at: "outside",
  },
  {
    result: "Present",
    after: "completed",
    task: task("done", {}, [authorDone("cheap", "c1"), approved()]),
    step: "none",
    at: "outside",
  },
  {
    result: "Held",
    after: "still approved, the reviewer's run closed by settle",
    task: task("in_progress", {}, [authorDone("cheap", "c1"), { ...approved(), open: false }]),
    step: "land",
    at: "land waiting via land-gate",
  },
  {
    result: "Rejected",
    after: "released with no evidence",
    task: task("open", {}, [authorDone("cheap", "c1"), approved()]),
    step: "author",
    at: "author waiting via start",
  },
  {
    result: "Broke",
    after: "released, the author's rung failed",
    task: task("open", { failedBy: ["cheap"] }, [authorDone("cheap", "c1"), approved()]),
    step: "climb",
    at: "author waiting via climb",
  },
];

/** Every step on `ask`, so each step the tick would take shows as an ask for it. */
const ASKING: Policy = {
  ...DEFAULT_POLICY,
  slots: 3,
  default: { author: "ask", climb: "ask", review: "ask", publish: "off", land: "ask" },
};

/** Where the task stands in the standard pipeline, in words. */
const at = (placement: Placement): string =>
  placement._tag === "Outside"
    ? "outside"
    : placement._tag === "Parked" || placement._tag === "ExitGone"
      ? `${placement._tag === "Parked" ? "parked" : "exit gone"} at ${placement.node}`
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
  // Under review when placement puts the task past the author's running turn.
  const placement = place(STANDARD_PIPELINES.worktree, factsOf(item, STANDARD_PIPELINES.worktree));
  const review = isUnderReview(placement)
    ? reviewable(
        [{ task: item, worker: undefined, kind: reviewedBy(item) ?? authoredBy(item) }],
        new Set([item.id]),
        new Map([
          [item.project, { _tag: "Runs", pipeline: STANDARD_PIPELINES.worktree, drawn: false }],
        ]),
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
    pipelines: new Map([
      ["foreman", { _tag: "Runs", pipeline: STANDARD_PIPELINES.worktree, drawn: false }],
    ]),
    placed: [],
    dirty: new Set<string>(),
    pullRequests: new Map(),
  }).asks.map(({ step }) => step);
  return steps.length === 0 ? "none" : steps.join(",");
};

describe("the next step after a run ends", () => {
  for (const row of PHASES) {
    test(`${row.phase} (${row.after}) → ${row.step} at ${row.at}`, () => {
      expect(
        at(place(STANDARD_PIPELINES.worktree, factsOf(row.task, STANDARD_PIPELINES.worktree))),
      ).toBe(row.at);
      expect(placedStep(row.task)).toBe(row.step);
    });
  }
});

describe("the next step after a landing", () => {
  for (const row of LANDINGS) {
    test(`${row.result} (${row.after}) → ${row.step} at ${row.at}`, () => {
      expect(
        at(place(STANDARD_PIPELINES.worktree, factsOf(row.task, STANDARD_PIPELINES.worktree))),
      ).toBe(row.at);
      expect(placedStep(row.task)).toBe(row.step);
    });
  }
});
