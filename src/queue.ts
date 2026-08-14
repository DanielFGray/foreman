import { Order } from "effect";
import type { ReadyTask } from "./prog.ts";

/**
 * The global queue: priority first, then rotation between projects.
 *
 * Rotation crosses projects only within one priority band. Otherwise a project
 * with lower-priority work could jump ahead merely because its turn arrived.
 */
export const interleave = (tasks: ReadonlyArray<ReadyTask>): ReadonlyArray<ReadyTask> => {
  const priorities = [...new Set(tasks.map((task) => task.priority))].sort(Order.number);
  const picked: Array<ReadyTask> = [];

  for (const priority of priorities) {
    const byProject = new Map<string, Array<ReadyTask>>();
    for (const task of tasks) {
      if (task.priority !== priority) continue;
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
  }

  return picked;
};
