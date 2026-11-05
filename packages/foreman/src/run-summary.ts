import { Option, Schema as S } from "effect";
import { durationOf, roleOf, type RunRecord } from "tasks";
import type { TaskStatus } from "./records.ts";

/**
 * A task's run history reduced to the numbers `foreman show` reports under
 * its run table. Pure: the caller passes the runs `Records.history` read, the
 * task's status and the clock, so every number is fixed by its inputs.
 */

/** The summary; an absent value is null in JSON and `Option.none` here. */
export const RunSummary = S.Struct({
  /** From the first run's start to the last run's close when the task is done, else to `now`. */
  elapsedMinutes: S.OptionFromNullOr(S.Finite),
  /** The durations of author and review runs, summed. */
  agentMinutes: S.OptionFromNullOr(S.Finite),
  authorRuns: S.Int,
  /** Review runs that ended `returned`. */
  returned: S.Int,
  /** The rounds of the author runs, summed. */
  rounds: S.OptionFromNullOr(S.Int),
});
export type RunSummary = typeof RunSummary.Type;

const MS_PER_MINUTE = 60_000;

/** Sums the values; none when there are none, so an empty sum is not reported as zero. */
const sumOf = (values: ReadonlyArray<number>): Option.Option<number> =>
  values.length === 0 ? Option.none() : Option.some(values.reduce((sum, value) => sum + value, 0));

export const summarizeRuns = (
  runs: ReadonlyArray<RunRecord>,
  status: TaskStatus,
  now: Date,
): RunSummary => {
  const starts = runs.flatMap((run) => Option.toArray(run.startedAt));
  const closes = runs.flatMap((run) => Option.toArray(run.closedAt));
  const earliest = starts.length === 0 ? undefined : Math.min(...starts.map((at) => at.getTime()));
  const latest =
    status === "done" && closes.length > 0
      ? Math.max(...closes.map((at) => at.getTime()))
      : now.getTime();
  const elapsedMinutes = Option.map(
    Option.fromUndefinedOr(earliest),
    (from) => (latest - from) / MS_PER_MINUTE,
  );

  const agentRuns = runs.filter((run) => roleOf(run.work) !== "check");
  const agentMinutes = sumOf(
    agentRuns.flatMap((run) => Option.toArray(durationOf(run))).map((ms) => ms / MS_PER_MINUTE),
  );

  const authorRuns = runs.filter((run) => roleOf(run.work) === "author");
  return {
    elapsedMinutes,
    agentMinutes,
    authorRuns: authorRuns.length,
    returned: runs.filter(
      (run) =>
        roleOf(run.work) === "review" &&
        Option.exists(run.ending, (ending) => ending === "returned"),
    ).length,
    rounds: sumOf(authorRuns.flatMap((run) => Option.toArray(run.rounds))),
  };
};
