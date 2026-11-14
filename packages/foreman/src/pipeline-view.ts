/**
 * The JSON views the pipeline and composite verbs return, as Schemas. The verbs
 * are typed by these, and the UI contract sends them, so a page decodes the
 * same definition the CLI prints (`docs/web-ui.md`).
 *
 * Browser-safe: this module imports pure schema modules only, never I/O.
 */
import { Schema as S } from "effect";
import { CompositeDefinition, Composites, LANDINGS, Drawing } from "./pipeline.ts";
import { STEPS } from "./policy.ts";
import { WirePort } from "./pipeline-edit.ts";

/** Which way work moves through a drawing: left to right, or top to bottom. */
export const Flow = S.Literals(["across", "down"]);
export type Flow = typeof Flow.Type;

const Point = S.Tuple([S.Finite, S.Finite]);

/** One block of a laid-out drawing, with the words on its card. */
export const BlockView = S.Struct({
  id: S.String,
  kind: S.Literals([
    "source",
    "router",
    "gate",
    "agent",
    "check",
    "branch",
    "worktree",
    "land",
    "done",
    "park",
    "composite",
  ]),
  icon: S.String,
  summary: S.String,
  /** Expanded block ids inside a composite instance; absent for every other kind. */
  covers: S.optional(S.Array(S.String)),
  /** A composite instance's ways in: each entry's name, and the wire target that reaches it. */
  entries: S.optional(S.Array(S.Struct({ id: S.String, name: S.String, target: S.String }))),
  /** A composite instance's exits by the definition's names, including those with no wire. */
  exits: S.optional(S.Array(S.Struct({ id: S.String, name: S.String, to: S.optional(S.String) }))),
  x: S.Finite,
  y: S.Finite,
  w: S.Finite,
  h: S.Finite,
});
export type BlockView = typeof BlockView.Type;

/** One wire of a laid-out drawing, as the corners of its route. */
export const WireView = S.Struct({
  from: S.String,
  port: WirePort,
  to: S.String,
  label: S.String,
  /** The entry id the wire enters a composite instance by, when it names one. */
  entry: S.optional(S.String),
  /** Whether the wire runs against the flow, back along a return lane. */
  back: S.Boolean,
  points: S.Array(Point),
  anchor: Point,
  plus: Point,
});
export type WireView = typeof WireView.Type;

/**
 * A pipeline as a renderer draws it, in plain JSON: each block at its box and
 * each wire as the corners of its route. A renderer that cannot run foreman's
 * modules draws the same picture from this.
 */
export const DrawingView = S.Struct({
  flow: Flow,
  width: S.Finite,
  height: S.Finite,
  blocks: S.Array(BlockView),
  wires: S.Array(WireView),
});
export type DrawingView = typeof DrawingView.Type;

/** What an editor offers for a block's settings (`choicesOf`). */
export const ChoicesView = S.Struct({
  insertable: S.Array(S.Literals(["branch", "worktree", "gate", "agent", "check", "router"])),
  composites: S.Array(S.String),
  steps: S.Array(S.Literals(STEPS)),
  roles: S.Array(S.Literals(["author", "review"])),
  landings: S.Array(S.Literals(LANDINGS)),
});
export type ChoicesView = typeof ChoicesView.Type;

/** A drawing with its expansion problems, as the page draws and checks it. */
export const ViewOf = S.Struct({
  pipeline: Drawing,
  problems: S.Array(S.String),
  drawing: DrawingView,
});
export type ViewOf = typeof ViewOf.Type;

/** What an agent block may name: the rungs, each with whether it may author, and the reviewers. */
export const SeatOffersView = S.Struct({
  rungs: S.Array(S.Struct({ name: S.String, author: S.Boolean })),
  reviewers: S.Array(S.String),
});
export type SeatOffersView = typeof SeatOffersView.Type;

/**
 * A project's pipeline as `pipeline show` prints it, and the view every edit returns.
 * `composites` and `offers` are the inputs the server checks the pipeline with, so a
 * page checks a candidate drawing with the same `problemsOf` inputs.
 */
export const ShownPipeline = S.Struct({
  project: S.String,
  drawn: S.Boolean,
  choices: S.Struct({
    ...ChoicesView.fields,
    unsaved: S.Array(S.String),
  }),
  composites: Composites,
  offers: SeatOffersView,
  ...ViewOf.fields,
  draft: S.NullOr(ViewOf),
});
export type ShownPipeline = typeof ShownPipeline.Type;

/** What `pipeline show --json` prints: the shown pipeline, its label and its mermaid text. */
export const PipelineShowView = S.Struct({
  ...ShownPipeline.fields,
  label: S.String,
  mermaid: S.NullOr(S.String),
});
export type PipelineShowView = typeof PipelineShowView.Type;

/** What `pipeline edit --json` prints: the shown pipeline and the block the edit added. */
export const PipelineEditView = S.Struct({
  ...ShownPipeline.fields,
  added: S.NullOr(S.String),
});
export type PipelineEditView = typeof PipelineEditView.Type;

/** A composite definition as the pane draws and edits it. */
export const CompositeView = S.Struct({
  name: S.String,
  definition: CompositeDefinition,
  pipeline: Drawing,
  drawing: DrawingView,
  choices: S.Struct({
    ...ChoicesView.fields,
    outs: S.Array(S.Struct({ id: S.String, name: S.String })),
  }),
  entries: CompositeDefinition.fields.entries,
  draft: S.NullOr(
    S.Struct({
      base: S.NullOr(CompositeDefinition),
      definition: CompositeDefinition,
    }),
  ),
  live: S.NullOr(CompositeDefinition),
});
export type CompositeView = typeof CompositeView.Type;

/** What `composite edit --json` prints: the composite view and the block the edit added. */
export const CompositeEditView = S.Struct({
  ...CompositeView.fields,
  added: S.NullOr(S.String),
});
export type CompositeEditView = typeof CompositeEditView.Type;

/** What `pipeline instructions` answers: the file's text, or the path it wrote. */
export const InstructionsView = S.Union([
  S.Struct({ _tag: S.Literal("Read"), text: S.String }),
  S.Struct({ _tag: S.Literal("Wrote"), file: S.String }),
]);
export type InstructionsView = typeof InstructionsView.Type;
