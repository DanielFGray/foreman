// Which writes an event on a task makes: one row of the joint table in
// `docs/task-and-run-machines.md`, decided from the task and foreman's rules
// alone. The dispatcher observes an event, asks `stepOf` for its row, has
// `Records.write` write it, and then does its own I/O. The pipeline tracer
// folds the same rows over a task held in memory with `applyRow`, so both read
// one copy of the rules.
import { Option } from "effect";
import type { Charge, CheckRun, Ending, NewRunInput, Run } from "tasks";
import { authoredBy, lapOf, reviewedBy, reviewFailedBy } from "./lap.ts";
import { authorFor, type Choice, type Ladder, levelSpent, levelPeers } from "./ladder.ts";
import { drawnBy, reviewerFor, type Reviewer, type Seats } from "./reviewers.ts";
import type { AgentNode, CheckNode, Exit, Pipeline } from "./pipeline.ts";
import { QUEUE } from "./pipeline.ts";
import { attemptsOf, failuresOf, isResearch, type Item, type TaskStatus } from "./records.ts";

/** What happened to a task: what the dispatcher observed, or what the tracer pretends. */
export type RunEvent =
  /** An author starts at its block: the task is claimed and its run opens. */
  | { readonly _tag: "AuthorStarted"; readonly run: NewRunInput }
  /** A new author replaces one whose pane vanished, whose run ends `vanished`. */
  | { readonly _tag: "AuthorReplaced"; readonly run: NewRunInput }
  /**
   * A reviewer starts, reading the tip its run records. The author's run
   * closes `done` at that tip, and a review run still open belongs to a
   * reviewer this one replaces, so it ends `released`.
   */
  | { readonly _tag: "ReviewStarted"; readonly run: NewRunInput }
  /** The agent of the open run names the exit with id `exit`, on the commit the task's tip is at. */
  | { readonly _tag: "ExitNamed"; readonly exit: string; readonly commit: string | undefined }
  /**
   * The pane of an agent that named an exit is idle: its exit is charged and
   * its runs close, an author that named none at the task's tip.
   */
  | { readonly _tag: "HandedOff"; readonly tip: string | undefined }
  /** A reviewer's exit sent the task back to the queue. */
  | { readonly _tag: "ReviewReturned" }
  /**
   * The task is back in the queue, and an agent's run is still open: an
   * author's exit wired to the queue, or a task reopened by hand.
   */
  | { readonly _tag: "Requeued" }
  /**
   * An agent sat idle past the stall grace without naming an exit. `who` names
   * it in the park reason, as the operator knows it.
   */
  | { readonly _tag: "Stalled"; readonly role: "author" | "review"; readonly who: string }
  /**
   * The author stopped with no exit and its block is not asked: its pane is
   * gone (`vanished`), or it handed back an empty branch (`stopped`).
   */
  | { readonly _tag: "Stopped"; readonly ending: "stopped" | "vanished" }
  /** An agent stopped on its account's usage wall. */
  | { readonly _tag: "Walled"; readonly role: "author" | "review" }
  /** A check block's command ran on the task's tip; `check` is the run it records. */
  | { readonly _tag: "Checked"; readonly block: CheckNode; readonly check: CheckRun }
  /** The task's work is in the operator's checkout: merged, already present, or done. */
  | { readonly _tag: "Landed" }
  /** The branch would not merge because the trunk moved after it was cut. */
  | { readonly _tag: "Conflicted" }
  /**
   * The operator closed the task's pull request without a merge, and the
   * project returns such a task to the queue at the same rung.
   */
  | { readonly _tag: "Withdrawn" }
  /** The merged branch broke the project's verification. */
  | { readonly _tag: "Broke" }
  /** The operator moves the task one rung up for its next author. */
  | { readonly _tag: "Climbed" };

/**
 * The rules a step reads: the ladder and the reviewers, the stop limit, and the
 * drawing the task runs in.
 */
export interface StepRules extends Seats {
  readonly attemptsPerLevel: number;
  readonly pipeline: Pipeline | undefined;
}

/** The status move a row makes, by the tracker's name for it. */
export type TrackerMove = "claim" | "reopen" | "complete";

/**
 * One row of the joint table: every write an event makes, which
 * `Records.write` makes in one transaction.
 */
export interface Row {
  readonly move: TrackerMove | undefined;
  /** Closes the open runs that have an ending for their role; an exit an agent named stands. */
  readonly close:
    | {
        readonly author?: Ending;
        readonly review?: Ending;
        /** The tip an author run that named no exit closes at. */
        readonly commit?: string | undefined;
      }
    | undefined;
  /** Names the exit of the open agent run by its id, with the commit it is named on. */
  readonly exit: { readonly ending: string; readonly commit: string | undefined } | undefined;
  /** A check run, written closed. */
  readonly check: CheckRun | undefined;
  /** The rungs charged with failing the task. */
  readonly charges: ReadonlyArray<string>;
  /** Why the task is parked for the operator. */
  readonly park: string | undefined;
  readonly open: NewRunInput | undefined;
  /** What landing made of the lap's author run. */
  readonly land: "committed" | "answered" | undefined;
}

/** A row, and what the dispatcher's log lines say about it. */
export interface RunStep {
  readonly row: Row;
  /** A climb: the rung charged for the work, and the author the ladder offers after it. */
  readonly climb: { readonly failed: string; readonly next: Choice } | undefined;
  /** A stop that retries: the rung it ran on and its attempts there, this one included. */
  readonly attempt: { readonly rung: string; readonly count: number } | undefined;
  /** A reviewer stop: the reviewer that read a voided approval, and the next reviewer, if any. */
  readonly reviewer:
    | {
        readonly ran: string | undefined;
        readonly said: boolean;
        readonly next: Reviewer | undefined;
      }
    | undefined;
}

/** The task fields a step reads. */
export type Stepping = Pick<Item, "id" | "labels" | "runs" | "charges">;

/** The row `event` writes on `task`, and what it means for the logs. */
export const stepOf = (task: Stepping, event: RunEvent, rules: StepRules): RunStep => {
  switch (event._tag) {
    case "AuthorStarted":
      return step({ move: "claim", open: event.run });
    case "AuthorReplaced":
      return step({ move: "claim", close: { author: "vanished" }, open: event.run });
    case "ReviewStarted":
      return step({
        close: { author: "done", review: "released", commit: event.run.commit },
        open: event.run,
      });
    case "ExitNamed":
      return named(task, event, rules);
    case "HandedOff":
      return adding(
        exitCharge(task, openAgentOf(rules.pipeline, task)?.run.rung ?? Option.none(), rules),
        {
          close: { author: "done", review: "stopped", commit: event.tip },
        },
      );
    case "ReviewReturned":
      // A reviewer is no rung, so a review exit charges only the author
      // (`fails: author`); validation refuses `fails: self` on a review block.
      return adding(exitCharge(task, Option.none(), rules), { close: { review: "released" } });
    case "Requeued":
      return step({ close: { author: "released", review: "released" } });
    case "Stalled":
      return stalled(task, event, rules);
    case "Stopped":
      return retry(task, event.ending, rules);
    case "Walled":
      return step(
        event.role === "author" ? releasing({ author: "walled" }) : { close: { review: "walled" } },
      );
    case "Checked":
      return checked(task, event, rules);
    case "Landed":
      return step({
        move: "complete",
        close: { author: "released", review: "released" },
        land: isResearch(task) ? "answered" : "committed",
      });
    case "Conflicted":
    case "Withdrawn":
      return step(releasing({}));
    case "Climbed":
      return climb(task, rules);
    case "Broke":
      return adding(climb(task, rules), releasing({}));
  }
};

/**
 * `task` after `row`, held in memory: what `Records.write` leaves in the
 * store. A new run's id is one above the task's newest, as the store's
 * autoincrement gives within one task.
 */
export const applyRow = <
  T extends Stepping & { readonly status: TaskStatus; readonly parked: string | undefined },
>(
  task: T,
  row: Row,
): T => {
  // A charge records the task's newest run when it is written: after the
  // check run, before the run the row opens.
  const ended = endedRuns(task, row);
  return {
    ...task,
    runs: landed(opened(task, ended, row.open), row.land),
    status: row.move === undefined ? task.status : STATUS_AFTER[row.move],
    charges: [
      ...task.charges,
      ...row.charges.map((rung): Charge => ({
        rung,
        run: Option.fromNullishOr(ended.at(-1)?.id),
        forgiven: false,
      })),
    ],
    parked: row.park ?? task.parked,
  };
};

/** What follows a stop with no exit at the block of the task's open run: `retry` unless it says `park`. */
export const stoppedAt = (
  pipeline: Pipeline | undefined,
  task: Pick<Item, "runs">,
): "retry" | "park" => openAgentOf(pipeline, task)?.block.stopped ?? "retry";

/**
 * The exit the agent of the task's open run named, as the drawing declares it
 * now: nothing when no agent named one, or the block or exit is gone.
 */
export const openExitOf = (
  pipeline: Pipeline | undefined,
  task: Pick<Item, "runs">,
): Exit | undefined => {
  const open = openAgentOf(pipeline, task);
  return open?.block.exits.find((exit) => Option.contains(open.run.ending, exit.id));
};

/** The task's open agent run and its block in the drawing, while that block is still an agent. */
export const openAgentOf = (
  pipeline: Pipeline | undefined,
  task: Pick<Item, "runs">,
): { readonly run: Run; readonly block: AgentNode } | undefined => {
  const run = task.runs.findLast((candidate) => candidate.open && candidate.role !== "check");
  const block = pipeline?.nodes.find(
    (node) => run !== undefined && Option.contains(run.node, node.id),
  );
  return run !== undefined && block?.kind === "agent" ? { run, block } : undefined;
};

/**
 * The rung whose run has just ended, which is the one a verdict is about.
 *
 * Read from the task rather than recomputed: the author run says which model
 * actually ran, while the ladder would answer with whichever rung is
 * available now — and the two differ exactly when an account went spent
 * mid-run, which is when charging the wrong model would be worst. A task
 * with no author recorded has never been dispatched, so the rung it would
 * get next is the honest answer.
 */
export const ranAt = (task: Pick<Item, "runs" | "charges">, ladder: Ladder): string => {
  const next = authorFor(ladder, failuresOf(task));
  return authoredBy(task) ?? (next._tag === "Dispatch" ? next.rung.name : ladder[0].name);
};

/** The row of an event that writes nothing. */
export const NO_WRITES: Row = {
  move: undefined,
  close: undefined,
  exit: undefined,
  check: undefined,
  charges: [],
  park: undefined,
  open: undefined,
  land: undefined,
};

const step = (row: Partial<Row>): RunStep => ({
  row: { ...NO_WRITES, ...row },
  climb: undefined,
  attempt: undefined,
  reviewer: undefined,
});

/** `stepped` with more parts of a row. */
const adding = (stepped: RunStep, row: Partial<Row>): RunStep => ({
  ...stepped,
  row: { ...stepped.row, ...row },
});

/** Names the exit on the open agent run; an exit wired to the queue reopens the task. */
const named = (
  task: Stepping,
  event: Extract<RunEvent, { _tag: "ExitNamed" }>,
  rules: StepRules,
): RunStep => {
  const exit = openAgentOf(rules.pipeline, task)?.block.exits.find(
    (candidate) => candidate.id === event.exit,
  );
  return step({
    exit: { ending: event.exit, commit: event.commit },
    move: exit?.to === QUEUE ? "reopen" : undefined,
  });
};

/** Charges what the exit the open agent run named says, `self` being `rung`. */
const exitCharge = (task: Stepping, rung: Option.Option<string>, rules: StepRules): RunStep =>
  charge(task, openExitOf(rules.pipeline, task)?.fails, rung, rules);

/**
 * An agent idle past the stall grace with no exit: parked when its block says
 * `park`, else a reviewer stop or an author retry.
 */
const stalled = (
  task: Stepping,
  event: Extract<RunEvent, { _tag: "Stalled" }>,
  rules: StepRules,
): RunStep => {
  if (stoppedAt(rules.pipeline, task) === "park") {
    return step({
      ...releasing({ author: "stopped", review: "stopped" }),
      park: `${event.who} stopped without naming an exit`,
    });
  }
  return event.role === "review" ? reviewerStop(task, rules) : retry(task, "stopped", rules);
};

/**
 * A check run, written closed. A failure charges what the block's `failed`
 * exit says, and a `failed` wire to the queue releases the task; a wire
 * elsewhere moves it with no write at all.
 */
const checked = (
  task: Stepping,
  event: Extract<RunEvent, { _tag: "Checked" }>,
  rules: StepRules,
): RunStep => {
  if (event.check.ending === "passed") return step({ check: event.check });
  const failed = event.block.exits.find((candidate) => candidate.id === "failed");
  return adding(charge(task, failed?.fails, Option.none(), rules), {
    check: event.check,
    ...(failed?.to === QUEUE ? releasing({}) : {}),
  });
};

/** The status each tracker move leaves. */
const STATUS_AFTER: Record<TrackerMove, TaskStatus> = {
  claim: "in_progress",
  reopen: "open",
  complete: "done",
};

/** The task's runs after the row closes runs, names an exit and records a check. */
const endedRuns = (task: Stepping, row: Row): ReadonlyArray<Run> => {
  const closedRuns =
    row.close === undefined ? task.runs : task.runs.map((run) => closed(run, row.close!));
  const named = row.exit === undefined ? closedRuns : namedExit(closedRuns, row.exit);
  if (row.check === undefined) return named;
  return [
    ...named,
    {
      id: nextId(named),
      task: task.id,
      role: "check",
      rung: Option.none(),
      node: Option.some(row.check.node),
      commit: Option.some(row.check.commit),
      base: Option.none(),
      ending: Option.some(row.check.ending),
      rounds: Option.none(),
      open: false,
      landed: false,
    },
  ];
};

/** Writes the exit and its commit on the newest open agent run. */
const namedExit = (runs: ReadonlyArray<Run>, exit: NonNullable<Row["exit"]>) => {
  const open = runs.findLast((run) => run.open && run.role !== "check");
  return runs.map((run) =>
    run === open
      ? {
          ...run,
          ending: Option.some(exit.ending),
          commit: Option.orElse(Option.fromNullishOr(exit.commit), () => run.commit),
        }
      : run,
  );
};

/** `runs` with the run `open` describes, open. */
const opened = (task: Stepping, runs: ReadonlyArray<Run>, open: NewRunInput | undefined) =>
  open === undefined
    ? runs
    : [
        ...runs,
        {
          id: nextId(runs),
          task: task.id,
          role: open.work === "review" ? ("review" as const) : ("author" as const),
          rung: Option.fromNullishOr(open.rung),
          node: Option.some(open.node),
          commit: Option.fromNullishOr(open.commit),
          base: Option.fromNullishOr(open.base),
          ending: Option.none(),
          rounds: Option.fromNullishOr(open.rounds),
          open: true,
          landed: false,
        },
      ];

/** Marks the newest author run landed, when it has closed. */
const landed = (runs: ReadonlyArray<Run>, land: Row["land"]) => {
  if (land === undefined) return runs;
  const author = runs.findLast((run) => run.role === "author");
  return runs.map((run) => (run === author && !run.open ? { ...run, landed: true } : run));
};

/** A new run's id: one above the task's newest, as the store's autoincrement gives within one task. */
const nextId = (runs: ReadonlyArray<Run>) => (runs.at(-1)?.id ?? 0) + 1;

/** Closes the open runs, `released` unless `endings` names another, and requeues the task. */
const releasing = (endings: {
  readonly author?: Ending;
  readonly review?: Ending;
}): Partial<Row> => ({
  move: "reopen",
  close: { author: endings.author ?? "released", review: endings.review ?? "released" },
});

/**
 * Charges the rung a named exit's `fails` names: `author` the task's last
 * author run's rung, as a climb does; `self` the rung of the block that named
 * it, `rung`. An exit with no `fails`, or a `self` with no rung (a check),
 * charges nothing.
 */
const charge = (
  task: Stepping,
  fails: Exit["fails"],
  rung: Option.Option<string>,
  rules: StepRules,
): RunStep =>
  fails === "author"
    ? climb(task, rules)
    : fails === "self" && Option.isSome(rung)
      ? step({ charges: [rung.value] })
      : step({});

/** Charges the rung that just ran with failing the task, and reads the author the ladder offers next. */
const climb = (task: Stepping, rules: StepRules): RunStep => {
  const failed = ranAt(task, rules.ladder);
  return {
    ...step({ charges: [failed] }),
    climb: { failed, next: authorFor(rules.ladder, [...failuresOf(task), failed]) },
  };
};

/**
 * An author that stopped without finishing, which has said nothing about its
 * rung: the task returns to the queue at the same level, where the next turn
 * may fall to a peer, until the stop that spends the level's
 * `attemptsPerLevel`, which charges the rung that ran and climbs. The release
 * closes the run with `ending`, which is what counts it (`attemptsOf`), and
 * the climb's charge ends the count.
 */
const retry = (task: Stepping, ending: Ending, rules: StepRules): RunStep => {
  const rung = ranAt(task, rules.ladder);
  const count = attemptsOf(task, levelPeers(rules.ladder, rung)) + 1;
  const spent = levelSpent(count, rules.attemptsPerLevel);
  const climbed = spent ? climb(task, rules) : step({});
  return { ...adding(climbed, releasing({ author: ending })), attempt: { rung, count } };
};

/**
 * A reviewer that stopped without a verdict, which is the reviewer's failure,
 * not the author's: the task stays in review for the next reviewer of its
 * block (`reviewerFor`), passing over every reviewer that stopped this lap.
 * With none left, the task is released and parked. A reviewer that named an
 * exit has not failed, even when a later commit voided it: the same reviewer
 * may read the new tip.
 */
const reviewerStop = (task: Stepping, rules: StepRules): RunStep => {
  const ran = reviewedBy(task);
  const said = lapOf(task).some(
    (run) => run.role === "review" && run.open && Option.isSome(run.ending),
  );
  const failed = [...reviewFailedBy(task), ...(ran === undefined || said ? [] : [ran])];
  const rule = openAgentOf(rules.pipeline, task)?.block.model ?? "reviewers";
  const author = rules.ladder.find((rung) => rung.name === authoredBy(task));
  const choice = reviewerFor(drawnBy(rules.reviewers, rule), author, new Set(), failed);
  const next = choice._tag === "Dispatch" ? choice.reviewer : undefined;
  const row: Partial<Row> =
    next === undefined
      ? {
          ...releasing({ review: "stopped" }),
          park: `reviewer ${ran ?? "the reviewer"} stopped without a verdict, and no reviewer is left`,
        }
      : { close: { review: "stopped" } };
  return { ...step(row), reviewer: { ran, said, next } };
};

/** A run after `close`: closed with its role's ending, keeping an exit its agent named. */
const closed = (run: Run, close: NonNullable<Row["close"]>): Run => {
  const ending =
    run.role === "review" ? close.review : run.role === "author" ? close.author : undefined;
  if (!run.open || ending === undefined) return run;
  const named = Option.isSome(run.ending);
  return {
    ...run,
    open: false,
    ending: Option.orElse(run.ending, () => Option.some(ending)),
    commit:
      !named && run.role === "author"
        ? Option.orElse(Option.fromNullishOr(close.commit), () => run.commit)
        : run.commit,
  };
};
