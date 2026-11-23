import { Effect, Option } from "effect";
import { durationOf, type RunRecord } from "tasks";
import type { MetricsRun } from "./metrics.ts";
import { Records } from "./records.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The closed agent runs of the last `days` days, or of all time for null, as
 * the metrics page reads them.
 *
 * The store keeps run times in two layouts, so the store's own comparison is
 * only near the window's edge; each close is parsed and compared here.
 */
export const metricsRuns = (days: number | null) =>
  Effect.gen(function* () {
    const records = yield* Records;
    const since = new Date(days === null ? 0 : Date.now() - days * DAY_MS);
    const closed = yield* records.closedSince(since);
    return closed.flatMap((run) => {
      const shown = metricsRunOf(run);
      return shown !== undefined && shown.closedAt >= since.getTime() ? [shown] : [];
    });
  });

const metricsRunOf = (run: RunRecord): MetricsRun | undefined => {
  if (run.work === "check" || Option.isNone(run.closedAt)) return undefined;
  return {
    id: run.id,
    project: run.project,
    task: run.task,
    model: Option.getOrNull(run.model),
    rung: Option.getOrNull(run.rung),
    work: run.work,
    closedAt: run.closedAt.value.getTime(),
    wallMinutes: Option.getOrNull(Option.map(durationOf(run), (ms) => ms / 60000)),
    activeMinutes: Option.getOrNull(run.activeMinutes),
    tokens: Option.getOrNull(run.tokens),
    costUsd: Option.getOrNull(run.costUsd),
    outcome: Option.getOrNull(run.outcome),
    ending: Option.getOrNull(run.ending),
  };
};
