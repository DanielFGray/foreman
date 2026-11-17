/**
 * Pipeline editor: the project's draft drawn as wires (layoutOf via the stream's
 * DrawingView), with exit-to-block rejoins through dragology, a palette that
 * places blocks and an inspector that sets the clicked one (`pipeline-blocks`).
 * Each drag lists PipelineChange candidates; the preview snaps to the closest,
 * green with no problem and amber with the count from problemsOf on the
 * expansion.
 *
 * The page holds the newest view the server sent (a Pipeline stream frame or an
 * edit's answer) and the edits it has not answered, and draws the edits
 * replayed over the view (`frameAfter`). Edits go to the server one at a time,
 * in drop order, so the replay matches what the server applies. Nothing else
 * holds a drawing, so a view that differs from what the page dropped is drawn
 * as soon as it arrives.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { type Draggable, DraggableRenderer, translate } from "dragology";
import { Exit, Option } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { Drawing } from "foreman/pipeline";
import type { PipelineChange, WireRef } from "foreman/pipeline-edit";
import type { ShownPipeline } from "foreman/pipeline-view";
import { useEffect, useMemo, useRef, useState } from "react";
import { Inspector, Palette } from "./pipeline-blocks.tsx";
import {
  frameAfter,
  handlePoint,
  inputPoint,
  movesWire,
  portKey,
  rejoinFrames,
  type EditorFrame,
} from "./pipeline-preview.ts";
import { pipelineAtom, UiRpc } from "./rpc.ts";
import { useFlow, useWidth } from "./screen.ts";
import { reasonOf } from "./reason.ts";

/** The editor for one project's pipeline on `/p/<project>`. */
export const PipelineEditor = ({ project }: { readonly project: string }) => {
  const flow = useFlow();
  const [canvasWidth, canvasRef] = useWidth();
  const streamed = useAtomValue(pipelineAtom(project)(flow));
  const edit = useAtomSet(UiRpc.mutation("PipelineEdit"), { mode: "promiseExit" });

  const [reading, setReading] = useState<Option.Option<ShownPipeline>>(Option.none());
  /** Edits sent or waiting to be sent, oldest first; only the first is in flight. */
  const [unanswered, setUnanswered] = useState<ReadonlyArray<PipelineChange>>([]);
  /** The frame dragology reports while a drag is under way. */
  const [dragFrame, setDragFrame] = useState<Option.Option<EditorFrame>>(Option.none());
  const [message, setMessage] = useState<Option.Option<string>>(Option.none());
  /** The block the inspector sets, by id. */
  const [selected, setSelected] = useState<Option.Option<string>>(Option.none());
  const draggable = useMemo(() => editorSvgOf(selected, setSelected), [selected]);
  /** The edit already sent, so a re-render does not send it twice. */
  const sending = useRef<Option.Option<PipelineChange>>(Option.none());

  useEffect(() => {
    if (AsyncResult.isSuccess(streamed)) setReading(Option.some(streamed.value));
  }, [streamed]);

  const head = unanswered[0];
  useEffect(() => {
    if (head === undefined || Option.contains(sending.current, head)) return;
    sending.current = Option.some(head);
    void edit({ payload: { project, change: head, flow } }).then(
      Exit.match({
        onSuccess: (answer) => {
          setReading(Option.some(answer));
          setUnanswered((queue) => queue.slice(1));
        },
        // The edits after a refused one were drawn over it, so they go too.
        onFailure: (cause) => {
          setUnanswered([]);
          setMessage(Option.some(`Edit not saved: ${reasonOf(cause)}`));
        },
      }),
    );
  }, [head, edit, project, flow]);

  const shown = Option.map(reading, (view) => frameAfter(view, unanswered, flow));

  const queueEdit = (change: PipelineChange) => {
    setUnanswered((queue) => [...queue, change]);
    setMessage(Option.none());
    if (change._tag === "Place") setSelected(Option.some(change.id));
  };

  const onDropState = (dropped: EditorFrame) => {
    const changed = Option.exists(shown, (frame) => !sameDrawing(frame.pipeline, dropped.pipeline));
    Option.map(
      Option.filter(dropped.pending, () => changed),
      queueEdit,
    );
  };

  if (AsyncResult.isFailure(streamed)) {
    return (
      <div className="pipeline-editor" data-testid="pipeline-editor">
        <p className="muted" data-testid="pipeline-loading">
          Could not load the pipeline.
        </p>
      </div>
    );
  }

  return Option.match(Option.all({ base: shown, view: reading }), {
    onNone: () => (
      <div className="pipeline-editor" data-testid="pipeline-editor">
        <p className="muted" data-testid="pipeline-loading">
          Loading pipeline…
        </p>
      </div>
    ),
    onSome: ({ base, view }) => {
      const display = Option.getOrElse(dragFrame, () => base);
      const hint = Option.flatMap(dragFrame, (frame) =>
        Option.map(frame.pending, () => hintOf(frame.problems.length)),
      );
      return (
        <div className="pipeline-editor" data-testid="pipeline-editor">
          <Toolbar
            project={project}
            hasDraft={view.draft !== null || unanswered.length > 0}
            problems={base.problems}
            message={message}
            onMessage={setMessage}
          />
          <Palette
            composites={view.choices.composites}
            empty={base.pipeline.nodes.length === 0}
            onEdit={queueEdit}
          />
          {Option.match(hint, {
            onNone: () => null,
            onSome: (shownHint) => (
              <div
                className={`drag-preview tone-${shownHint.tone}`}
                data-testid="drag-preview"
                data-tone={shownHint.tone}
                data-problems={String(shownHint.problems)}
              >
                {shownHint.text}
              </div>
            ),
          })}
          <div className="pipeline-canvas" data-testid="pipeline-canvas" ref={canvasRef}>
            <DraggableRenderer
              draggable={draggable}
              state={display}
              width={Math.max(display.drawing.width, canvasWidth)}
              height={Math.max(display.drawing.height, 240)}
              onDragState={(next) => setDragFrame(Option.some(next))}
              onDropState={onDropState}
              onDragStatus={(status) => {
                if (status.type === "idle") setDragFrame(Option.none());
              }}
            />
          </div>
          {base.problems.length > 0 ? (
            <ul className="pipeline-problem-list" data-testid="pipeline-problem-list">
              {base.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
          <Inspector
            node={Option.getOrUndefined(
              Option.flatMap(selected, (id) =>
                Option.fromNullishOr(base.pipeline.nodes.find((node) => node.id === id)),
              ),
            )}
            choices={view.choices}
            offers={view.offers}
            onEdit={queueEdit}
          />
        </div>
      );
    },
  });
};

/** What the preview says about a drag candidate with `count` problems. */
const hintOf = (count: number) => ({
  tone: count === 0 ? ("green" as const) : ("amber" as const),
  problems: count,
  text:
    count === 0
      ? "Drop here: the result passes the drawing check."
      : `Drop here: the result has ${count} problem${count === 1 ? "" : "s"}.`,
});

const sameDrawing = (a: Drawing, b: Drawing): boolean => JSON.stringify(a) === JSON.stringify(b);

const wirePath = (points: ReadonlyArray<readonly [number, number]>): string =>
  points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join("");

/** Default wire stroke; preview tones stay as stroke so dragology can lerp them. */
const WIRE_STROKE = "#656d76";
const WIRE_GOOD = "#1a7f37";
const WIRE_WARN = "#9a6700";

/**
 * The drawing, with `selected` outlined. A click on a block selects it for the
 * inspector; a click is below dragology's drag threshold, so it reaches the block.
 */
const editorSvgOf =
  (
    selected: Option.Option<string>,
    onSelect: (id: Option.Option<string>) => void,
  ): Draggable<EditorFrame> =>
  ({ state, d, draggedId }) => {
    const { drawing, problems, pending } = state;

    return (
      <g>
        {drawing.wires.map((wire) => {
          const draggingThis = Option.exists(pending, (change) => movesWire(change, wire));
          const stroke = draggingThis
            ? problems.length === 0
              ? WIRE_GOOD
              : WIRE_WARN
            : WIRE_STROKE;
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
          <g
            id={`block-${block.id}`}
            transform={translate(block.x, block.y)}
            onClick={() => onSelect(Option.some(block.id))}
          >
            <rect
              width={block.w}
              height={block.h}
              rx={6}
              data-testid={`select-${block.id}`}
              className="block"
            />
            {/* dragology blends each render into the next and cannot blend two class
                names, so the outline is always drawn and selection sets its opacity. */}
            <rect
              width={block.w}
              height={block.h}
              rx={6}
              className="block-outline"
              strokeOpacity={Option.contains(selected, block.id) ? 1 : 0}
            />
            <text x={10} y={18} className="block-label">
              {block.icon} {block.id}
            </text>
            <title>{block.summary}</title>
          </g>
        ))}
        {drawing.blocks.map((block) =>
          Option.match(inputPoint(drawing, block.id, state.flow), {
            onNone: () => null,
            onSome: (at) => (
              <circle
                id={`input-${block.id}`}
                data-testid={`block-${block.id}`}
                transform={translate(at[0], at[1])}
                r={10}
                className="input-dot"
              />
            ),
          }),
        )}
        {drawing.wires.map((wire) => {
          const ref: WireRef = { from: wire.from, port: wire.port };
          const id = `exit-${wire.from}-${portKey(wire.port)}`;
          const at = Option.orElse(handlePoint(state, ref), () =>
            Option.fromNullishOr(wire.points[0]),
          );
          return Option.match(at, {
            onNone: () => null,
            onSome: (point) => (
              <circle
                id={id}
                data-testid={id}
                transform={translate(point[0], point[1])}
                r={7}
                className="exit-dot"
                dragologyZIndex={draggedId === id ? "/1" : false}
                dragologyOnDrag={() => {
                  const committed: EditorFrame = { ...state, pending: Option.none() };
                  const frames = rejoinFrames(committed.pipeline, ref, state.checks, state.flow);
                  const options = frames.length === 0 ? [committed] : frames;
                  return d.closest(options).whenFar(committed, { gap: 160 }).withFloating();
                }}
              />
            ),
          });
        })}
      </g>
    );
  };

const Toolbar = ({
  project,
  hasDraft,
  problems,
  message,
  onMessage,
}: {
  readonly project: string;
  readonly hasDraft: boolean;
  readonly problems: ReadonlyArray<string>;
  readonly message: Option.Option<string>;
  readonly onMessage: (text: Option.Option<string>) => void;
}) => {
  const save = useAtomSet(UiRpc.mutation("PipelineSave"), { mode: "promiseExit" });
  const discard = useAtomSet(UiRpc.mutation("PipelineDiscard"), { mode: "promiseExit" });
  const [busy, setBusy] = useState<Option.Option<"save" | "discard">>(Option.none());

  const run = (kind: "save" | "discard") => {
    setBusy(Option.some(kind));
    onMessage(Option.none());
    const done = kind === "save" ? "Saved." : "Discarded.";
    const call =
      kind === "save" ? save({ payload: { project } }) : discard({ payload: { project } });
    void call.then((exit) => {
      setBusy(Option.none());
      onMessage(Option.some(Exit.match(exit, { onSuccess: () => done, onFailure: reasonOf })));
    });
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
            disabled={Option.isSome(busy) || problems.length > 0}
            onClick={() => run("save")}
          >
            {Option.contains(busy, "save") ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            data-testid="pipeline-discard"
            disabled={Option.isSome(busy)}
            onClick={() => run("discard")}
          >
            {Option.contains(busy, "discard") ? "Discarding…" : "Discard"}
          </button>
        </>
      ) : (
        <span className="muted">No draft open</span>
      )}
      {Option.match(message, {
        onNone: () => null,
        onSome: (text) => (
          <span className="muted" data-testid="pipeline-toolbar-message">
            {text}
          </span>
        ),
      })}
    </div>
  );
};
