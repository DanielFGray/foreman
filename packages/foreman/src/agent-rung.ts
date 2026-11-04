import type { Run } from "tasks";
import {
  authorFor,
  isEnabled,
  mayAuthor,
  mayReview,
  reviewerFor,
  rungsOnAccounts,
  providerOf,
  type Ladder,
  type LastStarts,
  type Rung,
} from "./ladder.ts";
import { authoredBy, reviewFailedBy } from "./lap.ts";
import type { AgentNode } from "./pipeline.ts";
import { failuresOf, type Item, walledBy } from "./records.ts";

/**
 * The rung an agent block runs a task on, given this reading's allowances.
 *
 * The plan and the dispatch both ask this, from the same reading, so the plan
 * never offers a task that the dispatch would find no agent for, and the
 * dispatch never finds an agent for a task the plan passed over.
 */
export type BlockRung =
  | { readonly _tag: "Dispatch"; readonly rung: Rung }
  /** Every rung the block could run is on a spent account. A later reading asks again. */
  | { readonly _tag: "Waiting" }
  /** No rung of the block is left for this task: the task parks for the operator. */
  | { readonly _tag: "Exhausted" };

/**
 * Which rung `block` runs `task` on.
 *
 * - `ladder`: the least recently started rung of the lowest level above the
 *   task's failures (an author).
 * - `above`: the next rung above the author and every reviewer that stopped
 *   with no verdict (a reviewer).
 * - a rung name: that rung. A failure of that rung on this task leaves the
 *   block nothing to run, so the task parks.
 *
 * `walled` names the rungs on a spent account. `drawn` names the accounts this
 * tick already dispatched an author on, so one tick spreads its authors.
 * `lastStarts` is each rung's latest start, so the rungs of a level take turns.
 */
export const rungAt = (
  ladder: Ladder,
  block: AgentNode,
  task: Pick<Item, "runs" | "charges">,
  walled: ReadonlySet<string>,
  drawn: ReadonlySet<string> = new Set(),
  lastStarts: LastStarts = new Map(),
): BlockRung => {
  const spent = authorWalls(ladder, task, walled);
  if (block.model === "ladder") {
    const choice = authorFor(ladder, failuresOf(task), spent, drawn, lastStarts);
    return choice._tag === "Dispatch"
      ? choice
      : choice._tag === "Waiting"
        ? { _tag: "Waiting" }
        : { _tag: "Exhausted" };
  }
  if (block.model === "above") {
    // No reviewer left is settle's to answer when a reviewer stops, so here
    // an absent rung is a spent account.
    const rung = reviewerFor(ladder, authoredBy(task), spent, reviewFailedBy(task));
    return rung === undefined ? { _tag: "Waiting" } : { _tag: "Dispatch", rung };
  }
  const failed = block.role === "author" ? failuresOf(task) : reviewFailedBy(task);
  if (failed.includes(block.model)) return { _tag: "Exhausted" };
  const rung = ladder.find((candidate) => candidate.name === block.model);
  // The operator can enable a rung or switch its role on again, so a pin to a
  // rung that may not take the block now waits, as it does for a spent account.
  const mayTake =
    rung !== undefined &&
    isEnabled(rung) &&
    (block.role === "author" ? mayAuthor(rung) : mayReview(rung)) &&
    !spent.has(rung.name);
  return mayTake ? { _tag: "Dispatch", rung } : { _tag: "Waiting" };
};

/**
 * `rungAt` for a dispatch: the account of the rung it chose is added to
 * `drawn`, so the authors one tick dispatches spread over the accounts, and
 * the rung is recorded in `started` as the latest start, so the free slots of
 * one tick spread over a level. Both are the tick's own copies.
 */
export const drawRung = (
  ladder: Ladder,
  block: AgentNode,
  task: Pick<Item, "runs" | "charges">,
  walled: ReadonlySet<string>,
  drawn: Set<string> | undefined,
  started?: Map<string, Date>,
): BlockRung => {
  const choice = rungAt(ladder, block, task, walled, drawn, started);
  if (choice._tag !== "Dispatch") return choice;
  const provider = providerOf(choice.rung);
  if (provider !== undefined) drawn?.add(provider);
  started?.set(choice.rung.name, afterEvery(started));
  return choice;
};

/**
 * An instant later than every start in `started`. Only the order of the starts
 * is read, and a tick's copy is dropped when the tick ends, so it needs no clock.
 */
const afterEvery = (started: ReadonlyMap<string, Date>): Date =>
  new Date(Math.max(0, ...[...started.values()].map((start) => start.getTime())) + 1);

/**
 * The rungs an author may not take for this task: those on a spent account in
 * this tick's reading, and those on an account the task's agents stopped on a
 * usage wall. The second is per task, so it comes from the task's runs, not
 * from the reading.
 */
export const authorWalls = (
  ladder: Ladder,
  task: Pick<Item, "runs">,
  walled: ReadonlySet<string>,
): ReadonlySet<string> => new Set([...walled, ...rungsOnAccounts(ladder, walledBy(task, ladder))]);
