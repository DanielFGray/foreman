import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard } from "@opentui/solid";
import { Deferred, Effect, Exit, Runtime, Stream, SubscriptionRef } from "effect";
import { createSignal, For, type Accessor } from "solid-js";
import { type Active, Dispatcher, type FleetState } from "./dispatcher.ts";
import type { Item, ReadyTask } from "./prog.ts";

/**
 * The pipeline, drawn from whatever the dispatcher last observed.
 *
 * Two things about the lifetime are not obvious and both cost a run to learn
 * elsewhere. `render` resolves after MOUNT rather than on exit, so awaiting it
 * would return immediately and tear the renderer down under a live app; the
 * program parks on a Deferred instead and the view completes it to leave. And
 * the renderer is acquired with its release attached, so a defect unwinds the
 * terminal the same way a quit does — a TUI that dies without calling destroy
 * leaves the operator in a broken shell.
 *
 * The dispatcher keeps ticking behind this; the dashboard only ever reads its
 * state and calls its commands.
 */
export const dashboard = Effect.gen(function* () {
  const dispatcher = yield* Dispatcher;
  const runtime = yield* Effect.runtime<never>();

  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({ exitOnCtrlC: false, targetFps: 30, exitSignals: [] }),
    ),
    (active) => Effect.sync(() => active.destroy()),
  );

  const quit = yield* Deferred.make<void>();
  const [state, setState] = createSignal(yield* SubscriptionRef.get(dispatcher.state));

  // Log lines still go to stdout, which a full-screen TUI would otherwise be
  // scribbled over. opentui captures them into its own console instead, and
  // F12 brings that overlay up — so the pane stays a place to read what the
  // dispatcher decided without a second copy of the log going anywhere.
  const showConsole = () => renderer.console.toggle();

  // Forked into the enclosing scope rather than awaited: the stream never ends,
  // and it must stop when the dashboard does.
  yield* Effect.forkScoped(
    Stream.runForEach(dispatcher.state.changes, (next) => Effect.sync(() => setState(next))),
  );

  yield* Effect.promise(() =>
    render(
      () => (
        <Pipeline
          state={state}
          onQuit={() => Deferred.unsafeDone(quit, Exit.void)}
          onToggleConsole={showConsole}
          onTogglePause={() =>
            Runtime.runFork(runtime)(state().paused ? dispatcher.resume : dispatcher.pause)
          }
        />
      ),
      renderer,
    ),
  );

  yield* Deferred.await(quit);
});

const Pipeline = (props: {
  readonly state: Accessor<FleetState>;
  readonly onQuit: () => void;
  readonly onTogglePause: () => void;
  readonly onToggleConsole: () => void;
}) => {
  useKeyboard((key) => {
    if (key.name === "q") props.onQuit();
    if (key.name === "p") props.onTogglePause();
    if (key.name === "f12") props.onToggleConsole();
  });

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <Column title="queue" rows={() => props.state().queue.map(ready)} />
        <Column title="working" rows={() => props.state().working.map(active)} />
        <Column title="review" rows={() => props.state().review.map(active)} />
        <Column title="landed" rows={() => props.state().landed.map(landed)} />
      </box>
      <Status state={props.state} />
    </box>
  );
};

/**
 * One stage of the pipeline.
 *
 * flexBasis 0 rather than plain flexGrow: growth only shares out the space
 * left over, so a column full of long titles would otherwise starve an empty
 * one down to a sliver and the pipeline would look broken whenever it was
 * lopsided — which is most of the time.
 */
const Column = (props: { readonly title: string; readonly rows: Accessor<Array<Row>> }) => (
  <box
    style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, minWidth: 0, border: true }}
    title={`${props.title} ${props.rows().length}`}
  >
    <For each={props.rows()}>
      {(row) => (
        <text style={{ height: 1, flexShrink: 0 }}>{`${row.id}  ${row.label}`}</text>
      )}
    </For>
  </box>
);

/**
 * Why the pipeline is not moving, when it is not moving.
 *
 * Held projects are named because a queue that stops for a reason nobody can
 * see reads as a broken dispatcher, and the reason — the operator's own
 * uncommitted work — is one only they can clear.
 */
const Status = (props: { readonly state: Accessor<FleetState> }) => (
  <box style={{ flexDirection: "column", flexShrink: 0 }}>
    <text style={{ height: 1 }}>
      {props.state().held.length === 0 ? "" : `held: ${props.state().held.join(", ")}`}
    </text>
    <text style={{ height: 1 }}>
      {`${props.state().paused ? "paused" : "running"}  ·  ${props.state().decisions.length} awaiting a decision  ·  p pause  F12 log  q quit`}
    </text>
  </box>
);

interface Row {
  readonly id: string;
  readonly label: string;
}

const ready = (task: ReadyTask): Row => ({ id: task.id, label: `${task.project}  ${task.title}` });

const landed = (task: Item): Row => ({ id: task.id, label: `${task.project}  ${task.title}` });

// The kind is shown rather than the project: in the middle columns the question
// is which model is on the work, and the project is already visible upstream.
const active = ({ task, kind }: Active): Row => ({
  id: task.id,
  label: `${kind ?? "?"}  ${task.title}`,
});
