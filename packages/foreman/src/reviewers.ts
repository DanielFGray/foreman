import { Array as Arr, Option } from "effect";
import type { Run } from "tasks";
import { type Ladder, type LastStarts, leastRecentFirst, type Seat } from "./ladder.ts";

/**
 * The reviewers: the list a review block takes its reader from.
 *
 * A reviewer is a model with its own thinking level and account, apart from
 * the ladder. The ladder decides who writes; this list decides who reads. One
 * model can be a cheap rung that thinks little and a reviewer that thinks
 * hard. `foreman reviewers --json` prints the same list for other tools.
 *
 * A review run records its reviewer's name where an author run records its
 * rung's, and the run's role says which list the name is in. So a reviewer
 * may share a rung's name, and every reader that resolves a run's name asks
 * `seatOf` with the run's role.
 */
export interface Reviewer extends Seat {
  readonly model: string;
}

/**
 * Which reviewer reads a task next, and why there is none when there is none.
 *
 * `Waiting` and `Exhausted` are different answers. Every reviewer left being on
 * a spent account is a fact about a wallet, which an allowance reset clears, so
 * the task keeps its place. Every reviewer having stopped on this lap with no
 * verdict is a fact about the work, and the task parks for the operator.
 */
export type ReviewerChoice =
  | { readonly _tag: "Dispatch"; readonly reviewer: Reviewer }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Exhausted" };

/**
 * The reviewer that reads a task next: the reviewer whose last review started
 * longest ago, skipping the reviewers on a spent account, and preferring one
 * whose model is not the author's.
 *
 * A different model brings different blind spots, so it reads first whenever
 * one has room; the author's own model is the reviewer when no other can pay.
 * `author` is the rung that wrote the work, absent for work no rung wrote.
 *
 * `failed` names the reviewers that stopped on this lap with no verdict. They
 * are passed over for this task, and when no other is left the task parks.
 * `walled` names the reviewers on a spent account, which are passed over only
 * until the account resets.
 *
 * `lastStarts` is each reviewer's latest review start. Empty, the order is the
 * list's, which keeps a one-shot reader deterministic.
 */
export const reviewerFor = (
  reviewers: ReadonlyArray<Reviewer>,
  author: Seat | undefined,
  walled: ReadonlySet<string> = new Set(),
  failed: ReadonlyArray<string> = [],
  lastStarts: LastStarts = new Map(),
): ReviewerChoice => {
  const candidates = reviewers.filter((reviewer) => !failed.includes(reviewer.name));
  if (candidates.length === 0) return { _tag: "Exhausted" };
  const affordable = Arr.sort(
    candidates.filter((reviewer) => !walled.has(reviewer.name)),
    leastRecentFirst(lastStarts),
  );
  const reviewer =
    affordable.find((candidate) => candidate.model !== author?.model) ?? affordable[0];
  return reviewer === undefined ? { _tag: "Waiting" } : { _tag: "Dispatch", reviewer };
};

/** The two lists an agent block takes its seat from: the ladder writes, the reviewers read. */
export interface Seats {
  readonly ladder: Ladder;
  readonly reviewers: ReadonlyArray<Reviewer>;
}

/**
 * The seat a run ran on: its rung for an author run, its reviewer for a
 * review. Nothing for a name the list of its role no longer holds.
 */
export const seatOf = (seats: Seats, run: Pick<Run, "role" | "rung">): Seat | undefined =>
  (run.role === "review" ? seats.reviewers : seats.ladder).find((seat) =>
    Option.contains(run.rung, seat.name),
  );

/**
 * The reviewers a review block draws from: every reviewer for the `reviewers`
 * rule, else the one its rule names.
 */
export const drawnBy = (
  reviewers: ReadonlyArray<Reviewer>,
  rule: string,
): ReadonlyArray<Reviewer> =>
  rule === "reviewers" ? reviewers : reviewers.filter((reviewer) => reviewer.name === rule);
