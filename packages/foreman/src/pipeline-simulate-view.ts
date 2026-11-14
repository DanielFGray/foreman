/**
 * The simulation `pipeline simulate --json` prints, as Schemas. Browser-safe:
 * `pipeline-simulate.ts` plays the run and builds the report, and the page
 * decodes it.
 */
import { Schema as S } from "effect";
import { RunState } from "./pipeline.ts";

const Label = S.Literals(["Measured", "Assumed"]);
const Role = S.Literals(["author", "review"]);

/** Where a task stands in a frame: a block's run state, or out of the pipeline for good or for now. */
export const FrameState = S.Union([
  RunState,
  S.Literals(["landed", "parked", "gone", "idle", "outside"]),
]);
export type FrameState = typeof FrameState.Type;

export const Standing = S.Struct({
  task: S.String,
  /** The block a board draws the task on, or null outside the pipeline. */
  node: S.NullOr(S.String),
  state: FrameState,
});
export type Standing = typeof Standing.Type;

/** The tasks that moved at one time. The first frame holds every task. */
export const Frame = S.Struct({
  /** Hours since the start. */
  at: S.Finite,
  moves: S.Array(Standing),
});
export type Frame = typeof Frame.Type;

export const SimulatedTask = S.Struct({
  id: S.String,
  title: S.String,
  landedAt: S.NullOr(S.Finite),
  parkedAt: S.NullOr(S.Finite),
  /** The block a task still in flight stands at when the run ends. */
  at: S.NullOr(S.String),
});
export type SimulatedTask = typeof SimulatedTask.Type;

/** One pipeline's run: where each task stood over time, and how each ended. */
export const SimulatedRun = S.Struct({
  frames: S.Array(Frame),
  tasks: S.Array(SimulatedTask),
  /** The agent runs each seat opened, per role: a reviewer may share a rung's name. */
  runsBySeat: S.Struct({
    author: S.Record(S.String, S.Int),
    review: S.Record(S.String, S.Int),
  }),
  landed: S.Int,
  parked: S.Int,
  inFlight: S.Int,
  outside: S.Int,
});
export type SimulatedRun = typeof SimulatedRun.Type;

/** A rung's or reviewer's measured rates, as the simulator drew from them. */
export const RateView = S.Struct({
  rung: S.NullOr(S.String),
  role: Role,
  n: S.Int,
  label: Label,
  endings: S.Record(S.String, S.Finite),
  medianMinutes: S.NullOr(S.Finite),
});

export const CheckRateView = S.Struct({
  node: S.String,
  n: S.Int,
  label: Label,
  pass: S.Finite,
});

/** What a simulation assumes, which the dispatcher reads from the world instead. */
export const SimulateAssumes = S.Struct({
  accounts: S.String,
  gates: S.String,
  landings: S.String,
  checks: S.String,
  outcomes: S.String,
  durations: S.String,
  tasks: S.String,
  holds: S.String,
});

const PlayedFields = {
  problems: S.Array(S.String),
  ...SimulatedRun.fields,
};

export const SimulateReportView = S.Struct({
  project: S.String,
  seed: S.Int,
  hours: S.Finite,
  slots: S.Int,
  assumes: SimulateAssumes,
  rates: S.Array(RateView),
  checks: S.Array(CheckRateView),
  /** The run through the project's draft, or null when it has none. */
  draft: S.NullOr(S.Struct({ source: S.Literal("draft"), ...PlayedFields })),
  /** The run through the pipeline the project runs. */
  saved: S.Struct({ source: S.Literals(["saved", "standard"]), ...PlayedFields }),
});
export type SimulateReportView = typeof SimulateReportView.Type;
