import { Order } from "effect";
import type { ReadyTask } from "./prog.ts";

/**
 * The global queue: priority first, then rotation between projects.
 *
 * Rotation crosses projects only within one priority band. Otherwise a project
 * with lower-priority work could jump ahead merely because its turn arrived.
 */
export const interleave = (
  tasks: ReadonlyArray<ReadyTask>,
  projects: ReadonlyArray<string>,
): ReadonlyArray<ReadyTask> => {
  const configured = new Set(projects);
  const eligible = tasks.filter((task) => configured.has(task.project));
  const priorities = [...new Set(eligible.map((task) => task.priority))].sort(Order.number);
  const picked: Array<ReadyTask> = [];

  for (const priority of priorities) {
    const byProject = new Map<string, Array<ReadyTask>>();
    for (const task of eligible) {
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
