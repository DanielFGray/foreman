import { authorFor, type Ladder } from "./ladder.ts";
import {
  BUG,
  failuresOf,
  isOnboarding,
  needsYou,
  type EpicProgress,
  type ReadyTask,
} from "./prog.ts";

const AGING_RATE_PER_DAY = 0.25;
const AGING_CAP_DAYS = 7;
const DAYS_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const ROTATION_SCORE_WINDOW = 0.5;

/**
 * What a defect is worth: one day more than any task can gain by waiting.
 *
 * A backlog states priority in three coarse bands, so most of it sits in one
 * band and the score inside that band is decided by age alone — which sorts by
 * when the work was filed, not by what it is. Defects are then dispatched in
 * the order they happened to be discovered, behind whatever feature batch was
 * entered first.
 *
 * Deriving the credit from the aging cap is what makes the rule exact rather
 * than tuned, and the extra day is what makes it strict: at exactly the cap a
 * fully aged feature would tie a fresh defect, and a tie is decided by the
 * order the task store happened to return — the thing this credit exists to
 * stop deciding the queue.
 */
const DEFECT_CREDIT = AGING_RATE_PER_DAY * (AGING_CAP_DAYS + 1);

/**
 * What finishing an epic is worth at 100% done: the same ceiling as a defect,
 * so a task that would close out its epic competes exactly like a fresh bug
 * report rather than needing a second constant to justify against the first.
 */
const EPIC_CLOSE_CREDIT = DEFECT_CREDIT;

/**
 * The credit for a task whose epic is `fraction` of the way done.
 *
 * Squared rather than linear: most of an epic's life this contributes nothing,
 * so ordinary priority and age still decide it, and the credit only becomes
 * material once an epic is genuinely close to closed — a 50% epic earns a
 * quarter of the ceiling, a 90% epic nine tenths of it. Linear growth would
 * let a freshly-half-finished epic already out-rank unrelated priority-1 work,
 * which is not "push it over the line", it is "any epic wins".
 */
export const epicCompletionCredit = (fraction: number): number =>
  EPIC_CLOSE_CREDIT * fraction * fraction;

/**
 * A ready task becomes more urgent while it waits, but only by a bounded
 * amount. The cap prevents old low-priority work from permanently displacing
 * newly created urgent work.
 *
 * Waiting is measured from when the task was filed, never from when it was last
 * touched. A note written onto a task is somebody reading it and thinking about
 * it — evidence the work is ripe — and aging from last activity reads that as
 * the task starting over, sending the best-understood work to the back of the
 * queue. It also makes the credit unreachable: an agent's own attempt, release
 * and log all count as activity, so a task the fleet keeps picking up never
 * ages at all.
 *
 * A defect carries the full aging credit from the moment it is filed, so it
 * leads its priority band on arrival instead of earning its way up. That is a
 * band and a half of score, so a defect also outranks ordinary work one
 * priority above it — a broken thing beats an unbuilt one, which is the whole
 * point of saying it in the score rather than in the backlog's priorities.
 */
export const effectivePriority = (task: ReadyTask, now: Date, epicFraction = 0): number => {
  const ageDays = Math.max(0, now.getTime() - task.created_at.getTime()) / DAYS_IN_MILLISECONDS;
  const credit = task.labels.includes(BUG) ? DEFECT_CREDIT : 0;
  return (
    task.priority -
    AGING_RATE_PER_DAY * Math.min(ageDays, AGING_CAP_DAYS) -
    credit -
    epicCompletionCredit(epicFraction)
  );
};

/**
 * The global queue: aged priority first, then rotation between projects.
 *
 * A continuous score has no exact priority bands, so rotation happens among
 * tasks within a small score distance of the best task in the current window.
 * This preserves fairness without allowing materially higher-priority work to
 * be skipped merely because another project has more tasks.
 */
export const interleave = (
  tasks: ReadonlyArray<ReadyTask>,
  projects: ReadonlyArray<string>,
  now = new Date(),
  epicFractionOf: (task: ReadyTask) => number = () => 0,
): ReadonlyArray<ReadyTask> => {
  const configured = new Set(projects);
  const eligible = tasks.filter((task) => configured.has(task.project));
  const ranked = eligible
    .map((task) => ({ task, score: effectivePriority(task, now, epicFractionOf(task)) }))
    .sort((left, right) => left.score - right.score);
  const picked: Array<ReadyTask> = [];

  for (let start = 0; start < ranked.length;) {
    const first = ranked[start];
    if (!first) break;
    const windowEnd = first.score + ROTATION_SCORE_WINDOW;
    const window = ranked.slice(start).filter(({ score }) => score <= windowEnd);
    const byProject = new Map<string, Array<ReadyTask>>();
    for (const { task } of window) {
      const queue = byProject.get(task.project) ?? [];
      queue.push(task);
      byProject.set(task.project, queue);
    }

    const queues = [...byProject.values()];
    while (queues.some((queue) => queue.length > 0)) {
      for (const queue of queues) {
        const task = queue.shift();
        if (task) picked.push(task);
      }
    }
    start += window.length;
  }

  return picked;
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
  readonly ready: ReadonlyArray<ReadyTask>;
  readonly ladder: Ladder;
  /** The projects that take new work. */
  readonly projects: ReadonlyArray<string>;
  readonly epics: ReadonlyArray<EpicProgress>;
  readonly failed: ReadonlySet<string>;
  readonly now: Date;
}): { readonly queue: ReadonlyArray<ReadyTask>; readonly yours: ReadonlyArray<ReadyTask> } => {
  const parked = (task: ReadyTask) =>
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
