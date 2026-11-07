/**
 * Pipeline editor: the project's draft drawn as wires (layoutOf via the stream's
 * DrawingView), with exit-to-block rejoins through dragology. Each drag lists
 * PipelineChange candidates; the preview snaps to the closest, green with no
 * problem and amber with the count from problemsOf on the expansion. A drop
 * sends one PipelineEdit and draws the dropped state until the stream catches up.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { type Draggable, DraggableRenderer, translate } from "dragology";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { Composites, Drawing } from "foreman/pipeline";
import type { WireRef } from "foreman/pipeline-edit";
import type { ShownPipeline, ViewOf } from "foreman/pipeline-view";
import { useEffect, useMemo, useState } from "react";
import {
  frameOf,
  handlePoint,
  inputPoint,
  portKey,
  rejoinFrames,
  samePort,
  type EditorFrame,
} from "./pipeline-preview.ts";
import { pageInputsAtom, pipelineAtom, UiRpc } from "./rpc.ts";

const FLOW = "across" as const;
const COMPOSITES: Composites = {};

const viewFrom = (shown: ShownPipeline): ViewOf =>
  shown.draft !== null
    ? shown.draft
    : { pipeline: shown.pipeline, problems: shown.problems, drawing: shown.drawing };

const wirePath = (points: ReadonlyArray<readonly [number, number]>): string => {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  return `M${first![0]} ${first![1]}` + rest.map(([x, y]) => `L${x} ${y}`).join("");
};

/** Default wire stroke; preview tones stay as stroke so dragology can lerp them. */
const WIRE_STROKE = "#656d76";
const WIRE_GOOD = "#1a7f37";
const WIRE_WARN = "#9a6700";

const EditorSvg: Draggable<EditorFrame> = ({ state, d, draggedId }) => {
  const { drawing, problems, pending } = state;
  const activeWire = pending?._tag === "Rejoin" ? pending.wire : null;

  return (
    <g>
      {drawing.wires.map((wire) => {
        const draggingThis =
          activeWire !== null &&
          wire.from === activeWire.from &&
          samePort(wire.port, activeWire.port);
        const stroke = draggingThis ? (problems.length === 0 ? WIRE_GOOD : WIRE_WARN) : WIRE_STROKE;
        return (
          <path
            id={`wire-${wire.from}-${portKey(wire.port)}`}
            d={wirePath(wire.points)}
            // className stays "wire": dragology cannot lerp "wire" vs "wire back".
            className="wire"
            stroke={stroke}
            strokeWidth={draggingThis ? 3 : 2}
            strokeDasharray={wire.back ? "6 4" : "0"}
            fill="none"
          />
        );
      })}
      {drawing.blocks.map((block) => (
        <g id={`block-${block.id}`} transform={translate(block.x, block.y)}>
          <rect width={block.w} height={block.h} rx={6} className="block" />
          <text x={10} y={18} className="block-label">
            {block.icon} {block.id}
          </text>
          <title>{block.summary}</title>
        </g>
      ))}
      {drawing.blocks.map((block) => {
        const at = inputPoint(drawing, block.id);
        if (at === undefined) return null;
        return (
          <circle
            id={`input-${block.id}`}
            data-testid={`block-${block.id}`}
            transform={translate(at[0], at[1])}
            r={10}
            className="input-dot"
          />
        );
      })}
      {drawing.wires.map((wire) => {
        const ref: WireRef = { from: wire.from, port: wire.port };
        const at = handlePoint(state, ref) ?? wire.points[0];
        if (at === undefined) return null;
        const id = `exit-${wire.from}-${portKey(wire.port)}`;
        return (
          <circle
            id={id}
            data-testid={id}
            transform={translate(at[0], at[1])}
            r={7}
            className="exit-dot"
            dragologyZIndex={draggedId === id ? "/1" : false}
            dragologyOnDrag={() => {
              const committed: EditorFrame = {
                pipeline: state.pipeline,
                problems: state.problems,
                drawing: state.drawing,
                pending: null,
              };
              const frames = rejoinFrames(committed.pipeline, ref, COMPOSITES, FLOW);
              const options = frames.length === 0 ? [committed] : frames;
              return d.closest(options).whenFar(committed, { gap: 160 }).withFloating();
            }}
          />
        );
      })}
    </g>
  );
};

const Toolbar = ({
  project,
  hasDraft,
  problems,
}: {
  readonly project: string;
  readonly hasDraft: boolean;
  readonly problems: ReadonlyArray<string>;
}) => {
  const save = useAtomSet(UiRpc.mutation("PipelineSave"), { mode: "promise" });
  const discard = useAtomSet(UiRpc.mutation("PipelineDiscard"), { mode: "promise" });
  const [busy, setBusy] = useState<"save" | "discard" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (kind: "save" | "discard") => {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "save") {
        await save({ payload: { project } });
        setMessage("Saved.");
      } else {
        await discard({ payload: { project } });
        setMessage("Discarded.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pipeline-toolbar" data-testid="pipeline-toolbar">
      <span className="muted" data-testid="pipeline-problems">
        {problems.length === 0
          ? "No problems"
          : `${problems.length} problem${problems.length === 1 ? "" : "s"}`}
      </span>
      {hasDraft ? (
        <>
          <button
            type="button"
            data-testid="pipeline-save"
            disabled={busy !== null || problems.length > 0}
            onClick={() => void run("save")}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            data-testid="pipeline-discard"
            disabled={busy !== null}
            onClick={() => void run("discard")}
          >
            {busy === "discard" ? "Discarding…" : "Discard"}
          </button>
        </>
      ) : (
        <span className="muted">No draft open</span>
      )}
      {message !== null ? (
        <span className="muted" data-testid="pipeline-toolbar-message">
          {message}
        </span>
      ) : null}
    </div>
  );
};

const sameDrawing = (a: Drawing, b: Drawing): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The editor for one project's pipeline on `/p/<project>`. */
export const PipelineEditor = ({ project }: { readonly project: string }) => {
  const shownResult = useAtomValue(pipelineAtom(project));
  const inputs = useAtomValue(pageInputsAtom);
  const edit = useAtomSet(UiRpc.mutation("PipelineEdit"), { mode: "promise" });

  const remote = AsyncResult.isSuccess(shownResult) ? shownResult.value : null;
  const remoteView = remote === null ? null : viewFrom(remote);

  const [optimistic, setOptimistic] = useState<EditorFrame | null>(null);
  const [frame, setFrame] = useState<EditorFrame | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (remoteView === null || dragging) return;
    if (optimistic !== null && sameDrawing(remoteView.pipeline, optimistic.pipeline)) {
      setOptimistic(null);
    }
    if (optimistic !== null) return;
    setFrame(frameOf(remoteView.pipeline, remoteView.problems, COMPOSITES, FLOW));
  }, [remoteView, dragging, optimistic]);

  const display = optimistic ?? frame;

  const onDropState = (next: EditorFrame) => {
    setDragging(false);
    const change = next.pending;
    if (change === null) {
      setFrame(next);
      return;
    }
    const baseline = optimistic?.pipeline ?? remoteView?.pipeline;
    if (baseline !== undefined && sameDrawing(next.pipeline, baseline)) {
      setFrame(frameOf(baseline, remoteView?.problems ?? next.problems, COMPOSITES, FLOW));
      return;
    }
    inputs.onPipelineEdit?.(change);
    // Keep the dropped drawing (committed layout + moved wire). A full layoutOf
    // here flips wire.back flags and breaks dragology's drop spring.
    const dropped: EditorFrame = {
      pipeline: next.pipeline,
      problems: next.problems,
      drawing: next.drawing,
      pending: null,
    };
    setOptimistic(dropped);
    setFrame(dropped);
    void edit({ payload: { project, change, flow: FLOW } }).catch(() => {
      setOptimistic(null);
    });
  };

  const hint = useMemo(() => {
    if (!dragging || display === null || display.pending === null) return null;
    const count = display.problems.length;
    return {
      tone: count === 0 ? ("green" as const) : ("amber" as const),
      problems: count,
      text:
        count === 0
          ? "Drop here: the result passes the drawing check."
          : `Drop here: the result has ${count} problem${count === 1 ? "" : "s"}.`,
    };
  }, [dragging, display]);

  if (!AsyncResult.isSuccess(shownResult)) {
    return (
      <div className="pipeline-editor" data-testid="pipeline-editor">
        <p className="muted" data-testid="pipeline-loading">
          {AsyncResult.isFailure(shownResult)
            ? "Could not load the pipeline."
            : "Loading pipeline…"}
        </p>
      </div>
    );
  }

  if (display === null) {
    return (
      <div className="pipeline-editor" data-testid="pipeline-editor">
        <p className="muted">Loading pipeline…</p>
      </div>
    );
  }

  const width = Math.max(display.drawing.width, 640);
  const height = Math.max(display.drawing.height, 240);

  return (
    <div className="pipeline-editor" data-testid="pipeline-editor">
      <Toolbar
        project={project}
        hasDraft={remote?.draft !== null || optimistic !== null}
        problems={
          display.pending === null ? display.problems : (remoteView?.problems ?? display.problems)
        }
      />
      {hint !== null ? (
        <div
          className={`drag-preview tone-${hint.tone}`}
          data-testid="drag-preview"
          data-tone={hint.tone}
          data-problems={String(hint.problems)}
        >
          {hint.text}
        </div>
      ) : null}
      <div className="pipeline-canvas" data-testid="pipeline-canvas">
        <DraggableRenderer
          draggable={EditorSvg}
          state={display}
          width={width}
          height={height}
          onDragState={(next) => {
            setDragging(true);
            setFrame(next);
          }}
          onDropState={onDropState}
          onDragStatus={(status) => {
            if (status.type === "idle") setDragging(false);
          }}
        />
      </div>
      {(display.pending === null ? display.problems : (remoteView?.problems ?? [])).length > 0 ? (
        <ul className="pipeline-problem-list" data-testid="pipeline-problem-list">
          {(display.pending === null ? display.problems : (remoteView?.problems ?? [])).map(
            (problem) => (
              <li key={problem}>{problem}</li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
};
