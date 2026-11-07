/**
 * Pure helpers for exit-to-block wire drags: each drop candidate is a
 * PipelineChange, checked with problemsOf on the expansion (docs/web-ui.md).
 */
import { expand } from "foreman/composite";
import { problemsOf, type Composites, type Drawing, type SeatOffers } from "foreman/pipeline";
import { applyChange, type PipelineChange, type WireRef } from "foreman/pipeline-edit";
import { writtenDrawingOf } from "foreman/pipeline-layout";
import type { DrawingView, Flow } from "foreman/pipeline-view";

type WirePort = WireRef["port"];

/** Offers that accept the standard `ladder` / `reviewers` models with no seats listed. */
export const BROWSER_OFFERS: SeatOffers = { rungs: [], reviewers: [] };

/** One frame the editor draws: pipeline, its layout, and problems of the expansion. */
export type EditorFrame = {
  readonly pipeline: Drawing;
  readonly problems: ReadonlyArray<string>;
  readonly drawing: DrawingView;
  /** The change that produced this frame from the committed draft, if any. */
  readonly pending: PipelineChange | null;
};

/** Stable key for a wire port in test ids and SVG element ids. */
export const portKey = (port: WirePort): string =>
  typeof port === "number" ? `route-${port}` : port.replaceAll(":", "-");

/** Whether two wire ports are the same. */
export const samePort = (a: WirePort, b: WirePort): boolean => a === b;

/** Problems of a drawing after expand, as the page checks a drag candidate. */
export const problemsOfExpansion = (
  pipeline: Drawing,
  composites: Composites = {},
  offers: SeatOffers = BROWSER_OFFERS,
): ReadonlyArray<string> => {
  const expanded = expand(pipeline, composites);
  if (expanded._tag === "Failed") return expanded.problems;
  return problemsOf(expanded.pipeline, offers);
};

/** Frame for a drawing the stream (or an optimistic drop) already holds. */
export const frameOf = (
  pipeline: Drawing,
  problems: ReadonlyArray<string>,
  composites: Composites,
  flow: Flow,
  pending: PipelineChange | null = null,
): EditorFrame => ({
  pipeline,
  problems,
  drawing: writtenDrawingOf(pipeline, composites, flow),
  pending,
});

/**
 * The committed drawing with one wire's end moved to `to`. Block positions stay
 * put so dragology's closest snaps to the blocks the operator sees; a full
 * layoutOf runs only after the drop (optimistic draw / Pipeline stream).
 */
export const drawingWithRejoin = (drawing: DrawingView, wire: WireRef, to: string): DrawingView => {
  const end = inputPoint(drawing, to);
  if (end === undefined) return drawing;
  return {
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
  };
};

/**
 * Every Rejoin a drop of this exit can give, each checked with problemsOf.
 * Drawings keep the committed layout so closest matches the visible blocks.
 * The current target is included so closest can snap back to "no change".
 */
export const rejoinFrames = (
  pipeline: Drawing,
  wire: WireRef,
  composites: Composites,
  flow: Flow,
): ReadonlyArray<EditorFrame> => {
  const base = writtenDrawingOf(pipeline, composites, flow);
  const targets: Array<string> = pipeline.nodes
    .map((node) => node.id)
    .filter((id) => id !== wire.from);
  if (typeof wire.port === "string" && wire.port.startsWith("exit:")) {
    targets.push("queue");
  }
  const frames: Array<EditorFrame> = [];
  for (const to of targets) {
    const change: PipelineChange = { _tag: "Rejoin", wire, to };
    const result = applyChange(pipeline, change, composites);
    if (result._tag === "Refused") continue;
    frames.push({
      pipeline: result.pipeline,
      problems: problemsOfExpansion(result.pipeline, composites),
      drawing: drawingWithRejoin(base, wire, to),
      pending: change,
    });
  }
  return frames;
};

/** Left-centre of a block: where a wire enters. */
export const inputPoint = (
  drawing: DrawingView,
  id: string,
): readonly [number, number] | undefined => {
  if (id === "queue") {
    const source = drawing.blocks.find((block) => block.kind === "source");
    if (source === undefined) return undefined;
    return [source.x + source.w / 2, source.y];
  }
  const block = drawing.blocks.find((one) => one.id === id);
  if (block === undefined) return undefined;
  return [block.x, block.y + block.h / 2];
};

/** Where an exit's drag handle sits in this frame: at the target's input when rejoined, else at the wire's start. */
export const handlePoint = (
  frame: EditorFrame,
  wire: WireRef,
): readonly [number, number] | undefined => {
  const pending = frame.pending;
  if (
    pending?._tag === "Rejoin" &&
    pending.wire.from === wire.from &&
    samePort(pending.wire.port, wire.port)
  ) {
    return inputPoint(frame.drawing, pending.to);
  }
  const drawn = frame.drawing.wires.find(
    (one) => one.from === wire.from && samePort(one.port, wire.port),
  );
  return drawn?.points[0];
};
