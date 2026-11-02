// The bridge runs foreman's dispatcher in its own process, keeps the page
// current with each reading, and runs foreman's one-shot commands for it.
//
// The dispatcher is supervised: when it fails, the failure is logged and shown
// as the reading's state, and the dispatcher starts again after a pause, while
// the bridge goes on serving. Each reading is also written to state.json, which
// the herdr-app panel reads.
import { Cause, Context, Effect, Layer, Option, Ref, Schedule, Schema as S, Stream, SubscriptionRef } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { buildHost, type FleetState, type Host, Published, PublishedRow, publishedFailure, publishedOf, publishedPath, statusOf, writePublished } from "foreman"
import { BridgeError } from "../shared/Api.ts"
import { Pipeline } from "foreman/pipeline"
import { argvOf, type ForemanCommand, ForemanPipeline, ForemanReading, ForemanRow, ForemanRung, type ForemanState } from "../shared/Foreman.ts"

/** Builds foreman's dispatcher and its services; a test gives a fake one. */
export class ForemanHost extends Context.Service<ForemanHost>()("herdr-web/server/ForemanHost", {
  make: Effect.succeed({ build: buildHost }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export class Foreman extends Context.Service<Foreman>()("herdr-web/server/Foreman", {
  make: Effect.gen(function* () {
    const { build } = yield* ForemanHost
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const state = yield* SubscriptionRef.make<ForemanState>(EMPTY_STATE)
    // The dispatcher now running, if any: none while it starts or waits to start again.
    const current = yield* Ref.make(Option.none<Host>())
    // Its last reading, which a failure is published over.
    const last = yield* Ref.make(Option.none<FleetState>())

    // Every reading goes to the file and to the page. A file that cannot be
    // written is logged and written again with the next reading: it is a view,
    // and a stale one says so through its timestamp.
    const publish = (published: Published) =>
      writePublished(publishedPath(), published).pipe(
        Effect.catchCause((cause) => Effect.logWarning("foreman's state.json was not written", cause)),
        Effect.andThen(S.encodeEffect(Published)(published)),
        Effect.flatMap(S.decodeUnknownEffect(ForemanReading)),
        Effect.match({
          onSuccess: (reading) => (): ForemanState => ({ reading: Option.some(reading), problem: Option.none() }),
          // The page keeps the last reading it could show, and says why the new one is missing.
          onFailure: (error) => (now: ForemanState): ForemanState => ({ ...now, problem: Option.some(`foreman's reading does not match this page: ${error.message}`) }),
        }),
        Effect.flatMap((change) => SubscriptionRef.update(state, change)),
      )

    // One life of the dispatcher. The state before its first reading is not a
    // reading: published, it would say the fleet is empty.
    const attempt = Effect.scoped(
      Effect.gen(function* () {
        const host = yield* build
        yield* Ref.set(current, Option.some(host))
        yield* Effect.forkScoped(
          Stream.runForEach(
            SubscriptionRef.changes(host.state).pipe(Stream.filter((fleet) => fleet.observedAt !== undefined)),
            (fleet) => Ref.set(last, Option.some(fleet)).pipe(Effect.andThen(publish(publishedOf(fleet, Option.some(statusOf(fleet)))))),
          ),
        )
        return yield* host.run
      }),
    ).pipe(Effect.ensuring(Ref.set(current, Option.none())))

    const failed = <E>(cause: Cause.Cause<E>) => {
      const detail = Cause.pretty(cause).split("\n")[0] ?? "the dispatcher stopped"
      return Effect.logError("foreman's dispatcher failed; starting it again", cause).pipe(
        Effect.andThen(Ref.get(last)),
        Effect.flatMap((fleet) => publishedFailure(fleet, detail)),
        Effect.flatMap(publish),
        Effect.catchCause((cause) => Effect.logWarning("foreman's failure could not be published", cause)),
      )
    }

    // An interruption is the bridge stopping, not a failure to recover from.
    yield* Effect.forkScoped(
      attempt.pipe(
        Effect.sandbox,
        Effect.tapError(failed),
        Effect.retry({ schedule: BACKOFF, while: (cause) => !Cause.hasInterruptsOnly(cause) }),
      ),
    )

    /** Asks the running dispatcher to read again now; none runs while it restarts. */
    const wake = Ref.get(current).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (host) => host.wake })))

    const foreman = (args: ReadonlyArray<string>, stdin?: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make(PROGRAM, args, stdin === undefined ? {} : { stdin: Stream.make(new TextEncoder().encode(stdin)) }))
          const [stdout, stderr, code] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
            { concurrency: "unbounded" },
          )
          return code === 0 ? stdout : yield* new BridgeError({ kind: "foreman", message: lastLines(stderr || stdout) || `foreman ${args.join(" ")} exited with ${code}` })
        }),
      ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new BridgeError({ kind: "foreman", message: `foreman did not run: ${error.message}` }))))

    return {
      /** What the bridge knows, now and after each change. */
      changes: SubscriptionRef.changes(state),
      /**
       * Runs one command in a process of its own, then asks the dispatcher to
       * read again, so the page shows what the command did.
       */
      run: (command: ForemanCommand) => foreman(argvOf(command)).pipe(Effect.andThen(wake)),
      refresh: wake,
      /** Every rung of the ladder with its state, cheapest first. */
      rungs: foreman(["ladder", "list", "--json"]).pipe(
        Effect.flatMap((text) =>
          S.decodeEffect(S.fromJsonString(S.Array(ForemanRung)))(text).pipe(
            Effect.mapError((error) => new BridgeError({ kind: "foreman", message: `foreman's ladder is unreadable: ${error.message}` })),
          ),
        ),
      ),
      /** The pipeline a project runs, as `foreman pipeline show` prints it. */
      pipeline: (project: string) =>
        foreman(["pipeline", "show", project, "--json"]).pipe(
          Effect.flatMap((text) =>
            S.decodeEffect(S.fromJsonString(ForemanPipeline))(text).pipe(
              Effect.mapError((error) => new BridgeError({ kind: "foreman", message: `foreman's pipeline for ${project} is unreadable: ${error.message}` })),
            ),
          ),
        ),
      /** Sets a project's pipeline. Foreman checks it against the ladder; its refusal is the error's message. */
      savePipeline: (project: string, pipeline: Pipeline) =>
        S.encodeEffect(S.fromJsonString(Pipeline))(pipeline).pipe(
          Effect.mapError((error) => new BridgeError({ kind: "foreman", message: `the pipeline cannot be written: ${error.message}` })),
          Effect.flatMap((json) => foreman(["pipeline", "set", project, "-"], json)),
          Effect.andThen(wake),
        ),
      clearPipeline: (project: string) => foreman(["pipeline", "clear", project]).pipe(Effect.andThen(wake)),
      /** One task as foreman records it, read in a process of its own like every one-shot command. */
      task: (key: string) =>
        foreman(["show", key, "--json"]).pipe(
          Effect.flatMap((text) =>
            S.decodeEffect(S.fromJsonString(S.Struct({ description: S.OptionFromNullOr(S.String) })))(text).pipe(
              Effect.mapError((error) => new BridgeError({ kind: "foreman", message: `foreman's record of ${key} is unreadable: ${error.message}` })),
            ),
          ),
        ),
      /**
       * The queue in the order the fleet would dispatch it, for one project or
       * every one an open space sits in, read by the running dispatcher's own
       * services.
       */
      queue: (project: Option.Option<string>) =>
        Ref.get(current).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new BridgeError({ kind: "foreman", message: "foreman's dispatcher is not running" })),
              onSome: (host) => host.queue(project).pipe(Effect.mapError((error) => new BridgeError({ kind: "foreman", message: `foreman's queue is unreadable: ${error.message}` }))),
            }),
          ),
          Effect.flatMap((rows) =>
            S.encodeEffect(S.Array(PublishedRow))(rows).pipe(
              Effect.flatMap(S.decodeUnknownEffect(S.Array(ForemanRow))),
              Effect.mapError((error) => new BridgeError({ kind: "foreman", message: `foreman's queue does not match this page: ${error.message}` })),
            ),
          ),
        ),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export const EMPTY_STATE: ForemanState = { reading: Option.none(), problem: Option.none() }

// A second at first, doubling, and never more than a minute between tries.
const BACKOFF = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("1 minute")])

const PROGRAM = "foreman"

// The end of a failure's output says why; the start is usually a usage line.
const lastLines = (text: string) => text.trim().split("\n").slice(-4).join("\n")
