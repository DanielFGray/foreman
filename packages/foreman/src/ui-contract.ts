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
  PromptError,
  RecordsError,
  RegistryError,
  RewriteError,
  TrackerError,
} from "./errors.ts";
import { PipelineChange, CompositeChange } from "./pipeline-edit.ts";
import { GraphView } from "./pipeline-graph-view.ts";
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
import { Published, PublishedRow } from "./published-schema.ts";

const flowField = Flow.pipe(S.withDecodingDefault(Effect.succeed("across" as const)));

/** Temporary: trace, simulate and graph views until their Schemas land. */
const JsonView = S.Any;

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
  success: JsonView,
  error: S.Union([PipelineError]),
});

export const PipelineSimulate = Rpc.make("PipelineSimulate", {
  payload: {
    project: S.String,
    seed: S.Int.pipe(S.withDecodingDefault(Effect.succeed(1))),
    hours: S.Finite.pipe(S.withDecodingDefault(Effect.succeed(72))),
  },
  success: JsonView,
  error: S.Union([PathsError, PipelineError, RecordsError, RegistryError, TrackerError]),
});

export const PipelineGraph = Rpc.make("PipelineGraph", {
  payload: { project: S.String },
  success: GraphView,
  error: S.Union([PipelineError, RecordsError, TrackerError]),
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
  CompositeShow,
  CompositeEdit,
  CompositeSave,
  CompositeDiscard,
  CompositePrompt,
);
