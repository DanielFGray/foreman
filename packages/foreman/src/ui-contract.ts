/**
 * The RpcGroup the web UI page and the UI server share (`docs/web-ui.md`).
 *
 * Each procedure's Schemas are foreman's: streams push readings, pipeline and
 * queue views; verbs call the same Effect functions the CLI uses.
 */
import { Effect, Schema as S } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  FleetError,
  PathsError,
  PipelineError,
  PolicyError,
  PromptError,
  RecordsError,
  Refused,
  RegistryError,
  RepositoryError,
  RewriteError,
  TrackerError,
} from "./errors.ts";
import { PipelineChange, CompositeChange } from "./pipeline-edit.ts";
import { GraphView } from "./pipeline-graph-view.ts";
import { Policy, STEPS } from "./policy.ts";
import { TaskState } from "tasks/item";
import { TraceReportView } from "./pipeline-trace-view.ts";
import { SimulateReportView } from "./pipeline-simulate-view.ts";
import {
  CompositeEditView,
  CompositeView,
  Flow,
  InstructionsView,
  PipelineEditView,
  PipelineShowView,
  ShownPipeline,
} from "./pipeline-view.ts";
import { TraceRequest } from "./trace-request.ts";
import { MetricsRun } from "./metrics.ts";
import { Published, PublishedRow } from "./published-schema.ts";
import { INTERVENTIONS, KEY_ONLY_ACTIONS } from "./view-names.ts";

const flowField = Flow.pipe(S.withDecodingDefault(Effect.succeed("across" as const)));

/** Streams that push a value at once and again at each change. */
export const Readings = Rpc.make("Readings", {
  success: Published,
  stream: true,
});

export const Pipeline = Rpc.make("Pipeline", {
  payload: { project: S.String, flow: flowField },
  success: ShownPipeline,
  error: S.Union([PathsError, PipelineError, RegistryError]),
  stream: true,
});

export const Queue = Rpc.make("Queue", {
  payload: { project: S.String },
  success: S.Array(PublishedRow),
  error: S.Union([FleetError, RecordsError, TrackerError]),
  stream: true,
});

/** Pipeline verbs: one Rpc per exported Effect in `pipeline-command.ts`. */
export const PipelineShow = Rpc.make("PipelineShow", {
  payload: { project: S.String, flow: flowField },
  success: PipelineShowView,
  error: S.Union([PathsError, PipelineError, RegistryError]),
});

export const PipelineEdit = Rpc.make("PipelineEdit", {
  payload: { project: S.String, change: PipelineChange, flow: flowField },
  success: PipelineEditView,
  error: S.Union([PathsError, PipelineError, RegistryError, RewriteError]),
});

export const PipelineSave = Rpc.make("PipelineSave", {
  payload: { project: S.String },
  success: S.String,
  error: S.Union([PathsError, PipelineError, RegistryError, RewriteError]),
});

export const PipelineDiscard = Rpc.make("PipelineDiscard", {
  payload: { project: S.String },
  success: S.String,
  error: S.Union([RewriteError]),
});

export const PipelineInstructions = Rpc.make("PipelineInstructions", {
  payload: {
    name: S.String,
    text: S.optional(S.String),
  },
  success: InstructionsView,
  error: S.Union([PathsError, PipelineError, PromptError]),
});

export const PipelinePrompt = Rpc.make("PipelinePrompt", {
  payload: { project: S.String, block: S.String },
  success: S.String,
  error: S.Union([PathsError, PipelineError, PromptError]),
});

export const PipelineTrace = Rpc.make("PipelineTrace", {
  payload: { project: S.String, request: TraceRequest },
  success: TraceReportView,
  error: S.Union([PipelineError]),
});

export const PipelineSimulate = Rpc.make("PipelineSimulate", {
  payload: {
    project: S.String,
    seed: S.Int.pipe(S.withDecodingDefault(Effect.succeed(1))),
    hours: S.Finite.pipe(S.withDecodingDefault(Effect.succeed(72))),
  },
  success: SimulateReportView,
  error: S.Union([PathsError, PipelineError, RecordsError, RegistryError, TrackerError]),
});

export const PipelineGraph = Rpc.make("PipelineGraph", {
  payload: {
    project: S.String,
    statuses: S.Array(TaskState),
  },
  success: GraphView,
  error: S.Union([PipelineError, RecordsError, TrackerError]),
});

/** The closed agent runs of the last `days` days, or of all time for null. */
export const Metrics = Rpc.make("Metrics", {
  payload: { days: S.NullOr(S.Int) },
  success: S.Array(MetricsRun),
  error: S.Union([RecordsError, TrackerError]),
});

/** Policy verbs: one Rpc per exported Effect in `policy-command.ts`. */
export const PolicyGrant = Rpc.make("PolicyGrant", {
  payload: {
    scope: S.String,
    steps: S.Array(S.Literals(STEPS)),
    remaining: S.OptionFromOptional(S.Int),
  },
  success: Policy,
  error: S.Union([PolicyError]),
});

export const PolicyRevoke = Rpc.make("PolicyRevoke", {
  payload: { scope: S.String },
  success: Policy,
  error: S.Union([PolicyError]),
});

export const PolicyPause = Rpc.make("PolicyPause", {
  payload: { project: S.OptionFromOptional(S.String) },
  success: Policy,
  error: S.Union([PolicyError]),
});

export const PolicyResume = Rpc.make("PolicyResume", {
  payload: { project: S.OptionFromOptional(S.String) },
  success: Policy,
  error: S.Union([PolicyError]),
});

export const PolicySlots = Rpc.make("PolicySlots", {
  payload: { count: S.Int.check(S.isGreaterThan(0)) },
  success: Policy,
  error: S.Union([PolicyError]),
});

/**
 * A row action and what it takes beyond the row's key: `complete` a reason for
 * the task log, `kill` an optional one, and `intervene` how to resume and,
 * except for a review, the rung.
 */
export const RowAction = S.Union([
  S.TaggedStruct("complete", { reason: S.String }),
  S.TaggedStruct("kill", { reason: S.OptionFromOptional(S.String) }),
  S.TaggedStruct("intervene", {
    how: S.Literals(INTERVENTIONS),
    rung: S.OptionFromOptional(S.String),
  }),
  S.Struct({ _tag: S.Literals(KEY_ONLY_ACTIONS) }),
]);
export type RowAction = typeof RowAction.Type;

/** Runs one row action, as `foreman <action> <id>` does: one Rpc for every verb in `ACTIONS_LIST`. */
export const TaskAction = Rpc.make("TaskAction", {
  payload: { id: S.String, action: RowAction },
  error: S.Union([
    Refused,
    FleetError,
    PolicyError,
    PromptError,
    RecordsError,
    RepositoryError,
    TrackerError,
  ]),
});

/** Composite verbs: one Rpc per exported Effect in `composite-command.ts`. */
export const CompositeShow = Rpc.make("CompositeShow", {
  payload: { name: S.String, flow: flowField },
  success: CompositeView,
  error: S.Union([PipelineError]),
});

export const CompositeEdit = Rpc.make("CompositeEdit", {
  payload: { name: S.String, change: CompositeChange, flow: flowField },
  success: CompositeEditView,
  error: S.Union([PipelineError, RewriteError]),
});

export const CompositeSave = Rpc.make("CompositeSave", {
  payload: { name: S.String },
  success: S.String,
  error: S.Union([PathsError, PipelineError, RegistryError, RewriteError]),
});

export const CompositeDiscard = Rpc.make("CompositeDiscard", {
  payload: { name: S.String },
  success: S.String,
  error: S.Union([RewriteError]),
});

export const CompositePrompt = Rpc.make("CompositePrompt", {
  payload: { name: S.String, block: S.String },
  success: S.String,
  error: S.Union([PathsError, PipelineError, PromptError]),
});

/** The contract the page and the UI server share. */
export const UiContract = RpcGroup.make(
  Readings,
  Pipeline,
  Queue,
  PipelineShow,
  PipelineEdit,
  PipelineSave,
  PipelineDiscard,
  PipelineInstructions,
  PipelinePrompt,
  PipelineTrace,
  PipelineSimulate,
  PipelineGraph,
  Metrics,
  PolicyGrant,
  PolicyRevoke,
  PolicyPause,
  PolicyResume,
  PolicySlots,
  TaskAction,
  CompositeShow,
  CompositeEdit,
  CompositeSave,
  CompositeDiscard,
  CompositePrompt,
);
