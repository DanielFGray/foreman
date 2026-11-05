/**
 * `foreman serve`: the one process that runs the dispatcher.
 *
 * The dispatcher is supervised: when it fails, the failure is logged and
 * written to state.json as the reading's state, and the dispatcher starts
 * again after a pause. Each reading is written to state.json, which the
 * herdr-app Foreman pane reads.
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
  Option,
  Ref,
  Schedule,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { Command } from "effect/cli";
import type { FleetState } from "./dispatcher.ts";
import { buildHost, publishedFailure } from "./host.ts";
import { publishedOf, publishedPath, statusOf, writePublished } from "./published.ts";

export const serveCommand = Command.make("serve", {}, () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = publishedPath();
      yield* holdLock(lockPath(path));
      yield* supervise(buildHost, path);
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

/** What `supervise` needs of a dispatcher: its readings, and its run. */
export interface Supervised<E, R> {
  readonly state: SubscriptionRef.SubscriptionRef<FleetState>;
  readonly run: Effect.Effect<void, E, R>;
}

/**
 * Runs one dispatcher after another until one returns, writing each reading
 * to `path`.
 *
 * A failure is logged and published over the last reading, and a new
 * dispatcher is built after a pause. An interruption is the process stopping,
 * so supervise ends without a retry.
 */
export const supervise = <E, RR, BE, R>(
  build: Effect.Effect<Supervised<E, RR>, BE, R | Scope.Scope>,
  path: string,
) =>
  Effect.gen(function* () {
    // The last reading, which a failure is published over.
    const last = yield* Ref.make(Option.none<FleetState>());

    // A file that cannot be written is logged and written again with the next
    // reading: it is a view, and a stale one says so through its timestamp.
    const publish = (published: Parameters<typeof writePublished>[1]) =>
      writePublished(path, published).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("foreman's state.json was not written", cause),
        ),
      );

    // One life of the dispatcher. State before its first reading is unpublished:
    // publishing it would say the fleet is empty.
    const attempt = Effect.scoped(
      Effect.gen(function* () {
        const host = yield* build;
        yield* Effect.forkScoped(
          Stream.runForEach(
            SubscriptionRef.changes(host.state).pipe(
              Stream.filter((fleet) => fleet.observedAt !== undefined),
            ),
            (fleet) =>
              Ref.set(last, Option.some(fleet)).pipe(
                Effect.andThen(publish(publishedOf(fleet, Option.some(statusOf(fleet))))),
              ),
          ),
        );
        return yield* host.run;
      }),
    );

    const failed = (cause: Cause.Cause<unknown>) => {
      const detail = Cause.pretty(cause).split("\n")[0] ?? "the dispatcher stopped";
      return Effect.logError("foreman's dispatcher failed; starting it again", cause).pipe(
        Effect.andThen(Ref.get(last)),
        Effect.flatMap((fleet) => publishedFailure(fleet, detail)),
        Effect.flatMap(publish),
        Effect.catchCause((cause) =>
          Effect.logWarning("foreman's failure could not be published", cause),
        ),
      );
    };

    yield* attempt.pipe(
      Effect.sandbox,
      Effect.tapError(failed),
      Effect.retry({ schedule: BACKOFF, while: (cause) => !Cause.hasInterruptsOnly(cause) }),
      Effect.catch(Effect.failCause),
    );
  });

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
