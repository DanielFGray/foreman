// Live terminals the pages have attached. A page's attach call is a stream; it
// gets a session number first, and its input and resize calls name that
// session. A session ends with its stream.
import { Config, Context, Effect, Layer, MutableHashMap, Ref, Stream } from "effect"
import { type AttachRequest, type Attached, attach } from "../hc/Attach.ts"
import { HcLost } from "../hc/Connection.ts"
import { Attached as AttachedUpdate, Output } from "../shared/Api.ts"

export class LiveTerminals extends Context.Service<LiveTerminals>()("herdr-web/server/LiveTerminals", {
  make: Effect.gen(function* () {
    const runtime = yield* Config.String("XDG_RUNTIME_DIR")
    const path = `${runtime}/herdr-core/default.sock`
    const sessions = MutableHashMap.empty<number, Attached>()
    const next = yield* Ref.make(0)

    // A session that has ended (the page reconnected, or hc went away) is a lost line.
    const session = (id: number) =>
      Effect.fromOption(MutableHashMap.get(sessions, id)).pipe(
        Effect.mapError(() => new HcLost({ cause: `no live terminal session ${id}` })),
      )

    return {
      /** The session number, then the terminal's output, for as long as the stream is read. */
      attach: (request: AttachRequest) =>
        Effect.gen(function* () {
          const attached = yield* attach(path, request)
          const id = yield* Ref.getAndUpdate(next, (n) => n + 1)
          MutableHashMap.set(sessions, id, attached)
          yield* Effect.addFinalizer(() => Effect.sync(() => MutableHashMap.remove(sessions, id)))
          return Stream.concat(
            Stream.make(AttachedUpdate.make({ session: id })),
            attached.output.pipe(Stream.map((bytes) => Output.make({ bytes }))),
          )
        }).pipe(Stream.unwrap),
      input: (id: number, text: string) =>
        session(id).pipe(Effect.flatMap(({ input }) => input(new TextEncoder().encode(text)))),
      resize: (id: number, cols: number, rows: number) =>
        session(id).pipe(Effect.flatMap(({ resize }) => resize(cols, rows))),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

