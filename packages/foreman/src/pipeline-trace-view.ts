/**
 * The trace report `pipeline trace --json` prints, as Schemas. Browser-safe:
 * `pipeline-trace.ts` walks the task and builds the report, and the page decodes it.
 */
import { Schema as S } from "effect";
import { Placement } from "./pipeline.ts";

/** The rung an agent block chose: named when dispatched, else why none was. */
export const RungView = S.Union([
  S.Struct({ _tag: S.Literal("Dispatch"), name: S.String }),
  S.Struct({ _tag: S.Literal("Waiting") }),
  S.Struct({ _tag: S.Literal("Exhausted") }),
]);

/** Where the task stands after the start or after one event, and what it may do next. */
export const TraceStepView = S.Struct({
  /** The event this step follows; null for the start. */
  event: S.NullOr(S.String),
  placement: Placement,
  rung: S.NullOr(RungView),
  /** Why the task is parked for the operator, which ends the trace. */
  parked: S.NullOr(S.String),
  tip: S.String,
  route: S.Array(S.String),
  offers: S.Array(S.String),
});
export type TraceStepView = typeof TraceStepView.Type;

export const TraceReportView = S.Struct({
  project: S.String,
  source: S.Literals(["draft", "saved", "standard"]),
  /** The facts the trace reads from the world instead of assuming (`TRACE_ASSUMES`). */
  assumes: S.Struct({ accounts: S.String, gates: S.String }),
  ladder: S.Array(S.String),
  attemptsPerLevel: S.Int,
  steps: S.Array(TraceStepView),
  /** The first event the block it reached does not offer; the trace stops before it. */
  refused: S.NullOr(S.Struct({ event: S.String, offers: S.Array(S.String) })),
});
export type TraceReportView = typeof TraceReportView.Type;
