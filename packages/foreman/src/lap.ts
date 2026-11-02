import type { Run } from "tasks";

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

/** The rung of the lap's open review run: the reviewer that owns the task now. */
export const reviewedBy = (task: Runs): string | undefined =>
  lapOf(task).find((run) => run.role === "review" && run.open)?.rung;

/** The rungs whose reviewers ended this lap with no verdict. */
export const reviewFailedBy = (task: Runs): ReadonlyArray<string> =>
  lapOf(task).flatMap((run) =>
    run.role === "review" && run.ending === "no-verdict" && run.rung !== undefined
      ? [run.rung]
      : [],
  );

/**
 * The lap's last review run that gave a verdict, when that verdict approves.
 * A reviewer that approves and then returns the work in one turn leaves
 * `returned`, so its approval is gone.
 */
const approval = (task: Runs): Run | undefined => {
  const verdict = lapOf(task).findLast(
    (run) => run.role === "review" && (run.ending === "approved" || run.ending === "returned"),
  );
  return verdict?.ending === "approved" ? verdict : undefined;
};

/**
 * Whether a reviewer accepted the branch as it stands: the lap's last verdict
 * approves, and the commit the reviewer read is the branch tip now. A commit
 * after the approval voids it.
 */
export const isApproved = (task: Runs & { readonly tip: string | undefined }): boolean => {
  const commit = approval(task)?.commit;
  return commit !== undefined && commit === task.tip;
};

/**
 * The pipeline blocks that advanced the task in this lap: the author's block
 * once it handed off or claimed the trunk already does the task, the review
 * block while its approval holds, and a check block whose command passed on
 * the branch tip. A review and a check each pass one commit, so a commit after
 * either places the task at that block again.
 */
export const passedNodes = (
  task: Runs & { readonly tip: string | undefined },
): ReadonlySet<string> => {
  const approved = isApproved(task) ? approval(task) : undefined;
  const nodes = lapOf(task).flatMap((run) => {
    const advanced =
      run.role === "author"
        ? run.ending === "handed-off" || run.ending === "satisfied"
        : run.role === "check"
          ? run.ending === "passed" && run.commit !== undefined && run.commit === task.tip
          : run === approved;
    return advanced && run.node !== undefined ? [run.node] : [];
  });
  return new Set(nodes);
};

/** The commit the lap's approval covers. Landing merges this commit by id. */
export const approvedCommit = (task: Runs): string | undefined => approval(task)?.commit;

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
 * So the finding is a claim the author records, and the branch it hands over
 * is legitimately empty. It is a claim and not a verdict: "it is already done"
 * is exactly what a model too weak for the task would say to escape it, so a
 * reviewer confirms it against the trunk like any other diff, and only the
 * reviewer's approval closes the task.
 */
export const isSatisfied = (task: Runs): boolean =>
  lapOf(task).find((run) => run.role === "author")?.ending === "satisfied";
