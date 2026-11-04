/**
 * The task board: each task in the one column a person reads as where its
 * work is, from where it stands in its project's pipeline. Foreman decides
 * the column, so the herdr-app pane and herdr-web's board only draw it.
 */
import { DateTime } from "effect";
import { PROCESS_ENDINGS, type Ending } from "tasks";
import { sinceLanded, type Item } from "./records.ts";
import type { Placement } from "./pipeline.ts";

export const BOARD_COLUMNS = [
  "queue",
  "needs-you",
  "authoring",
  "review",
  "fixing",
  "landed",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** How long a landed task stays on the board. */
export const LANDED_HOURS = 24;

/**
 * The column of a task that stands in its project's pipeline.
 *
 * - `needs-you`: it is parked, a gate holds it for a person's approval, or
 *   the dashboard asks a decision about it (`decisionsOf`), such as a claim
 *   no agent works on.
 * - `queue`: it waits for an author and no verdict has sent it back.
 * - `authoring`: an author runs on it, and no verdict has sent it back.
 * - `fixing`: it is back at an author after a review or a check gave a
 *   verdict since it last landed, whether an author runs on it yet or not.
 * - `review`: it waits for or runs at a review, a check or a landing.
 * - `landed`: it stands at a done block, which the next reading settles.
 */
export const columnOf = (
  task: Item,
  placement: Exclude<Placement, { readonly _tag: "Outside" }>,
  asksYou: boolean,
): BoardColumn => {
  if (placement._tag === "Parked" || placement._tag === "ExitGone" || asksYou) return "needs-you";
  const { node, state } = placement;
  switch (node.kind) {
    case "agent":
      if (node.role === "review") return "review";
      if (sinceLanded(task).some(sentBack)) return "fixing";
      return state === "waiting" ? "queue" : "authoring";
    case "check":
    case "land":
      return "review";
    case "done":
      return "landed";
  }
};

/**
 * The landed tasks the board shows: those that landed in the last
 * `LANDED_HOURS` before `now`, newest first as `landed` already is.
 */
export const recentlyLanded = (
  landed: ReadonlyArray<Item>,
  now: DateTime.DateTime,
): ReadonlyArray<Item> => {
  const cutoff = DateTime.subtract(now, { hours: LANDED_HOURS });
  return landed.filter((item) =>
    DateTime.isGreaterThan(DateTime.fromDateUnsafe(item.lastActivityAt), cutoff),
  );
};

/**
 * Whether a run gave a verdict on the work: a check, or a review that named an
 * exit. A task back at an author after a verdict was sent back by it or by a
 * later block. A review that foreman ended (released, stopped and the rest)
 * gave no verdict.
 */
const sentBack = (run: Item["runs"][number]): boolean =>
  run.role !== "author" && !run.open && run.ending !== undefined && !PROCESS.has(run.ending);

const PROCESS: ReadonlySet<Ending> = new Set(PROCESS_ENDINGS);
