/**
 * The graph report `pipeline graph --json` prints, as Schemas. Browser-safe:
 * the pure rules in `pipeline-graph.ts` build it, and the page decodes it.
 */
import { Schema as S } from "effect";
import type { TaskState } from "tasks/item";
import { STEP_MODES, STEPS } from "./policy.ts";

const Step = S.Literals(STEPS);

/** A grant that lets the dispatcher take some of the steps a pipeline gates on. */
export const CoveringGrantView = S.Struct({
  scope: S.String,
  /** For a task, the steps of `grantSteps` it lets the dispatcher take; for an epic, the grant's steps. */
  steps: S.Array(Step),
  /** How many more tasks the grant admits, when it has a count. */
  left: S.NullOr(S.Int),
});
export type CoveringGrantView = typeof CoveringGrantView.Type;

/** A task or epic in the graph, placed in its column and row. */
export const GraphItemView = S.Struct({
  id: S.String,
  title: S.String,
  type: S.Literals(["task", "epic"]),
  status: S.String,
  priority: S.Finite,
  parent: S.NullOr(S.String),
  /** 0 for an item no shown item blocks; else one past its furthest shown blocker. */
  column: S.Int,
  /** Its place within the column, from 0 at the top. */
  row: S.Int,
  /** Every unfinished item it waits for, shown or not. */
  waitsFor: S.Array(S.String),
  grant: S.NullOr(CoveringGrantView),
});
export type GraphItemView = typeof GraphItemView.Type;

/** A dependency between two shown items: `item` waits for `dependsOn`. */
export const EdgeView = S.Struct({ item: S.String, dependsOn: S.String });

export const GraphView = S.Struct({
  project: S.String,
  items: S.Array(GraphItemView),
  /** The edges between shown items. */
  edges: S.Array(EdgeView),
  /** Each step a gate in the project's pipeline names, with its mode for the project. */
  steps: S.Array(S.Struct({ step: Step, mode: S.Literals(STEP_MODES) })),
  /** The steps a grant from the pane gives: the gated steps that are not on. */
  grantSteps: S.Array(Step),
});
export type GraphView = typeof GraphView.Type;

/** The statuses a graph shows when none are asked for: the work still to do. */
export const GRAPH_STATUSES: ReadonlyArray<TaskState> = ["open", "in_progress"];

/** The statuses that resolve a dependency: its blocker no longer holds anything back. */
export const FINISHED: ReadonlySet<string> = new Set(["done", "canceled"]);
