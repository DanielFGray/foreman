import type { Charge, Run } from "tasks";
import type { Item } from "./records.ts";

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
  base: undefined,
  ending: undefined,
  rounds: undefined,
  open: true,
  landed: false,
  ...over,
});

/** An open review run on `rung`. */
export const reviewRun = (rung: string, over: Partial<Run> = {}): Run =>
  authorRun(rung, { role: "review", node: "review", ...over });

/** A closed review run that approved the commit it read. */
export const approvalOf = (rung: string, commit: string): Run =>
  reviewRun(rung, { open: false, ending: "approved", commit });

/** A closed author run that named the exit `done`. */
export const authorDone = (rung: string, commit?: string): Run =>
  authorRun(rung, { open: false, ending: "done", commit });

/** The task with these runs added after its own (oldest first) and this branch tip. */
export const withRuns = (task: Item, runs: ReadonlyArray<Run>, tip?: string): Item => ({
  ...task,
  runs: [...task.runs, ...runs.map((run) => ({ ...run, task: task.id }))],
  tip: tip ?? task.tip,
});

/**
 * The task with its author's run first. Open while the author is still writing
 * (`in_progress` and not `ended`); closed with `done` once handed off (under
 * review, landed, or any status other than `in_progress`).
 */
export const authoredOn = (task: Item, rung: string, ended = false): Item =>
  withRuns(
    task,
    [ended || task.status !== "in_progress" ? authorDone(rung) : authorRun(rung)],
    task.tip,
  );

/** A check run at block `node` that ran on `commit` and ended `ending`. */
export const checkRun = (node: string, commit: string, ending: "passed" | "failed"): Run =>
  authorRun("", { role: "check", rung: undefined, node, commit, ending, open: false });

/** A closed author run on `rung` that ended without an exit: one attempt on that rung. */
export const stoppedRun = (rung: string, ending: "stopped" | "vanished" = "stopped"): Run =>
  authorRun(rung, { open: false, ending });

/** A standing charge against `rung`, written after run `run` (none when the task had no runs). */
export const charged = (rung: string, run?: number): Charge => ({ rung, run, forgiven: false });
