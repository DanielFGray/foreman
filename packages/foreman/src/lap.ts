import { isExit, type Run } from "tasks";
import { ALREADY_DONE } from "./pipeline.ts";

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
export const authoredBy = (task: Runs): string | undefined =>
  task.runs.findLast((run) => run.role === "author")?.rung;

/** The correction rounds the current author has been sent. */
export const roundsOf = (task: Runs): number =>
  task.runs.findLast((run) => run.role === "author")?.rounds ?? 0;

/** The name of the lap's open review run: the reviewer that owns the task now. */
export const reviewedBy = (task: Runs): string | undefined =>
  lapOf(task).find((run) => run.role === "review" && run.open)?.rung;

/** The reviewers that stopped this lap without naming an exit. */
export const reviewFailedBy = (task: Runs): ReadonlyArray<string> =>
  lapOf(task).flatMap((run) =>
    run.role === "review" && run.ending === "stopped" && run.rung !== undefined ? [run.rung] : [],
  );

/** The lap's last run that named an exit: the one that placed the task where it is. */
export const lastExit = (task: Runs): Run | undefined =>
  lapOf(task).findLast((run) => isExit(run.ending));

/**
 * The commit a land or a done takes: the one the exit that routed the task
 * there was named on. Landing merges this commit by id, and refuses a tip that
 * has moved past it.
 */
export const routedCommit = (task: Runs): string | undefined => lastExit(task)?.commit;

/** Whether the open reviewer named its exit, and settle has not yet closed its run. */
export const reviewerNamed = (task: Runs): boolean =>
  lapOf(task).some((run) => run.role === "review" && run.open && run.ending !== undefined);

/**
 * The commit a task working on the operator's branch started from: the base
 * its first such author run recorded. Every later author continues on top of
 * that work (a return has no undo there), so a reviewer reads all of it.
 */
export const directBase = (task: Runs): string | undefined =>
  task.runs.find((run) => run.role === "author" && run.base !== undefined)?.base;

/**
 * The author's claim that the trunk already does what the task asks.
 *
 * A backlog outlives the code it describes: work gets done under another
 * task's branch, or by hand, and the entry for it stays open. An author sent
 * to one of those has nothing to write, and every ending it can reach says
 * something false. Committing anything at all fabricates work; stopping is
 * read as a crash, which costs a rung and dispatches the same discovery again
 * at a more expensive model, forever.
 *
 * So the finding is a claim the author records as the exit `already-done`, and
 * the branch it hands over is legitimately empty. The name is the one an author
 * block must declare for the claim to count: the prompt explains that exit only
 * to a block that has it (`exitsSection` in `src/prompt.ts`), so a drawing that
 * renames it loses the explanation and the meaning together.
 *
 * It is a claim and not a verdict: "it is already done" is exactly what a model
 * too weak for the task would say to escape it, so a reviewer confirms it
 * against the trunk like any other diff, and only the reviewer's approval
 * closes the task.
 */
export const claimsAlreadyDone = (task: Runs): boolean =>
  lapOf(task).find((run) => run.role === "author")?.ending === ALREADY_DONE;
