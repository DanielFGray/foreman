// Live terminals the pages have attached. A page's attach call is a stream.
// A typing page gets a session number first, and its input and resize calls
// name that session; a session ends with its stream. A watching page gets the
// terminal's size first, and again, with a fresh paint, after each change.
import { Array, Config, Context, Effect, Layer, Match, MutableHashMap, Option, Ref, Result, Stream } from "effect"
import { type Attached, attach, HISTORY_LINES, observe } from "../hc/Attach.ts"
import { HcLost } from "../hc/Connection.ts"
import { Attached as AttachedUpdate, Output, Sized, type Viewer } from "../shared/Api.ts"
import { FleetModel } from "./FleetModel.ts"

export class LiveTerminals extends Context.Service<LiveTerminals>()("herdr-web/server/LiveTerminals", {
  make: Effect.gen(function* () {
    const runtime = yield* Config.String("XDG_RUNTIME_DIR")
    const path = `${runtime}/herdr-core/default.sock`
    const fleet = yield* FleetModel
    const sessions = MutableHashMap.empty<number, Attached>()
    const next = yield* Ref.make(0)

    // A session that has ended (the page reconnected, or hc went away) is a lost line.
    const session = (id: number) =>
      Effect.fromOption(MutableHashMap.get(sessions, id)).pipe(
        Effect.mapError(() => new HcLost({ cause: `no live terminal session ${id}` })),
      )

    const typing = (terminal: string, cols: number, rows: number) =>
      Effect.gen(function* () {
        const attached = yield* attach(path, { terminal, cols, rows })
        const id = yield* Ref.getAndUpdate(next, (n) => n + 1)
        MutableHashMap.set(sessions, id, attached)
        yield* Effect.addFinalizer(() => Effect.sync(() => MutableHashMap.remove(sessions, id)))
        return Stream.concat(
          Stream.make(AttachedUpdate.make({ session: id })),
          attached.output.pipe(Stream.map((bytes) => Output.make({ bytes }))),
        )
      }).pipe(Stream.unwrap)

    // hc tells a watcher nothing when the size changes, and the program's
    // redraw may come before the page learns of it. So each new size from the
    // fleet starts a new watch, whose first paint is at that size.
    const watching = (terminal: string) =>
      fleet.changes.pipe(
        Stream.map(({ terminals }) => Option.map(Array.findFirst(terminals, ({ address }) => address === terminal), ({ cols, rows }) => ({ cols, rows }))),
        Stream.filterMap(Result.fromOption(() => undefined)),
        Stream.changesWith((a, b) => a.cols === b.cols && a.rows === b.rows),
        Stream.switchMap(({ cols, rows }) =>
          Effect.map(observe(path, terminal, HISTORY_LINES), ({ output }) =>
            Stream.concat(Stream.make(Sized.make({ cols, rows })), output.pipe(Stream.map((bytes) => Output.make({ bytes })))),
          ).pipe(Stream.unwrap),
        ),
      )

    return {
      /** The terminal's updates, as the viewer sees them, for as long as the stream is read. */
      attach: (terminal: string, as: Viewer) =>
        Match.valueTags(as, {
          Typing: ({ cols, rows }) => typing(terminal, cols, rows),
          Watching: () => watching(terminal),
        }),
      input: (id: number, text: string) =>
        session(id).pipe(Effect.flatMap(({ input }) => input(new TextEncoder().encode(text)))),
      resize: (id: number, cols: number, rows: number) =>
        session(id).pipe(Effect.flatMap(({ resize }) => resize(cols, rows))),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
