import { Effect } from "effect";
import { interleave } from "./queue.ts";
import type { Item, ReadyTask } from "./prog.ts";

/**
 * The scope a focus label defines.
 *
 * A `focus` label sits on a task, an epic, or several items. The scope is every
 * task at or under any item carrying it: a focused task is itself in scope, and
 * a focused epic brings all of its descendant tasks, however deeply epics nest.
 * Two labelled epics are simply one larger scope — the union of both.
 */
export interface Scope {
  /** The task ids in scope, from which the ready queue draws the focused thread. */
  readonly tasks: ReadonlySet<string>;
  /** The projects the scope touches, from which spillover draws. */
  readonly projects: ReadonlySet<string>;
}

/**
 * Computes the scope from the items carrying the focus label.
 *
 * `children` answers "what hangs directly off this item" so the walk can be
 * tested against an in-memory tree rather than the prog CLI; the dispatcher
 * supplies `prog.children`.
 */
export const scopeOf = <E>(
  roots: ReadonlyArray<Item>,
  children: (id: string) => Effect.Effect<ReadonlyArray<Item>, E>,
): Effect.Effect<Scope, E> =>
  Effect.gen(function* () {
    const tasks = new Set<string>();
    const projects = new Set<string>();
    const stack = [...roots];

    for (const root of roots) projects.add(root.project);
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) continue;
      if (item.type === "epic") {
        for (const child of yield* children(item.id)) {
          projects.add(child.project);
          if (child.type === "epic") stack.push(child);
          else tasks.add(child.id);
        }
      } else {
        tasks.add(item.id);
      }
    }

    return { tasks, projects };
  });

/**
 * Splits ready work into the focused thread and the spillover.
 *
 * The thread keeps prog's own priority-first order — deep mode takes the head.
 * The spillover is interleaved between projects, as the queue always was. When
 * nothing is focused the whole ready set is spillover and the thread is empty.
 */
export const splitQueue = (
  ready: ReadonlyArray<ReadyTask>,
  scope: ReadonlySet<string>,
  projects: ReadonlySet<string>,
  focused: boolean,
): { readonly focus: ReadonlyArray<ReadyTask>; readonly spillover: ReadonlyArray<ReadyTask> } => {
  const focus = focused
    ? ready.filter((task) => scope.has(task.id) && projects.has(task.project))
    : [];
  const spillover = interleave(
    ready.filter((task) => !scope.has(task.id)),
    [...projects],
  );
  return { focus, spillover };
};
