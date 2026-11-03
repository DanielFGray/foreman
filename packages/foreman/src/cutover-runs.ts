import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { closeRun, openRun, Tasks, type Ending, type NewRun } from "tasks";
import { labelFor } from "./fleet.ts";
import { providerOf, type Ladder } from "./ladder.ts";
import { countOf, type Item } from "./records.ts";
import { readLadder } from "./registry.ts";
import { Repository } from "./repository.ts";
import { newRunFor } from "./run-record.ts";

/**
 * The one-time conversion from the labels foreman wrote before runs to runs.
 *
 * Before runs, foreman recorded what its agents did as labels on the task. The
 * label names live here and nowhere else: after the conversion nothing writes
 * or reads them. A task that is done or canceled keeps its labels as history.
 */

const BY = "by:";
const REVIEW_BY = "review-by:";
const REVIEW_FAILED_BY = "review-failed-by:";
const ROUNDS = "rounds";
const APPROVED = "approved";
const SATISFIED = "satisfied";

/** Placeholder for the model and pool of a rung the ladder no longer has. */
const UNKNOWN = "unknown";

/** One run the conversion writes. `ending` is absent for an open run. */
export interface PlannedRun {
  readonly run: NewRun;
  readonly ending?: Ending;
  /** The author run's tip when it closes; a review run already carries its own. */
  readonly closeCommit?: string;
}

/** What the conversion finds on one task and what it writes for it. */
export interface Plan {
  readonly task: string;
  /** The labels this conversion removes. */
  readonly labels: ReadonlyArray<string>;
  readonly runs: ReadonlyArray<PlannedRun>;
  /** The rungs the ladder no longer has. */
  readonly unknownRungs: ReadonlyArray<string>;
  /** The runs that need the branch tip, and the branch is gone. */
  readonly branchGone: boolean;
  /** Labels that name a run the task cannot have, so they are removed with no run. */
  readonly dropped: ReadonlyArray<string>;
}

/** The labels of the six kinds, which is all the conversion touches. */
const isOld = (label: string): boolean =>
  label.startsWith(BY) ||
  label.startsWith(REVIEW_BY) ||
  label.startsWith(REVIEW_FAILED_BY) ||
  label.startsWith(`${ROUNDS}:`) ||
  label === APPROVED ||
  label === SATISFIED;

/** The suffixes of the labels that start with `prefix`. */
const after = (labels: ReadonlyArray<string>, prefix: string): ReadonlyArray<string> =>
  labels.flatMap((label) => (label.startsWith(prefix) ? [label.slice(prefix.length)] : []));

/**
 * What runs a task's old labels stand for, oldest first so that the author run
 * opens its lap: the author, the reviewers that failed, the approval, then the
 * reviewer still at work.
 *
 * `tip` is the branch tip, or nothing when the branch is gone. A run converted
 * without a commit never matches the tip, so an `approved` on a task whose
 * branch is gone no longer holds.
 */
export const planOf = (
  task: Pick<Item, "id" | "title" | "project" | "status" | "labels">,
  ladder: Ladder,
  tip: string | undefined,
): Plan => {
  const labels = task.labels.filter(isOld);
  const unknownRungs: Array<string> = [];
  const dropped: Array<string> = [];

  // `rung` is empty for an approval: that label names no reviewer.
  const run = (rung: string | undefined, role: "author" | "review", commit?: string): NewRun => {
    const known = ladder.find((candidate) => candidate.name === rung);
    if (known === undefined) unknownRungs.push(rung ?? `${APPROVED} (reviewer not recorded)`);
    return {
      ...newRunFor({
        task,
        branch: labelFor(task.id),
        harness: known?.harness ?? UNKNOWN,
        model: known?.model ?? UNKNOWN,
        rung: rung ?? UNKNOWN,
        provider: known === undefined ? undefined : providerOf(known),
        role,
        // Old labels predate drawn pipelines: every task ran the standard
        // pipeline, whose agent blocks are named after their roles.
        node: role,
        commit,
      }),
      rung,
    };
  };

  const planned: Array<PlannedRun> = [];

  // Only work in flight has a lap to keep. On a task back in the queue, `by:`
  // names an attempt that was released, not handed off, and nothing reads it:
  // the next author is chosen from `failed-by`, which stays a label. A run made
  // up for it would pass the author block and count in the model statistics.
  if (task.status !== "in_progress") {
    return {
      task: task.id,
      labels,
      runs: [],
      unknownRungs: [],
      branchGone: false,
      dropped: labels,
    };
  }

  // An open author run is work still being written. Handoff evidence used to
  // be the `reviewing` status; with six statuses it is the review labels.
  const open =
    !labels.includes(SATISFIED) &&
    !labels.includes(APPROVED) &&
    !labels.some((label) => label.startsWith(REVIEW_BY));
  const [author] = after(labels, BY);
  if (author !== undefined) {
    const rounds = countOf({ labels }, ROUNDS);
    planned.push({
      run: { ...run(author, "author"), rounds: rounds === 0 ? undefined : rounds },
      ...(open
        ? {}
        : {
            ending: labels.includes(SATISFIED) ? "already-done" : "done",
            closeCommit: tip,
          }),
    });
  } else {
    dropped.push(
      ...labels.filter((label) => label === SATISFIED || label.startsWith(`${ROUNDS}:`)),
    );
  }
  if (open && labels.includes(SATISFIED)) dropped.push(SATISFIED);

  for (const rung of after(labels, REVIEW_FAILED_BY)) {
    planned.push({ run: run(rung, "review"), ending: "stopped" });
  }
  if (labels.includes(APPROVED)) {
    planned.push({ run: run(undefined, "review", tip), ending: "approved" });
  }
  for (const rung of after(labels, REVIEW_BY)) {
    planned.push({ run: run(rung, "review", tip) });
  }

  return {
    task: task.id,
    labels,
    runs: planned,
    unknownRungs: [...new Set(unknownRungs)],
    branchGone: tip === undefined && planned.some(needsTip),
    dropped,
  };
};

/** A run records the tip when it reads one (review) or hands one off (a closed author run). */
const needsTip = ({ run, ending }: PlannedRun): boolean =>
  run.work === "review" ? ending !== "stopped" : ending !== undefined;

/** What `convert` did, task by task. */
export interface Report {
  readonly plans: ReadonlyArray<Plan>;
  /** Whether the runs were written. A dry run only plans. */
  readonly written: boolean;
}

/**
 * Converts every task that is not done or canceled and still carries old labels.
 *
 * Each task converts in one transaction: its runs are written and its labels
 * removed together, so a failure leaves the task as it was and a second run
 * finds no labels to convert. `root` holds the project checkouts, one folder
 * per project, as `Project.directory` names them.
 */
export const convert = (options: { readonly root: string; readonly dryRun: boolean }) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* Repository;
    const ladder = yield* readLadder;

    const all = yield* tasks.list({});
    const pending = all.filter(
      (task) =>
        task.type === "task" &&
        task.status !== "done" &&
        task.status !== "canceled" &&
        task.labels.some(isOld),
    );

    const plans: Array<Plan> = [];
    for (const task of pending) {
      // A checkout that cannot be read answers like a branch that is gone: the
      // task still converts, without a commit, and the report lists it.
      const tip = yield* repository
        .tip(join(options.root, task.project), labelFor(task.id))
        .pipe(Effect.orElseSucceed(() => undefined));
      const plan = planOf(task, ladder, tip);
      plans.push(plan);
      if (options.dryRun) continue;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const { run, ending, closeCommit } of plan.runs) {
            const id = yield* openRun(run);
            if (ending !== undefined) {
              yield* closeRun(id, {
                ending,
                ...(closeCommit === undefined ? {} : { commit: closeCommit }),
              });
            }
          }
          for (const label of plan.labels) yield* tasks.unlabel(task.id, label);
        }),
      );
    }
    return { plans, written: !options.dryRun } satisfies Report;
  });

/** The report as the lines `foreman cutover runs` prints. */
export const reportLines = ({ plans, written }: Report): ReadonlyArray<string> => {
  const verb = written ? "wrote" : "would write";
  const lines = plans.flatMap((plan) => [
    `${plan.task}: ${plan.labels.join(" ")}`,
    ...plan.runs.map(
      ({ run, ending }) =>
        `  ${verb} ${run.work} run on ${run.rung ?? "?"} ${ending ?? "open"}${run.commit === undefined ? "" : ` at ${run.commit.slice(0, 8)}`}`,
    ),
    ...plan.dropped.map((label) => `  removes ${label}: no run stands for it`),
  ]);
  const unknown = plans.filter((plan) => plan.unknownRungs.length > 0);
  const gone = plans.filter((plan) => plan.branchGone);
  return [
    ...lines,
    ...(unknown.length === 0
      ? []
      : [
          "",
          "rungs the ladder no longer has (model and pool are unknown):",
          ...unknown.map((plan) => `  ${plan.task}: ${plan.unknownRungs.join(" ")}`),
        ]),
    ...(gone.length === 0
      ? []
      : [
          "",
          "branch gone, converted without a commit (an approval on it no longer holds):",
          ...gone.map((plan) => `  ${plan.task}`),
        ]),
    "",
    `${plans.length} task${plans.length === 1 ? "" : "s"} ${written ? "converted" : "to convert"}`,
  ];
};
