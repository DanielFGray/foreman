// The bridge's view of foreman: the fleet as foreman last read it, kept
// current while a page watches, and foreman's one-shot commands run for it.
//
// Two sources give a reading. The daemon writes state.json after each pass;
// the bridge watches its folder, since the daemon renames a new file into
// place and a watch on the file itself ends at the first rename. The bridge
// also runs `foreman status --json` when a page starts watching, after each
// command and on request: a command changes the world and not the daemon, so
// with no daemon running nothing else would show what it did. The page sees
// the newer of the two. The queue is not in the reading: the page asks
// for it with `foreman queue`, for the project it shows.
import { Array, Config, Context, Duration, Effect, FileSystem, Layer, Option, Path, RcRef, Result, Schema as S, Semaphore, Stream, SubscriptionRef } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { BridgeError } from "../shared/Api.ts"
import { argvOf, FOREMAN_VERSION, type ForemanCommand, ForemanReading, ForemanRow, type ForemanState } from "../shared/Foreman.ts"

export class Foreman extends Context.Service<Foreman>()("herdr-web/server/Foreman", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const statePath = yield* StatePath
    const scope = yield* Effect.scope
    const state = yield* SubscriptionRef.make<ForemanState>(EMPTY_STATE)
    // One-shot readings take seconds; they run one at a time, in order.
    const oneShot = yield* Semaphore.make(1)

    const foreman = (args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make(PROGRAM, args))
          const [stdout, stderr, code] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
            { concurrency: "unbounded" },
          )
          return code === 0 ? stdout : yield* new BridgeError({ kind: "foreman", message: lastLines(stderr || stdout) || `foreman ${args.join(" ")} exited with ${code}` })
        }),
      ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new BridgeError({ kind: "foreman", message: `foreman did not run: ${error.message}` }))))

    const took = (result: Result.Result<ForemanReading, string>) =>
      SubscriptionRef.update(state, (now) =>
        Result.match(result, {
          onSuccess: (reading) => withReading(now, reading),
          onFailure: (problem) => ({ ...now, problem: Option.some(problem) }),
        }),
      )

    // No file yet is no problem: no daemon has published, and the one-shot reading stands.
    const readFile = fs.readFileString(statePath).pipe(
      Effect.flatMap((text) => took(readingOf(text))),
      Effect.catchTag("PlatformError", (error) => (error.reason._tag === "NotFound" ? Effect.void : took(Result.fail(`state.json cannot be read: ${error.message}`)))),
    )

    const readStatus = oneShot.withPermits(1)(
      SubscriptionRef.update(state, (now) => ({ ...now, isReading: true })).pipe(
        Effect.andThen(foreman(["status", "--json"])),
        Effect.matchEffect({ onSuccess: (text) => took(readingOf(text)), onFailure: ({ message }) => took(Result.fail(message)) }),
        Effect.ensuring(SubscriptionRef.update(state, (now) => ({ ...now, isReading: false }))),
      ),
    )

    // The folder exists only once a daemon has published; until then, and after
    // a watch fails, the bridge looks again after a pause.
    const folder = paths.dirname(statePath)
    const watchFile = readFile.pipe(
      Effect.andThen(Stream.runForEach(fs.watch(folder), ({ path }) => (path === statePath ? readFile : Effect.void))),
      Effect.ignore,
      Effect.andThen(Effect.sleep(WATCH_RETRY)),
      Effect.forever,
    )

    const watching = yield* RcRef.make({
      acquire: Effect.all([Effect.forkScoped(watchFile), Effect.forkScoped(readStatus)]),
      idleTimeToLive: IDLE_WATCH,
    })

    /** Reads again in the background, so a command answers before the seconds a reading takes. */
    const refresh = Effect.asVoid(Effect.forkIn(readStatus, scope))

    return {
      /** What the bridge knows, now and after each change; watches while read. */
      changes: Stream.unwrap(Effect.as(RcRef.get(watching), SubscriptionRef.changes(state))),
      /** Runs one command, then reads the fleet again. */
      run: (command: ForemanCommand) => foreman(argvOf(command)).pipe(Effect.andThen(refresh)),
      refresh,
      /** The ladder's rungs a task can be launched on: every one not disabled. */
      rungs: foreman(["ladder", "list", "--json"]).pipe(
        Effect.flatMap((text) =>
          S.decodeEffect(S.fromJsonString(S.Array(Rung)))(text).pipe(
            Effect.mapError((error) => new BridgeError({ kind: "foreman", message: `foreman's ladder is unreadable: ${error.message}` })),
          ),
        ),
        Effect.map((rungs) => Array.filterMap(rungs, ({ rung, state }) => (state === "disabled" ? Result.failVoid : Result.succeed(rung)))),
      ),
      /**
       * The queue in the order the fleet would dispatch it, for one project or
       * every one an open space sits in. foreman reads the task store, so the
       * bridge never speaks to it; no daemon need run.
       */
      queue: (project: Option.Option<string>) =>
        foreman(["queue", ...Option.match(project, { onNone: () => [], onSome: (name) => ["--project", name] }), "--json"]).pipe(
          Effect.flatMap((text) =>
            S.decodeEffect(S.fromJsonString(S.Array(ForemanRow)))(text).pipe(
              Effect.mapError((error) => new BridgeError({ kind: "foreman", message: `foreman's queue does not match this page: ${error.message}` })),
            ),
          ),
        ),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/** The reading a text holds, or why it holds none; a version this page does not read is refused by name. */
export const readingOf = (text: string): Result.Result<ForemanReading, string> =>
  Result.flatMap(
    Result.mapError(S.decodeResult(S.fromJsonString(S.Struct({ version: S.Unknown })))(text), () => "foreman's reading is not JSON"),
    ({ version }) =>
      version !== FOREMAN_VERSION
        ? Result.fail(`foreman publishes version ${String(version)}; this page reads version ${FOREMAN_VERSION}`)
        : Result.mapError(S.decodeResult(S.fromJsonString(ForemanReading))(text),(error) => `foreman's reading does not match this page: ${error.message}`),
  )

/**
 * Takes a reading if it is newer than the one held. A daemon's reading also
 * dates the daemon, whichever reading is shown.
 */
export const withReading = (state: ForemanState, reading: ForemanReading): ForemanState => ({
  ...state,
  reading: Option.isSome(state.reading) && instantOf(state.reading.value) > instantOf(reading) ? state.reading : Option.some(reading),
  daemonAt: reading.daemon ? Option.orElse(Option.map(reading.observedAt, Date.parse), () => state.daemonAt) : state.daemonAt,
  problem: Option.none(),
})

export const EMPTY_STATE: ForemanState = { reading: Option.none(), daemonAt: Option.none(), problem: Option.none(), isReading: false }

// A reading from before its first pass has no instant, and is older than any.
const instantOf = (reading: ForemanReading) => Option.match(reading.observedAt, { onNone: () => 0, onSome: Date.parse })

const PROGRAM = "foreman"
const WATCH_RETRY = Duration.seconds(5)
// The watch outlives a page's reload, so the reload does not wait seconds for a reading.
const IDLE_WATCH = Duration.minutes(1)

const Rung = S.Struct({ rung: S.String, state: S.String })

// The end of a failure's output says why; the start is usually a usage line.
const lastLines = (text: string) => text.trim().split("\n").slice(-4).join("\n")

/** Where foreman's daemon publishes: the path foreman's own `publishedPath` gives. */
const StatePath = Config.all({
  explicit: Config.option(Config.String("FOREMAN_STATE")),
  stateHome: Config.option(Config.String("XDG_STATE_HOME")),
  home: Config.String("HOME"),
}).pipe(
  Config.map(({ explicit, stateHome, home }) =>
    Option.getOrElse(explicit, () => `${Option.getOrElse(stateHome, () => `${home}/.local/state`)}/foreman/state.json`),
  ),
)
