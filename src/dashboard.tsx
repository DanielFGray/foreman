import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { Deferred, Effect, Exit, Runtime, Stream, SubscriptionRef } from "effect";
import { createSignal } from "solid-js";
import { Dispatcher, nextDispatch } from "./dispatcher.ts";
import { type Controls, Pipeline } from "./pipeline.tsx";

/**
 * The dashboard, and the only place the renderer's lifetime is owned.
 *
 * Two things about that lifetime are not obvious and both cost a run to learn
 * elsewhere. `render` resolves after MOUNT rather than on exit, so awaiting it
 * would return immediately and tear the renderer down under a live app; the
 * program parks on a Deferred instead and the view completes it to leave. And
 * the renderer is acquired with its release attached, so a defect unwinds the
 * terminal the same way a quit does — a TUI that dies without calling destroy
 * leaves the operator in a broken shell.
 *
 * The dispatcher keeps ticking behind this; the dashboard only ever reads its
 * state and calls its commands. Each control callback forks its command into
 * the dispatcher's runtime rather than awaiting it, so the screen never waits
 * on a herdr or prog round trip.
 */
export const dashboard = Effect.gen(function* () {
  const dispatcher = yield* Dispatcher;
  const runtime = yield* Effect.runtime<never>();

  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() => createCliRenderer({ exitOnCtrlC: false, targetFps: 30, exitSignals: [] })),
    (active) => Effect.sync(() => active.destroy()),
  );

  const quit = yield* Deferred.make<void>();
  const [state, setState] = createSignal(yield* SubscriptionRef.get(dispatcher.state));

  // The logging layer follows this console into OpenTUI's F12 overlay.
  const showConsole = () => renderer.console.toggle();

  // Forked into the enclosing scope rather than awaited: the stream never ends,
  // and it must stop when the dashboard does.
  yield* Effect.forkScoped(
    Stream.runForEach(dispatcher.state.changes, (next) => Effect.sync(() => setState(next))),
  );

  const controls: Controls = {
    quit: () => Deferred.unsafeDone(quit, Exit.void),
    cycleDispatch: () =>
      Runtime.runFork(runtime)(dispatcher.setDispatch(nextDispatch(state().dispatch))),
    toggleConsole: showConsole,
    focus: (worker) => Runtime.runFork(runtime)(dispatcher.focus(worker)),
    retry: (task) => Runtime.runFork(runtime)(dispatcher.retry(task)),
    release: (task) => Runtime.runFork(runtime)(dispatcher.release(task)),
    close: (task) => Runtime.runFork(runtime)(dispatcher.close(task)),
    descend: (task) => Runtime.runFork(runtime)(dispatcher.descend(task)),
    unassign: (task) => Runtime.runFork(runtime)(dispatcher.unassign(task)),
    onboard: (project) => Runtime.runFork(runtime)(dispatcher.onboard(project)),
    adopt: (orphan) => Runtime.runFork(runtime)(dispatcher.adopt(orphan)),
    complete: (task, reason) => Runtime.runFork(runtime)(dispatcher.complete(task, reason)),
    diagnose: (target, intent, rung) =>
      Runtime.runFork(runtime)(dispatcher.diagnose(target, intent, rung)),
    reviewIntervention: (target, rung) =>
      Runtime.runFork(runtime)(dispatcher.reviewIntervention(target, rung)),
    continueAt: (target, rung) => Runtime.runFork(runtime)(dispatcher.continueAt(target, rung)),
  };

  yield* Effect.promise(() =>
    render(() => <Pipeline state={state} controls={controls} rungs={dispatcher.rungs} />, renderer),
  );

  yield* Deferred.await(quit);
});
