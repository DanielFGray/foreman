/**
 * `foreman serve`: the one process that runs the dispatcher and the UI server.
 *
 * The dispatcher is supervised: when it fails, the failure is logged and
 * published as the reading's state, and the dispatcher starts again after a
 * pause. Readings live in one `SubscriptionRef<Published>` for the life of
 * the process. Each reading and each published failure is written to that
 * ref and to `state.json` (for the herdr-app Foreman pane); the UI server
 * reads the same ref.
 *
 * The UI server Layer runs beside supervise. It Bun.builds the page when it
 * starts and serves the outputs from memory. A failed build is logged and
 * stops only that Layer; the dispatcher keeps running.
 *
 * A lock on a file beside state.json is held for the life of the process, so
 * a second serve refuses to start and cannot race the first one's landings.
 */
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  Cause,
  Data,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { Command } from "effect/cli";
import { EMPTY_FLEET, type FleetState } from "./dispatcher.ts";
import { buildHost, publishedFailure, uiServices } from "./host.ts";
import { publishedOf, statusOf, writePublished } from "./published.ts";
import { type Published } from "./published-schema.ts";
import { publishedPath } from "./paths.ts";
import { ReadingsRef, uiServerLayer } from "./ui-server.ts";

export const serveCommand = Command.make("serve", {}, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = publishedPath();
      yield* holdLock(lockPath(path));
      // One readings ref for the process: each dispatcher writes into it;
      // state.json and the UI Readings stream both take their values from it.
      const readings = yield* SubscriptionRef.make(publishedOf(EMPTY_FLEET, Option.none()));
      // Beside supervise: a page-build failure stops only this fiber.
      yield* Effect.forkChild(runUiServer(readings));
      yield* supervise(buildHost, path, readings);
      // The dispatcher returns only when foreman's own checkout has a new
      // commit. A new dispatcher in this process would still load the code
      // already in memory, so the process exits and its service manager starts
      // it again.
      yield* Effect.logInfo(
        "foreman's code changed; serve stops so its service starts it on the new code",
      );
    }),
  ),
).pipe(
  Command.withDescription(
    "Run the dispatcher until its code changes, starting it again after each failure",
  ),
);

/**
 * Launches the UI server Layer against `readings`. A failure — including a
 * page that does not Bun.build — is logged and ends only this Effect; the
 * caller (supervise) is unaffected.
 */
export const runUiServer = (
  readings: SubscriptionRef.SubscriptionRef<Published>,
): Effect.Effect<void> =>
  isolateUiServer(
    Layer.launch(
      uiServerLayer.pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(ReadingsRef, readings), uiServices)),
      ),
    ),
  );

/**
 * A UI server failure (build or listen) is logged and swallowed so supervise
 * keeps the dispatcher. serve and the DoD test both wrap Layer.launch in this.
 */
export const isolateUiServer = <A, E, R>(
  launch: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R> =>
  launch.pipe(
    Effect.catchCause((cause) => Effect.logError("foreman's UI server stopped", cause)),
    Effect.asVoid,
  );

/** What `supervise` needs of a dispatcher: its readings, and its run. */
export interface Supervised<E, R> {
  readonly state: SubscriptionRef.SubscriptionRef<FleetState>;
  readonly run: Effect.Effect<void, E, R>;
}

/**
 * Runs one dispatcher after another until one returns, writing each reading
 * and each published failure to `readings` and to `path`.
 *
 * A failure is logged and published over the last reading, and a new
 * dispatcher is built after a pause. An interruption is the process stopping,
 * so supervise ends without a retry. The readings ref outlives each
 * dispatcher, so a subscriber keeps receiving after a restart.
 */
export const supervise = <E, RR, BE, R>(
  build: Effect.Effect<Supervised<E, RR>, BE, R | Scope.Scope>,
  path: string,
  readings: SubscriptionRef.SubscriptionRef<Published>,
) =>
  Effect.gen(function* () {
    // The last fleet reading, which a failure is published over.
    const last = yield* Ref.make(Option.none<FleetState>());

    // The only writer of state.json. It follows the ref, so the file always
    // holds a value the ref held, and nothing else writes the temp file.
    const writer = yield* Effect.forkChild(
      SubscriptionRef.changes(readings).pipe(
        Stream.runForEach((published) => writeReading(path, published)),
      ),
    );

    // One life of the dispatcher. State before its first reading is unpublished:
    // publishing it would say the fleet is empty.
    const attempt = Effect.scoped(
      Effect.gen(function* () {
        const host = yield* build;
        const put = (fleet: FleetState) =>
          // Uninterruptible: when the attempt scope closes it would otherwise
          // cancel an in-flight publish of the last reading.
          Effect.uninterruptible(
            Ref.set(last, Option.some(fleet)).pipe(
              Effect.andThen(
                SubscriptionRef.set(readings, publishedOf(fleet, Option.some(statusOf(fleet)))),
              ),
            ),
          );
        const streaming = yield* Effect.forkScoped(
          Stream.runForEach(
            SubscriptionRef.changes(host.state).pipe(
              Stream.filter((fleet) => fleet.observedAt !== undefined),
            ),
            put,
          ),
        );
        // However the dispatcher ends, stop the stream first, so no older reading
        // is published after the newest. Then publish the newest reading. The
        // interrupt waits out any in-flight put.
        yield* host.run.pipe(
          Effect.ensuring(
            Fiber.interrupt(streaming).pipe(
              Effect.andThen(SubscriptionRef.get(host.state)),
              Effect.flatMap((fleet) =>
                fleet.observedAt === undefined ? Effect.void : put(fleet),
              ),
            ),
          ),
        );
      }),
    );

    const failed = (cause: Cause.Cause<unknown>) => {
      const detail = Cause.pretty(cause).split("\n")[0] ?? "the dispatcher stopped";
      return Effect.logError("foreman's dispatcher failed; starting it again", cause).pipe(
        Effect.andThen(Ref.get(last)),
        Effect.flatMap((fleet) => publishedFailure(fleet, detail)),
        Effect.flatMap((published) => SubscriptionRef.set(readings, published)),
        Effect.catchCause((cause) =>
          Effect.logWarning("foreman's failure could not be published", cause),
        ),
      );
    };

    // Retries until interrupted. The writer stops first, then the readings
    // ref's current value is written, so the file ends on the newest value.
    yield* attempt.pipe(
      Effect.sandbox,
      Effect.tapError(failed),
      Effect.retry({ schedule: BACKOFF, while: (cause) => !Cause.hasInterruptsOnly(cause) }),
      Effect.catch(Effect.failCause),
      Effect.ensuring(
        Fiber.interrupt(writer).pipe(
          Effect.andThen(SubscriptionRef.get(readings)),
          Effect.flatMap((published) => writeReading(path, published)),
        ),
      ),
    );
  });

/**
 * Writes one published reading to state.json. The reading before a dispatcher
 * has produced one is not written, because the file would then say the fleet
 * is empty. A file that cannot be written is logged, and the next reading is
 * written again: state.json is a view, and a stale one says so in its timestamp.
 */
const writeReading = (path: string, published: Published) =>
  published.dispatcher === null
    ? Effect.void
    : writePublished(path, published).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("foreman's state.json was not written", cause),
        ),
      );

/** Another process holds the serve lock, so it runs the dispatcher already. */
export class ServeRunning extends Data.TaggedError("ServeRunning")<{ readonly lock: string }> {
  override get message() {
    return `another foreman serve runs already (it holds ${this.lock})`;
  }
}

/** The lock beside the file serve publishes, so FOREMAN_STATE moves both. */
export const lockPath = (published: string) => join(dirname(published), "serve.lock");

/**
 * Holds an exclusive flock(2) on `path` until the scope closes.
 *
 * flock, not a file that exists or a pid inside it: the kernel releases the
 * lock when the process dies in any way, so a crash or SIGKILL leaves no stale
 * lock to clear by hand, and no check of a pid can race a pid reused.
 */
export const holdLock = (path: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fd = yield* Effect.try({
        try: () => {
          mkdirSync(dirname(path), { recursive: true });
          return openSync(path, "a");
        },
        catch: (error) => new LockError({ lock: path, detail: String(error) }),
      });
      if (libc().symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return fd;
      closeSync(fd);
      return yield* new ServeRunning({ lock: path });
    }),
    (fd) => Effect.sync(() => closeSync(fd)),
  );

/**
 * Whether a `foreman serve` holds the lock beside `statePath`. The kernel
 * answers, not a timestamp, so a serve that is alive but inside a long tick
 * still reads as running.
 */
export const serveRunning = (statePath: string) =>
  Effect.scoped(holdLock(lockPath(statePath))).pipe(
    Effect.as(false),
    Effect.catchTag("ServeRunning", () => Effect.succeed(true)),
  );

/** The lock file could not be opened at all. */
export class LockError extends Data.TaggedError("LockError")<{
  readonly lock: string;
  readonly detail: string;
}> {
  override get message() {
    return `foreman serve could not open its lock ${this.lock}: ${this.detail}`;
  }
}

// A second at first, doubling, and never more than a minute between tries.
const BACKOFF = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")]);

// From <sys/file.h> on Linux.
const LOCK_EX = 2;
const LOCK_NB = 4;

let opened: ReturnType<typeof openLibc> | undefined;
const libc = () => (opened ??= openLibc());
const openLibc = () =>
  dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
