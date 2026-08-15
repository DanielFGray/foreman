import type { ReadyTask } from "./prog.ts";

const AGING_RATE_PER_DAY = 0.25;
const AGING_CAP_DAYS = 7;
const DAYS_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const ROTATION_SCORE_WINDOW = 0.5;

/**
 * A ready task becomes more urgent while it waits, but only by a bounded
 * amount. The cap prevents old low-priority work from permanently displacing
 * newly created urgent work.
 */
export const effectivePriority = (task: ReadyTask, now: Date): number => {
  const ageDays =
    Math.max(0, now.getTime() - task.last_activity_at.getTime()) / DAYS_IN_MILLISECONDS;
  return task.priority - AGING_RATE_PER_DAY * Math.min(ageDays, AGING_CAP_DAYS);
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
