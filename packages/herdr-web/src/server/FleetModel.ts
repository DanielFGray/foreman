// The bridge's picture of hc: every terminal and herdr-app's spaces, kept
// current from one subscription and offered to pages as a stream of values.
//
// A terminal event only marks a terminal as changed; the model fetches it
// again with terminal.get, and a not_found reply removes it. When hc goes away
// or reports that this subscriber fell behind, the model subscribes again and
// starts over from hc's snapshot.
import { Context, Effect, Layer, Match, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import { HERDR_APP_DOC, Hc, type Notification } from "../hc/Hc.ts"
import type { Fleet, Terminal } from "../shared/Fleet.ts"

class FellBehind extends Schema.TaggedError<FellBehind, { readonly brand: unique symbol }>()("FellBehind", {}) {}

export class FleetModel extends Context.Service<FleetModel>()("herdr-web/server/FleetModel", {
  make: Effect.gen(function* () {
    const hc = yield* Hc
    const fleet = yield* SubscriptionRef.make<Fleet>({ connected: false, terminals: [], spaces: [] })

    const put = (terminal: Terminal) =>
      SubscriptionRef.update(fleet, (f) => ({ ...f, terminals: upsert(f.terminals, terminal) }))
    const drop = (address: string) =>
      SubscriptionRef.update(fleet, (f) => ({ ...f, terminals: f.terminals.filter((t) => t.address !== address) }))

    const refetch = (address: string) =>
      hc.get(address).pipe(
        Effect.flatMap(put),
        Effect.catchIf(
          (error) => error._tag === "HcError" && error.kind === "not_found",
          () => drop(address),
        ),
      )
    const refreshSpaces = hc.spaces.pipe(Effect.flatMap((spaces) => SubscriptionRef.update(fleet, (f) => ({ ...f, spaces }))))

    const apply = (notification: Notification) =>
      Match.valueTags(notification, {
        Heartbeat: () => Effect.void,
        Missed: () => Effect.fail(new FellBehind()),
        Event: ({ params }) =>
          Match.valueTags(params, {
            Doc: ({ data }) => (data.name === HERDR_APP_DOC ? refreshSpaces : Effect.void),
            Changed: ({ terminal }) => refetch(terminal),
          }),
      })

    const follow = Effect.gen(function* () {
      const { terminals, notifications } = yield* hc.subscribe
      const spaces = yield* hc.spaces
      yield* SubscriptionRef.set(fleet, { connected: true, terminals, spaces })
      yield* notifications.pipe(Stream.runForEach(apply))
    }).pipe(
      Effect.scoped,
      Effect.tapCause((cause) =>
        Effect.logWarning("hc subscription ended; subscribing again", cause).pipe(
          Effect.andThen(SubscriptionRef.update(fleet, (f) => ({ ...f, connected: false }))),
        ),
      ),
    )

    yield* follow.pipe(Effect.retry(Schedule.spaced("2 seconds")), Effect.forkScoped)

    return {
      /** The current value, then every change. */
      changes: SubscriptionRef.changes(fleet),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/** Replaces the terminal with the same address, or adds it at the end. */
const upsert = (terminals: ReadonlyArray<Terminal>, terminal: Terminal) =>
  terminals.some((t) => t.address === terminal.address)
    ? terminals.map((t) => (t.address === terminal.address ? terminal : t))
    : [...terminals, terminal]
