/**
 * What a process that runs the dispatcher needs from foreman, and the service
 * set the command line runs on too, so the two cannot be composed differently.
 *
 * The dispatcher has one way to run: inside a host, which today is
 * herdr-web's server. The host builds a `Host` in a scope, runs its `run`
 * supervised, reads `state` for its pages, and writes each reading to
 * `state.json` for the herdr-app Foreman pane.
 */
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Layer, Option } from "effect";
import { settings, Settings } from "./config.ts";
import { Dispatcher, EMPTY_FLEET, type FleetState } from "./dispatcher.ts";
import { Fleet } from "./fleet.ts";
import { HcFleet } from "./hc.ts";
import { logging } from "./log.ts";
import { Records } from "./records.ts";
import { store } from "tasks";
import { openCheckouts, projectSet } from "./projects.ts";
import { Prompts } from "./prompt.ts";
import { publishedOf, publishedQueue } from "./published.ts";
import { policyPath, readPolicy } from "./policy.ts";
import { Quota } from "./quota.ts";
import { queueFrom } from "./queue.ts";
import { Repository } from "./repository.ts";
import { telemetry } from "./telemetry.ts";

/**
 * Every service the dispatcher and the one-shot commands read.
 *
 * hc is the only multiplexer foreman speaks to today. Swapping `HcFleet` for
 * another adapter is the whole of that migration. The base set supplies
 * Dispatcher with every port it cannot build itself.
 *
 * `telemetry` reads the endpoint out of the same `Settings` the rest of the set
 * is given, so it is provided that layer rather than merged beside it; one
 * reference means the config is still built once. It sets the tracer, and
 * `logging` replaces the logger, for whatever this layer is provided to — which
 * is why a host provides it to the dispatcher alone and not to the whole
 * process. If DevTools is ever added it must come *before* the tracing layers,
 * or the tracer it patches is not the one foreman ends up using.
 *
 * `store` is the one connection to the task store: Records, the registry in
 * `Settings` and run recording all read it, and a layer value is built once.
 */
export const services = Layer.provideMerge(
  Dispatcher.Default,
  Layer.mergeAll(
    HcFleet,
    settings,
    Records.layer,
    Prompts.Default,
    Quota.Default,
    Repository.Default,
    logging(),
    telemetry.pipe(Layer.provide(settings)),
  ),
).pipe(Layer.provideMerge(BunServices.layer), Layer.provide(store));

/** What the store reads need: the task store, and the open spaces for the queue's projects. */
export const storeServices = Layer.mergeAll(
  Records.layer,
  settings,
  HcFleet,
  Repository.Default,
).pipe(Layer.provideMerge(BunServices.layer), Layer.provide(store));

/**
 * The queue in the order the fleet would dispatch it, for one project or for
 * every project an open space sits in, with the epics it falls under.
 *
 * `queueFrom` is the tick's own split, so this and a tick cannot disagree,
 * with one exception: a task whose dispatch failed twice is held out by the
 * dispatcher's in-process tally, which this read does not see.
 */
export const queueOf = (project: Option.Option<string>) =>
  Effect.gen(function* () {
    const records = yield* Records;
    const projects = yield* Option.match(project, {
      onSome: (name) => Effect.succeed([name]),
      onNone: () =>
        Effect.gen(function* () {
          const open = yield* openCheckouts(yield* Fleet, yield* Repository);
          return projectSet(open, []).projects.map(({ name }) => name);
        }),
    });
    const ready = yield* records.ready(project);
    const epics = yield* records.epicsOver(ready);
    const { queue } = queueFrom({
      ready,
      ladder: (yield* Settings).ladder,
      projects,
      epics,
      failed: new Set(),
      now: new Date(),
    });
    return { queue, epics };
  });

/**
 * Builds the services in the caller's scope and hands back one dispatcher with
 * the reads a host serves beside it. Closing the scope releases them; the
 * host builds a new one to start again after a failure.
 *
 * `run` and `queue` carry the built services with them, so the logger and
 * tracer foreman sets apply to them and to nothing else in the host.
 */
export const buildHost = Effect.gen(function* () {
  const context = yield* Layer.build(services);
  const dispatcher = Context.get(context, Dispatcher);
  const repository = Context.get(context, Repository);
  const headOfCode = repository.head(import.meta.dir).pipe(Effect.option);
  loadedCommit ??= Option.getOrUndefined(yield* headOfCode);
  const loaded = loadedCommit;
  return {
    /** Each reading of the world, replaced whole. */
    state: dispatcher.state,
    /**
     * Ticks until interrupted, until a tick fails, or until the checkout this
     * process loaded foreman from has a new commit. It returns only in the
     * last case, and the host then starts a new process on the new code.
     */
    run: dispatcher
      .run(
        headOfCode.pipe(
          Effect.map(
            (head) => loaded !== undefined && Option.isSome(head) && head.value !== loaded,
          ),
        ),
      )
      .pipe(Effect.provideContext(context)),
    /** Asks for a reading now, after a command changed the world. */
    wake: dispatcher.wake,
    /** The ranked queue for one project or every open one, as published rows. */
    queue: (project: Option.Option<string>) =>
      queueOf(project).pipe(
        Effect.map(({ queue, epics }) => publishedQueue(queue, epics)),
        Effect.provideContext(context),
      ),
  };
});

export type Host = Effect.Success<typeof buildHost>;

/**
 * The commit of foreman's own checkout when this process first built a host:
 * the code it runs. Kept per process, not per host, because a host built
 * again after a failure still runs the code the process loaded.
 */
let loadedCommit: string | undefined;

/**
 * What a host publishes while the dispatcher is down: its last reading if it
 * made one, marked failed with why. Before any reading there is no fleet to
 * show, but the policy file can still be read, so the operator sees what the
 * fleet would do once it starts again.
 */
export const publishedFailure = (last: Option.Option<FleetState>, detail: string) =>
  Option.match(last, {
    onSome: (state) => Effect.succeed(state),
    onNone: () =>
      readPolicy(policyPath()).pipe(
        Effect.map(({ policy, error }) => ({ ...EMPTY_FLEET, policy, policyError: error })),
      ),
  }).pipe(Effect.map((state) => publishedOf(state, Option.some({ state: "failed", detail }))));
