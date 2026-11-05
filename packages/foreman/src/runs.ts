import { Option } from "effect";
import { durationOf, roleOf, type RunRecord } from "tasks";

export interface RunMetrics {
  /** Every run in the group, including runs with no start or no ending. */
  readonly runs: number;
  readonly medianDuration: number | undefined;
  readonly p90Duration: number | undefined;
  /** Review runs that ended `returned`, over review runs that ended `approved` or `returned`. */
  readonly reviewReturnRate: number | undefined;
  /** Closed author runs whose outcome is `committed` or `answered`, over closed author runs. */
  readonly landRate: number | undefined;
}

export interface RunTable {
  readonly key: string;
  readonly metrics: RunMetrics;
}

/** Three separate views, so sparse model-by-project cells do not read as signal. */
export const tablesFor = (runs: ReadonlyArray<RunRecord>) => ({
  rung: tableFor(runs, (run) => Option.toArray(run.rung)),
  project: tableFor(runs, (run) => [run.project]),
  task: tableFor(runs, (run) => [run.task]),
});

const tableFor = (
  runs: ReadonlyArray<RunRecord>,
  keysOf: (run: RunRecord) => ReadonlyArray<string>,
): ReadonlyArray<RunTable> => {
  const grouped = new Map<string, Array<RunRecord>>();
  for (const run of runs) {
    for (const key of keysOf(run)) {
      grouped.set(key, [...(grouped.get(key) ?? []), run]);
    }
  }
  return [...grouped.entries()].map(([key, groupedRuns]) => ({
    key,
    metrics: metricsFor(groupedRuns),
  }));
};

const metricsFor = (runs: ReadonlyArray<RunRecord>): RunMetrics => {
  const durations = runs
    .flatMap((run) => Option.toArray(durationOf(run)))
    .sort((left, right) => left - right);
  const verdicts = runs.flatMap((run) => {
    const ending = Option.getOrUndefined(run.ending);
    return run.work === "review" && (ending === "approved" || ending === "returned")
      ? [ending]
      : [];
  });
  const authorRuns = runs.filter((run) => roleOf(run.work) === "author");
  const closedAuthors = authorRuns.filter((run) => Option.isSome(run.closedAt));
  const landed = closedAuthors.filter((run) => {
    const outcome = Option.getOrUndefined(run.outcome);
    return outcome === "committed" || outcome === "answered";
  });
  return {
    runs: runs.length,
    medianDuration: percentile(durations, 0.5),
    p90Duration: percentile(durations, 0.9),
    reviewReturnRate: ratio(
      verdicts.filter((verdict) => verdict === "returned").length,
      verdicts.length,
    ),
    landRate: ratio(landed.length, closedAuthors.length),
  };
};

/** A rate is absent, not zero, when nothing was decided: zero would read as a clean record. */
const ratio = (part: number, whole: number): number | undefined =>
  whole === 0 ? undefined : part / whole;

const percentile = (values: ReadonlyArray<number>, at: number): number | undefined => {
  if (values.length === 0) return undefined;
  return values[Math.ceil(values.length * at) - 1];
};
