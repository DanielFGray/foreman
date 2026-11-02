import { isApproved, passedNodes, reviewedBy } from "./lap.ts";
import { failuresOf, type Item, valueOf } from "./prog.ts";
import type { Facts } from "./pipeline.ts";

/**
 * What placement knows about `item`, read from its status, labels and runs.
 *
 * An open task has passed nothing. A return releases the task to the queue and
 * opens no run, so its lap still holds the runs of the round it returned from
 * until its next author run starts a new one.
 */
export const factsOf = (
  item: Pick<Item, "status" | "priority" | "parent" | "labels" | "runs" | "tip">,
): Facts => ({
  status: item.status,
  priority: item.priority,
  epic: item.parent,
  size: sizeOf(item.labels),
  labels: new Set(item.labels),
  failedBy: new Set(failuresOf(item)),
  attempts: attemptCount(item.labels),
  passed: item.status === "open" ? new Set() : passedNodes(item),
  underReview: reviewedBy(item) !== undefined,
  approved: isApproved(item),
});

const valuesOf = (labels: ReadonlyArray<string>, kind: string): ReadonlyArray<string> =>
  labels.flatMap((label) => {
    const value = valueOf(label, kind);
    return value === undefined ? [] : [value];
  });

/** From `size:N`; 1 when the task has none. */
const sizeOf = (labels: ReadonlyArray<string>): number => {
  const size = valuesOf(labels, "size").find((value) => /^\d+$/.test(value));
  return size === undefined ? 1 : Number(size);
};

/** The newest `attempt:<rung>:<n>` count of each rung, summed. */
const attemptCount = (labels: ReadonlyArray<string>): number => {
  const newest = new Map<string, number>();
  for (const value of valuesOf(labels, "attempt")) {
    const at = value.lastIndexOf(":");
    const count = Number(value.slice(at + 1));
    if (at <= 0 || !Number.isInteger(count)) continue;
    const rung = value.slice(0, at);
    newest.set(rung, Math.max(newest.get(rung) ?? 0, count));
  }
  return [...newest.values()].reduce((sum, n) => sum + n, 0);
};
