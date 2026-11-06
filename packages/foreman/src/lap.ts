import { Option } from "effect";
import { isExit, type Run } from "tasks";
import { type Drawing, type Exit, engineOf, exitAt } from "./pipeline.ts";

/**
 * What foreman reads off a task's runs.
 *
 * A **lap** is the task's latest author run and every run after it. Each review
 * fact reads only the current lap, so a new author run leaves everything the
 * last reviews said behind with no code that clears it. A task with no author
 * run (work launched by hand) has one lap: all its runs.
 */
interface Runs {
  readonly runs: ReadonlyArray<Run>;
}

/** The runs of the current lap, oldest first. */
export const lapOf = ({ runs }: Runs): ReadonlyArray<Run> => {
  const start = runs.findLastIndex((run) => run.role === "author");
  return start < 0 ? runs : runs.slice(start);
};

/** The rung of the task's latest author run: who authored its branch. Empty before any author ran. */
const lastAuthor = (task: Runs): Option.Option<Run> =>
  Option.fromNullishOr(task.runs.findLast((run) => run.role === "author"));

export const authoredBy = (task: Runs): string | undefined =>
  lastAuthor(task).pipe(
    Option.flatMap((run) => run.rung),
    Option.getOrUndefined,
  );

/** The correction rounds the current author has been sent. */
export const roundsOf = (task: Runs): number =>
  lastAuthor(task).pipe(
    Option.flatMap((run) => run.rounds),
    Option.getOrElse(() => 0),
  );

/** The name of the lap's open review run: the reviewer that owns the task now. */
export const reviewedBy = (task: Runs): string | undefined =>
  Option.fromNullishOr(lapOf(task).find((run) => run.role === "review" && run.open)).pipe(
    Option.flatMap((run) => run.rung),
    Option.getOrUndefined,
  );

/** The reviewers that stopped this lap without naming an exit. */
export const reviewFailedBy = (task: Runs): ReadonlyArray<string> =>
  lapOf(task).flatMap((run) =>
    run.role === "review" && Option.contains(run.ending, "stopped") ? Option.toArray(run.rung) : [],
  );

/** The lap's last run that named an exit: the one that placed the task where it is. */
export const lastExit = (task: Runs): Run | undefined =>
  lapOf(task).findLast((run) => Option.exists(run.ending, isExit));

/**
 * The commit a land or a done takes: the one the exit that routed the task
 * there was named on. Landing merges this commit by id, and refuses a tip that
 * has moved past it.
 */
export const routedCommit = (task: Runs): string | undefined =>
  Option.fromNullishOr(lastExit(task)).pipe(
    Option.flatMap((run) => run.commit),
    Option.getOrUndefined,
  );

/** The rung of the run that named the exit that placed the task where it is. */
export const routedRung = (task: Runs): string | undefined =>
  Option.fromNullishOr(lastExit(task)).pipe(
    Option.flatMap((run) => run.rung),
    Option.getOrUndefined,
  );

/** Whether the open reviewer named its exit, and settle has not yet closed its run. */
export const reviewerNamed = (task: Runs): boolean =>
  lapOf(task).some((run) => run.role === "review" && run.open && Option.isSome(run.ending));

/**
 * The commit a task working on the operator's branch started from: the base
 * its first such author run recorded. Every later author continues on top of
 * that work (a return has no undo there), so a reviewer reads all of it.
 */
export const directBase = (task: Runs): string | undefined =>
  Option.fromNullishOr(
    task.runs.find((run) => run.role === "author" && Option.isSome(run.base)),
  ).pipe(
    Option.flatMap((run) => run.base),
    Option.getOrUndefined,
  );

/**
 * The claim exit the lap's author named, as drawn now: its claim that the
 * trunk already does what the task asks, or nothing when it made none.
 *
 * A backlog outlives the code it describes: work gets done under another
 * task's branch, or by hand, and the entry for it stays open. An author sent
 * to one of those has nothing to write, and every ending it can reach says
 * something false. Committing anything at all fabricates work; stopping is
 * read as a crash, which costs a rung and dispatches the same discovery again
 * at a more expensive model, forever.
 *
 * So the finding is a claim the author records by naming its block's claim
 * exit (`empty: claim`, `already-done` in the standard pipelines), and the
 * branch it hands over is legitimately empty. The property, not the name,
 * makes the claim, so a rename keeps it; the prompt explains the exit, under
 * its name as drawn, only to a block that declares one (`exitsSection` in
 * `src/prompt.ts`).
 *
 * It is a claim: "it is already done" is exactly what a model too weak for the
 * task would say to escape it, so a reviewer confirms it against the trunk
 * like any other diff, and only the reviewer's approval closes the task.
 */
export const authorClaim = (task: Runs, drawing: Drawing): Exit | undefined => {
  const author = lapOf(task).find((run) => run.role === "author");
  const exit = exitAt(
    engineOf(drawing),
    Option.getOrUndefined(author?.node ?? Option.none()),
    Option.getOrUndefined(author?.ending ?? Option.none()),
  );
  return exit?.empty === "claim" ? exit : undefined;
};
