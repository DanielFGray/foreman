import type { Run } from "tasks";
import type { Item } from "./prog.ts";

/**
 * Test builders for a task and its runs. A task's review state is its runs, so
 * a test states the runs it needs and reads the answer through the same pure
 * functions the dispatcher uses.
 */

let ids = 0;

/** An open author run on `rung`; `over` closes it or gives it an ending. */
export const authorRun = (rung: string, over: Partial<Run> = {}): Run => ({
  id: ++ids,
  task: "ts-1",
  role: "author",
  rung,
  node: "author",
  commit: undefined,
  ending: undefined,
  rounds: undefined,
  open: true,
  ...over,
});

/** An open review run on `rung`. */
export const reviewRun = (rung: string, over: Partial<Run> = {}): Run =>
  authorRun(rung, { role: "review", node: "review", ...over });

/** A closed review run that approved the commit it read. */
export const approvalOf = (rung: string, commit: string): Run =>
  reviewRun(rung, { open: false, ending: "approved", commit });

/** A closed author run that handed its work off. */
export const handedOff = (rung: string, commit?: string): Run =>
  authorRun(rung, { open: false, ending: "handed-off", commit });

/** The task with these runs (oldest first) and this branch tip. */
export const withRuns = (task: Item, runs: ReadonlyArray<Run>, tip?: string): Item => ({
  ...task,
  runs: runs.map((run) => ({ ...run, task: task.id })),
  tip,
});
