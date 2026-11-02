import { rank } from "tasks";
import { authorFor, type Ladder } from "./ladder.ts";
import { failuresOf, isOnboarding, needsYou, type EpicProgress, type Item } from "./records.ts";

/**
 * The global queue: the configured projects' ready work, in the order the task
 * store ranks it (aged priority, then rotation between projects).
 */
export const interleave = (
  tasks: ReadonlyArray<Item>,
  projects: ReadonlyArray<string>,
  now = new Date(),
  epicFractionOf: (task: Item) => number = () => 0,
): ReadonlyArray<Item> => {
  const configured = new Set(projects);
  return rank(
    tasks.filter((task) => configured.has(task.project)),
    now,
    epicFractionOf,
  );
};

/**
 * Ready work split the way the fleet reads it: the queue it may start by
 * itself, in dispatch order, and the tasks parked at the operator.
 *
 * The dispatcher's tick and `foreman queue` both call this, so the order a client
 * shows and the order the fleet dispatches cannot disagree.
 *
 * - Parked: the task carries `needs-you`, or every configured rung has failed
 *   it. Whether a rung has room is not asked: a spent account makes a task
 *   wait in the queue, never park.
 * - Onboarding: a salvage run stands in a directory a person is using, so it
 *   starts when that person asks and never because a slot came free.
 * - Failed: tasks whose dispatch failed twice the same way. That tally lives
 *   only in the dispatcher's process, so a one-shot reader passes none.
 */
export const queueFrom = (reading: {
  readonly ready: ReadonlyArray<Item>;
  readonly ladder: Ladder;
  /** The projects that take new work. */
  readonly projects: ReadonlyArray<string>;
  readonly epics: ReadonlyArray<EpicProgress>;
  readonly failed: ReadonlySet<string>;
  readonly now: Date;
}): { readonly queue: ReadonlyArray<Item>; readonly yours: ReadonlyArray<Item> } => {
  const parked = (task: Item) =>
    needsYou(task) || authorFor(reading.ladder, failuresOf(task))._tag === "Yours";
  const fractions = new Map(
    reading.epics.flatMap(({ children }) => {
      const fraction = children.filter((child) => child.status === "done").length / children.length;
      return children.map((child) => [child.id, fraction] as const);
    }),
  );
  return {
    queue: interleave(
      reading.ready.filter(
        (task) => !parked(task) && !isOnboarding(task) && !reading.failed.has(task.id),
      ),
      reading.projects,
      reading.now,
      (task) => fractions.get(task.id) ?? 0,
    ),
    yours: reading.ready.filter((task) => parked(task) && reading.projects.includes(task.project)),
  };
};
