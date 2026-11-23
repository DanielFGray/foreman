/**
 * The metrics page's data: one closed agent run as the page reads it, and the
 * pure folds each chart draws from. No I/O, so the page imports it.
 *
 * Every fold reports how many runs carried its measure (`covered`) out of how
 * many it was given (`of`). The harnesses report tokens, cost and active time
 * for only some runs, so a total read without its coverage reads as the whole.
 * Each fold keeps to one measure: actual cost is never summed with an estimate,
 * nor active time with wall-clock time.
 */
import { Schema as S } from "effect";

/** One closed agent run. A check runs no model, so it is not one. */
export const MetricsRun = S.Struct({
  id: S.Int,
  project: S.String,
  task: S.String,
  model: S.NullOr(S.String),
  /** The rung foreman dispatched it on; null for a run launched by hand. */
  rung: S.NullOr(S.String),
  work: S.String,
  /** When it closed, in milliseconds since the epoch. */
  closedAt: S.Finite,
  /** Start to close; null for a run recorded before starts were kept. */
  wallMinutes: S.NullOr(S.Finite),
  activeMinutes: S.NullOr(S.Finite),
  tokens: S.NullOr(S.Int),
  /** What the harness billed; null where it reported no cost. */
  costUsd: S.NullOr(S.Finite),
  outcome: S.NullOr(S.String),
  ending: S.NullOr(S.String),
});
export type MetricsRun = typeof MetricsRun.Type;

/** Who started the runs a page shows. */
export const LAUNCHERS = ["all", "foreman", "hand"] as const;
export type Launcher = (typeof LAUNCHERS)[number];

export const launchedBy = (
  runs: ReadonlyArray<MetricsRun>,
  launcher: Launcher,
): ReadonlyArray<MetricsRun> =>
  launcher === "all"
    ? runs
    : runs.filter((run) => (run.rung !== null) === (launcher === "foreman"));

/** How many runs a fold could read, out of how many it was given. */
export interface Coverage {
  readonly covered: number;
  readonly of: number;
}

export type SpendMeasure = "costUsd" | "tokens";

/** A running total over time: each point is the total once that run had closed. */
export const runningTotal = (
  runs: ReadonlyArray<MetricsRun>,
  measure: SpendMeasure,
): Coverage & {
  readonly points: ReadonlyArray<{ readonly at: number; readonly total: number }>;
} => {
  const measured = runs
    .flatMap((run) => {
      const value = run[measure];
      return value === null ? [] : [{ at: run.closedAt, value }];
    })
    .sort((left, right) => left.at - right.at);
  let total = 0;
  const points = measured.map(({ at, value }) => {
    total += value;
    return { at, total };
  });
  return { points, covered: measured.length, of: runs.length };
};

export type ShareMeasure = "runs" | SpendMeasure;

/** Each model's share of a measure, largest first. A run with no model counts as "unknown". */
export const shareByModel = (
  runs: ReadonlyArray<MetricsRun>,
  measure: ShareMeasure,
): Coverage & {
  readonly rows: ReadonlyArray<{ readonly key: string; readonly value: number }>;
} => {
  const totals = new Map<string, number>();
  let covered = 0;
  for (const run of runs) {
    const value = measure === "runs" ? 1 : run[measure];
    if (value === null) continue;
    covered += 1;
    const key = run.model ?? "unknown";
    totals.set(key, (totals.get(key) ?? 0) + value);
  }
  const rows = [...totals.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key));
  return { rows, covered, of: runs.length };
};

export type TimeMeasure = "wallMinutes" | "activeMinutes";

/**
 * The lower edge of each run-time bin, in minutes. The bins widen as they go,
 * because run times spread from seconds to hours and equal bins would put
 * nearly every run in the first.
 */
export const TIME_BINS = [0, 1, 2, 5, 10, 15, 30, 60, 120, 240] as const;

export interface TimeBin {
  readonly from: number;
  /** The next bin's lower edge; null for the last, open bin. */
  readonly to: number | null;
  readonly count: number;
}

/** How long runs took, binned, with the median and the 90th percentile. */
export const runTimes = (
  runs: ReadonlyArray<MetricsRun>,
  measure: TimeMeasure,
): Coverage & {
  readonly bins: ReadonlyArray<TimeBin>;
  readonly p50: number | undefined;
  readonly p90: number | undefined;
} => {
  const minutes = runs
    .flatMap((run) => (run[measure] === null ? [] : [run[measure]]))
    .sort((left, right) => left - right);
  const bins = TIME_BINS.map((from, index) => {
    const to = TIME_BINS[index + 1] ?? null;
    return {
      from,
      to,
      count: minutes.filter((value) => value >= from && (to === null || value < to)).length,
    };
  });
  return {
    bins,
    p50: percentile(minutes, 0.5),
    p90: percentile(minutes, 0.9),
    covered: minutes.length,
    of: runs.length,
  };
};

/**
 * The endings that mean a rung did not finish the run: it ended naming no
 * exit, its pane went away, or its allowance ran out. `released` and
 * `canceled` are an operator's acts, so they say nothing of the rung.
 */
export const FAILED_ENDINGS: ReadonlyArray<string> = ["stopped", "vanished", "walled"];

/**
 * Per rung, the runs that ended and how many of those failed, most runs first.
 * Only a run foreman dispatched has a rung, and only a run foreman settled has
 * an ending; a run with neither says nothing about how its rung did, so it is
 * left out rather than counted as a success.
 */
export const endingsByRung = (
  runs: ReadonlyArray<MetricsRun>,
): Coverage & {
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly ended: number;
    readonly failed: number;
  }>;
} => {
  const counts = new Map<string, { ended: number; failed: number }>();
  let covered = 0;
  for (const run of runs) {
    if (run.rung === null || run.ending === null) continue;
    covered += 1;
    const count = counts.get(run.rung) ?? { ended: 0, failed: 0 };
    count.ended += 1;
    if (FAILED_ENDINGS.includes(run.ending)) count.failed += 1;
    counts.set(run.rung, count);
  }
  const rows = [...counts.entries()]
    .map(([key, count]) => ({ key, ...count }))
    .sort((left, right) => right.ended - left.ended || left.key.localeCompare(right.key));
  return { rows, covered, of: runs.length };
};

/** The nearest-rank percentile of sorted values; absent for none. */
const percentile = (sorted: ReadonlyArray<number>, at: number): number | undefined =>
  sorted.length === 0 ? undefined : sorted[Math.ceil(sorted.length * at) - 1];
