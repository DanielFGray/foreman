import { Effect } from "effect";
import { interleave } from "./queue.ts";
import type { Item, ReadyTask } from "./prog.ts";

/**
 * Computes the pinned task ids from the items carrying the pin label.
 *
 * A `pin` label sits on a task, an epic, or several items. The scope is every
 * task at or under any item carrying it: a pinned task is itself in scope, and
 * a pinned epic brings all of its descendant tasks, however deeply epics nest.
 * Two pinned epics are simply one larger scope — the union of both.
 *
 * `children` answers "what hangs directly off this item" so the walk can be
 * tested against an in-memory tree rather than the prog CLI; the dispatcher
 * supplies `prog.children`.
 */
export const scopeOf = <E>(
  roots: ReadonlyArray<Item>,
  children: (id: string) => Effect.Effect<ReadonlyArray<Item>, E>,
): Effect.Effect<ReadonlySet<string>, E> =>
  Effect.gen(function* () {
    const tasks = new Set<string>();
    const stack = [...roots];

    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) continue;
      if (item.type === "epic") {
        for (const child of yield* children(item.id)) {
          if (child.type === "epic") stack.push(child);
          else tasks.add(child.id);
        }
      } else {
        tasks.add(item.id);
      }
    }

    return tasks;
  });

/**
 * The pinned scope owned by this dispatcher's configured projects.
 *
 * A pin in a project this daemon does not manage is somebody else's, so its
 * descendants are never walked: the walk costs one `prog list` per epic, and
 * the answer could only ever name tasks this queue will not offer.
 */
export const pinnedOf = <E>(
  roots: ReadonlyArray<Item>,
  configured: ReadonlySet<string>,
  children: (id: string) => Effect.Effect<ReadonlyArray<Item>, E>,
): Effect.Effect<ReadonlySet<string>, E> =>
  scopeOf(
    roots.filter((root) => configured.has(root.project)),
    children,
  );

/**
 * The queue: pinned work first, then everything else.
 *
 * A pin is an absolute lead, not a contribution to the score. It says "these
 * next", which no amount of priority or aging can express — a backlog states
 * priority in three coarse bands, so a task raised to the top band lands in a
 * pile with everything else there and jumps nothing.
 *
 * Both halves are ordered by the same rules the whole queue always used, so a
 * pin reorders the queue without inventing a second notion of urgency inside
 * either group.
 *
 * **Nothing here serializes the pinned half.** Which pinned tasks may run at
 * once is already stated in the plan: `prog ready` returns only unblocked work,
 * so two pinned siblings that must not run together are siblings one of which
 * blocks the other. Re-deriving that from the shape of an epic would guess at
 * what the dependency graph already says, and guess wrong for every epic whose
 * tasks are genuinely independent.
 */
export const pinnedFirst = (
  ready: ReadonlyArray<ReadyTask>,
  pinned: ReadonlySet<string>,
  projects: ReadonlyArray<string>,
  now = new Date(),
): ReadonlyArray<ReadyTask> => [
  ...interleave(
    ready.filter((task) => pinned.has(task.id)),
    projects,
    now,
  ),
  ...interleave(
    ready.filter((task) => !pinned.has(task.id)),
    projects,
    now,
  ),
];
