/**
 * The order ready work should start in.
 *
 * One continuous score: priority, minus a bounded credit for waiting, minus a
 * fixed credit for the `bug` label, minus a credit that grows with the square of
 * how much of the task's epic is done. Every credit is derived from the aging
 * cap, so none is tuned against nothing. The defect credit exceeds the cap: a
 * backlog states priority in three coarse bands, so age alone would otherwise
 * decide nearly everything, and age is only the order work was filed in.
 *
 * Tasks whose scores lie within half a band of the best remaining one are taken
 * round-robin by project, so one project with a long backlog does not starve the
 * others.
 */
const AGING_PER_DAY = 0.25;
const AGING_CAP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROTATION_WINDOW = 0.5;
const DEFECT_CREDIT = AGING_PER_DAY * (AGING_CAP_DAYS + 1);
const EPIC_CLOSE_CREDIT = DEFECT_CREDIT;

export interface Rankable {
  readonly priority: number;
  readonly project: string;
  readonly labels: ReadonlyArray<string>;
  readonly createdAt: Date;
}

/**
 * Ranks `items`, best first. `epicDone` is the fraction of each item's epic that
 * is done, 0 for an item under no epic. The sort is stable, so the caller's
 * order decides exact ties.
 */
export const rank = <A extends Rankable>(
  items: ReadonlyArray<A>,
  now: Date,
  epicDone: (item: A) => number = () => 0,
): ReadonlyArray<A> => {
  const scored = items
    .map((item) => ({ item, score: scoreOf(item, now, epicDone(item)) }))
    .sort((left, right) => left.score - right.score);
  const picked: Array<A> = [];
  for (let start = 0; start < scored.length;) {
    const bound = scored[start]!.score + ROTATION_WINDOW;
    let end = start;
    while (end < scored.length && scored[end]!.score <= bound) end++;
    const byProject = new Map<string, Array<A>>();
    for (const { item } of scored.slice(start, end)) {
      byProject.set(item.project, [...(byProject.get(item.project) ?? []), item]);
    }
    const queues = [...byProject.values()];
    while (queues.some((queue) => queue.length > 0)) {
      for (const queue of queues) {
        const next = queue.shift();
        if (next !== undefined) picked.push(next);
      }
    }
    start = end;
  }
  return picked;
};

/** A task's score; lower starts sooner. */
export const scoreOf = (item: Rankable, now: Date, epicDone: number): number => {
  const ageDays = Math.max(0, now.getTime() - item.createdAt.getTime()) / DAY_MS;
  return (
    item.priority -
    AGING_PER_DAY * Math.min(ageDays, AGING_CAP_DAYS) -
    (item.labels.includes("bug") ? DEFECT_CREDIT : 0) -
    EPIC_CLOSE_CREDIT * epicDone * epicDone
  );
};
