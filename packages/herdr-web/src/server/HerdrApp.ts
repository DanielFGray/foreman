// The herdr-app window's command socket: one JSON line in, one JSON line out.
// It answers only while the window runs.
import { BunSocket } from "@effect/platform-bun"
import { Array, Config, Context, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { Socket } from "effect/socket"
import type { Direction } from "../shared/Api.ts"
import { wireTag } from "../shared/Wire.ts"

/** herdr-app refused the command, or its window is not running. */
export class HerdrAppError extends Schema.TaggedError<HerdrAppError, { readonly brand: unique symbol }>()("HerdrAppError", {
  message: Schema.String,
}) {}

export class HerdrApp extends Context.Service<HerdrApp>()("herdr-web/server/HerdrApp", {
  make: Effect.gen(function* () {
    const home = yield* Config.String("HERDR_APP_HOME").pipe(
      Config.orElse(() => Config.String("HOME").pipe(Config.map((home) => `${home}/.config/herdr-app`))),
    )
    const path = `${home}/herdr-app.sock`

    const ask = <A, I>(request: Effect.Effect<string, Schema.SchemaError>, result: Schema.Codec<A, I>) =>
      Effect.gen(function* () {
        const socket = yield* BunSocket.makeNet({ path })
        // The socket drops what arrives before it is read, so reading starts first.
        const reading = yield* Socket.toStream(socket).pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead, Effect.forkScoped)
        const writer = yield* socket.writer
        yield* writer.write(`${yield* request}\n`)
        const line = yield* Fiber.join(reading)
        const reply = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Union([Refused, result])))(
          Option.getOrElse(line, () => ""),
        )
        return yield* Schema.is(Refused)(reply) ? Effect.fail(new HerdrAppError({ message: reply.error })) : Effect.succeed(reply)
      }).pipe(
        Effect.scoped,
        Effect.timeout(REPLY_TIMEOUT),
        Effect.catchTags({
          TimeoutError: () => Effect.fail(new HerdrAppError({ message: "the herdr-app window did not answer" })),
          SocketError: (error) => Effect.fail(new HerdrAppError({ message: `the herdr-app window is not reachable: ${error.message}` })),
          SchemaError: (error) => Effect.fail(new HerdrAppError({ message: `unreadable reply from herdr-app: ${error.message}` })),
        }),
      )

    const run = <A, I>(command: string, args: Readonly<Record<string, string | number>>, result: Schema.Codec<A, I>) =>
      ask(Schema.encodeEffect(Command)({ do: command, args }), result)

    return {
      /** Opens a shell beside the pane, in its folder. */
      split: (pane: string, direction: Direction) => run("pane.split", { pane, direction }, Split),
      /** Closes the pane and ends its terminal. */
      close: (pane: string) => run("pane.close", { pane }, Done),
      /**
       * Moves the space to where `onto` is now, as a drag in herdr-app's own
       * sidebar does: after it when moving down, before it when moving up.
       * herdr-app numbers its spaces in an order of its own (machines by name),
       * so the position is read from the window, not counted in the page.
       */
      moveSpace: (space: string, onto: string) =>
        ask(Schema.encodeEffect(Listing)({ ls: true }), World).pipe(
          Effect.flatMap(({ spaces }) =>
            Option.match(
              Array.findFirstIndex(spaces, ({ id }) => id === onto),
              {
                onNone: () => Effect.fail(new HerdrAppError({ message: `herdr-app has no space ${onto}` })),
                onSome: (index) => run("space.move", { id: space, index: index + 1 }, Done),
              },
            ),
          ),
        ),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/** herdr-app answers at once; a window that stays silent this long is stuck. */
const REPLY_TIMEOUT = "5 seconds"

// herdr-app reads a position (`space.move`'s index) as a JSON number.
const Command = Schema.fromJsonString(
  Schema.Struct({ do: Schema.String, args: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Int])) }),
)

/** `herdr-app ls`: the window's spaces in its own order. */
const Listing = Schema.fromJsonString(Schema.Struct({ ls: Schema.Literal(true) }))

const World = Schema.Struct({ spaces: Schema.Array(Schema.Struct({ id: Schema.String })) })

const Refused = Schema.Struct({ _tag: wireTag("Refused"), error: Schema.String })

const Split = Schema.Struct({ pane: Schema.String, terminal: Schema.String })

const Done = Schema.Struct({})
