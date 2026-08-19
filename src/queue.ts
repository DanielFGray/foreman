import { BUG, type ReadyTask } from "./prog.ts";

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
export const effectivePriority = (task: ReadyTask, now: Date): number => {
  const ageDays = Math.max(0, now.getTime() - task.created_at.getTime()) / DAYS_IN_MILLISECONDS;
  const credit = task.labels.includes(BUG) ? DEFECT_CREDIT : 0;
  return task.priority - AGING_RATE_PER_DAY * Math.min(ageDays, AGING_CAP_DAYS) - credit;
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
): ReadonlyArray<ReadyTask> => {
  const configured = new Set(projects);
  const eligible = tasks.filter((task) => configured.has(task.project));
  const ranked = eligible
    .map((task) => ({ task, score: effectivePriority(task, now) }))
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
