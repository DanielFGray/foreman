import type { AgentRole } from "./fleet.ts";
import {
  authorFor,
  isEnabled,
  mayAuthor,
  providerOf,
  seatsOnAccounts,
  type Ladder,
  type LastStarts,
  type Rung,
  type Seat,
} from "./ladder.ts";
import { authoredBy, reviewFailedBy } from "./lap.ts";
import type { AgentNode } from "./pipeline.ts";
import { failuresOf, type Item, walledBy } from "./records.ts";
import { drawnBy, reviewerFor, type Reviewer, type Seats } from "./reviewers.ts";

/**
 * One value for each agent role. A run's name is a rung for an author and a
 * reviewer for a review, so what is read per name (the seats on a spent
 * account, the latest starts) is read per role.
 */
export type PerRole<A> = { readonly [Role in AgentRole]: A };

/**
 * The seat an agent block runs a task on, given this reading's allowances.
 *
 * The plan and the dispatch both ask this, from the same reading, so the plan
 * never offers a task that the dispatch would find no agent for, and the
 * dispatch never finds an agent for a task the plan passed over.
 */
export type BlockSeat<A extends Seat = Seat> =
  | { readonly _tag: "Dispatch"; readonly seat: A }
  /** Every seat the block could run is on a spent account. A later reading asks again. */
  | { readonly _tag: "Waiting" }
  /** No seat of the block is left for this task: the task parks for the operator. */
  | { readonly _tag: "Exhausted" };

/**
 * Which seat `block` runs `task` on: a rung for an author block, a reviewer
 * for a review block.
 *
 * `walled` names the seats on a spent account. `drawn` names the accounts this
 * tick already dispatched an author on, so one tick spreads its authors.
 * `lastStarts` is each seat's latest start, so the rungs of a level, and the
 * reviewers, take turns.
 */
export const seatAt = (
  seats: Seats,
  block: AgentNode,
  task: Pick<Item, "runs" | "charges">,
  walled: PerRole<ReadonlySet<string>>,
  drawn: ReadonlySet<string> = new Set(),
  lastStarts: PerRole<LastStarts> = { author: new Map(), review: new Map() },
): BlockSeat => {
  const spent = taskWalls(seats, task, walled);
  return block.role === "author"
    ? rungAt(seats.ladder, block, task, spent.author, drawn, lastStarts.author)
    : reviewerAt(seats, block, task, spent.review, lastStarts.review);
};

/**
 * Which rung an author block runs `task` on.
 *
 * - `ladder`: the least recently started rung of the lowest level above the
 *   task's failures.
 * - a rung name: that rung. A failure of that rung on this task leaves the
 *   block nothing to run, so the task parks.
 */
const rungAt = (
  ladder: Ladder,
  block: AgentNode,
  task: Pick<Item, "charges">,
  walled: ReadonlySet<string>,
  drawn: ReadonlySet<string>,
  lastStarts: LastStarts,
): BlockSeat<Rung> => {
  if (block.model === "ladder") {
    const choice = authorFor(ladder, failuresOf(task), walled, drawn, lastStarts);
    return choice._tag === "Dispatch"
      ? { _tag: "Dispatch", seat: choice.rung }
      : choice._tag === "Waiting"
        ? { _tag: "Waiting" }
        : { _tag: "Exhausted" };
  }
  if (failuresOf(task).includes(block.model)) return { _tag: "Exhausted" };
  const rung = ladder.find((candidate) => candidate.name === block.model);
  // The operator can enable a rung or switch its author role on again, so a
  // pin to a rung that cannot take the block waits, as it does for a spent
  // account.
  return rung !== undefined && isEnabled(rung) && mayAuthor(rung) && !walled.has(rung.name)
    ? { _tag: "Dispatch", seat: rung }
    : { _tag: "Waiting" };
};

/**
 * Which reviewer a review block runs `task` on.
 *
 * - `reviewers`: the least recently started reviewer off a spent account,
 *   preferring a model other than the author's (`reviewerFor`).
 * - a reviewer name: that reviewer.
 *
 * A reviewer that stopped on this lap with no verdict is passed over, and the
 * task parks when none is left.
 */
const reviewerAt = (
  seats: Seats,
  block: AgentNode,
  task: Pick<Item, "runs">,
  walled: ReadonlySet<string>,
  lastStarts: LastStarts,
): BlockSeat<Reviewer> => {
  const author = seats.ladder.find((rung) => rung.name === authoredBy(task));
  const choice = reviewerFor(
    drawnBy(seats.reviewers, block.model),
    author,
    walled,
    reviewFailedBy(task),
    lastStarts,
  );
  return choice._tag === "Dispatch" ? { _tag: "Dispatch", seat: choice.reviewer } : choice;
};

/**
 * `seatAt` for a dispatch: the account of the seat it chose is added to
 * `drawn`, so the authors one tick dispatches spread over the accounts, and
 * the seat is recorded in `started` as the latest start of its role, so the
 * free slots of one tick spread over a level and over the reviewers. Both are
 * the tick's own copies.
 */
export const drawSeat = (
  seats: Seats,
  block: AgentNode,
  task: Pick<Item, "runs" | "charges">,
  walled: PerRole<ReadonlySet<string>>,
  drawn: Set<string> | undefined,
  started?: PerRole<Map<string, Date>>,
): BlockSeat => {
  const choice = seatAt(seats, block, task, walled, drawn, started);
  if (choice._tag !== "Dispatch") return choice;
  const provider = providerOf(choice.seat);
  if (provider !== undefined) drawn?.add(provider);
  const mine = started?.[block.role];
  mine?.set(choice.seat.name, afterEvery(mine));
  return choice;
};

/**
 * An instant later than every start in `started`. Only the order of the starts
 * is read, and a tick's copy is dropped when the tick ends, so it needs no clock.
 */
const afterEvery = (started: ReadonlyMap<string, Date>): Date =>
  new Date(Math.max(0, ...[...started.values()].map((start) => start.getTime())) + 1);

/**
 * The seats a task may not take, per role: those on a spent account in this
 * tick's reading, and those on an account the task's agents stopped on a
 * usage wall. The second is per task, so it comes from the task's runs, not
 * from the reading.
 */
export const taskWalls = (
  seats: Seats,
  task: Pick<Item, "runs">,
  walled: PerRole<ReadonlySet<string>>,
): PerRole<ReadonlySet<string>> => {
  const accounts = walledBy(task, seats);
  return {
    author: new Set([...walled.author, ...seatsOnAccounts(seats.ladder, accounts)]),
    review: new Set([...walled.review, ...seatsOnAccounts(seats.reviewers, accounts)]),
  };
};
