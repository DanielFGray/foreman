/**
 * Pure helpers for exit-to-block wire drags: each drop candidate is a
 * PipelineChange, checked with problemsOf on the expansion (docs/web-ui.md).
 */
import { Option } from "effect";
import { expand } from "foreman/composite";
import { problemsOf, type Composites, type Drawing } from "foreman/pipeline";
import { applyChange, type PipelineChange, type WireRef } from "foreman/pipeline-edit";
import { writtenDrawingOf } from "foreman/pipeline-layout";
import type { DrawingView, Flow, ShownPipeline, ViewOf } from "foreman/pipeline-view";

type WirePort = WireRef["port"];
type Point = readonly [number, number];

/** The definitions and offers the server checks a pipeline with, as the Pipeline stream sends them. */
export type CheckInputs = Pick<ShownPipeline, "composites" | "offers">;

/** The parts of the server's view the editor draws from. */
export type ServerView = Pick<
  ShownPipeline,
  "pipeline" | "problems" | "drawing" | "draft" | "composites" | "offers"
>;

/**
 * One frame the editor draws: pipeline, its layout, and problems of the expansion.
 * `checks` are the inputs those problems were checked with, so a drag from this
 * frame checks its candidates the same way.
 */
export type EditorFrame = {
  readonly pipeline: Drawing;
  readonly problems: ReadonlyArray<string>;
  readonly drawing: DrawingView;
  readonly checks: CheckInputs;
  /** The direction `drawing` is laid out in. */
  readonly flow: Flow;
  /** The change a drag candidate makes to the frame it started from. */
  readonly pending: Option.Option<PipelineChange>;
};

/**
 * The frame the page shows: the server's view with the edits it has not
 * answered yet replayed over it, oldest first. An edit the view no longer
 * takes is left out, since the server refuses it too and its answer says why.
 * With no edit waiting, the problems are the server's own.
 */
export const frameAfter = (
  shown: ServerView,
  unanswered: ReadonlyArray<PipelineChange>,
  flow: Flow,
): EditorFrame => {
  const view = viewOf(shown);
  const replayed = unanswered.reduce(
    (state: { readonly pipeline: Drawing; readonly composites: Composites }, change) => {
      const result = applyChange(state.pipeline, change, state.composites);
      return result._tag === "Refused"
        ? state
        : { pipeline: result.pipeline, composites: { ...state.composites, ...result.composites } };
    },
    { pipeline: view.pipeline, composites: shown.composites },
  );
  const checks: CheckInputs = { composites: replayed.composites, offers: shown.offers };
  const problems =
    unanswered.length === 0 ? view.problems : problemsOfExpansion(replayed.pipeline, checks);
  return frameOf(replayed.pipeline, problems, checks, flow);
};

/** The draft the server shows, else the pipeline the project runs. */
export const viewOf = (shown: ServerView): ViewOf =>
  shown.draft !== null
    ? shown.draft
    : { pipeline: shown.pipeline, problems: shown.problems, drawing: shown.drawing };

/** Stable key for a wire port in test ids and SVG element ids. */
export const portKey = (port: WirePort): string =>
  typeof port === "number" ? `route-${port}` : port.replaceAll(":", "-");

/** Whether two wire ports are the same. */
export const samePort = (a: WirePort, b: WirePort): boolean => a === b;

/** Problems of a drawing after expand, as the page checks a drag candidate. */
export const problemsOfExpansion = (
  pipeline: Drawing,
  checks: CheckInputs,
): ReadonlyArray<string> => {
  const expanded = expand(pipeline, checks.composites);
  if (expanded._tag === "Failed") return expanded.problems;
  return problemsOf(expanded.pipeline, checks.offers);
};

/** Frame for a drawing with nothing pending. */
export const frameOf = (
  pipeline: Drawing,
  problems: ReadonlyArray<string>,
  checks: CheckInputs,
  flow: Flow,
): EditorFrame => ({
  pipeline,
  problems,
  drawing: writtenDrawingOf(pipeline, checks.composites, flow),
  checks,
  flow,
  pending: Option.none(),
});

/**
 * The committed drawing with one wire's end moved to `to`. Block positions stay
 * put so dragology's closest snaps to the blocks the operator sees; a full
 * layoutOf runs only after the drop.
 */
export const drawingWithRejoin = (drawing: DrawingView, wire: WireRef, to: string): DrawingView =>
  Option.match(inputPoint(drawing, to), {
    onNone: () => drawing,
    onSome: (end) => ({
      ...drawing,
      wires: drawing.wires.map((one) => {
        if (one.from !== wire.from || !samePort(one.port, wire.port)) return one;
        const start = one.points[0] ?? one.anchor;
        const midX = (start[0] + end[0]) / 2;
        return {
          ...one,
          to,
          points: [start, [midX, start[1]], [midX, end[1]], end],
        };
      }),
    }),
  });

/**
 * Every Rejoin a drop of this exit can give, each checked with problemsOf.
 * Drawings keep the committed layout so closest matches the visible blocks.
 * The current target is included so closest can snap back to "no change".
 */
export const rejoinFrames = (
  pipeline: Drawing,
  wire: WireRef,
  checks: CheckInputs,
  flow: Flow,
): ReadonlyArray<EditorFrame> => {
  const base = writtenDrawingOf(pipeline, checks.composites, flow);
  const blocks = pipeline.nodes.map((node) => node.id).filter((id) => id !== wire.from);
  const targets =
    typeof wire.port === "string" && wire.port.startsWith("exit:") ? [...blocks, "queue"] : blocks;
  return targets.flatMap((to): ReadonlyArray<EditorFrame> => {
    const change: PipelineChange = { _tag: "Rejoin", wire, to };
    const result = applyChange(pipeline, change, checks.composites);
    return result._tag === "Refused"
      ? []
      : [
          {
            pipeline: result.pipeline,
            problems: problemsOfExpansion(result.pipeline, checks),
            drawing: drawingWithRejoin(base, wire, to),
            checks,
            flow,
            pending: Option.some(change),
          },
        ];
  });
};

/** Left-centre of a block: where a wire enters. The queue's is the top of the source block. */
export const inputPoint = (drawing: DrawingView, id: string): Option.Option<Point> =>
  id === "queue"
    ? Option.map(
        Option.fromNullishOr(drawing.blocks.find((block) => block.kind === "source")),
        (source): Point => [source.x + source.w / 2, source.y],
      )
    : Option.map(
        Option.fromNullishOr(drawing.blocks.find((one) => one.id === id)),
        (block): Point => [block.x, block.y + block.h / 2],
      );

/** Where an exit's drag handle sits in this frame: at the target's input when rejoined, else at the wire's start. */
export const handlePoint = (frame: EditorFrame, wire: WireRef): Option.Option<Point> =>
  Option.match(
    Option.filter(frame.pending, (change) => movesWire(change, wire)),
    {
      onSome: (change) =>
        change._tag === "Rejoin" ? inputPoint(frame.drawing, change.to) : Option.none(),
      onNone: () =>
        Option.fromNullishOr(
          frame.drawing.wires.find((one) => one.from === wire.from && samePort(one.port, wire.port))
            ?.points[0],
        ),
    },
  );

/** Whether a change rejoins this wire. */
export const movesWire = (change: PipelineChange, wire: WireRef): boolean =>
  change._tag === "Rejoin" &&
  change.wire.from === wire.from &&
  samePort(change.wire.port, wire.port);
