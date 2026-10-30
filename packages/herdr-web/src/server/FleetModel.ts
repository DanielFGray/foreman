// The bridge's picture of hc: every machine's terminals and herdr-app spaces,
// kept current from one subscription and offered to pages as a stream of values.
//
// A terminal event only marks a terminal as changed; the model fetches it
// again with terminal.get, and a not_found reply removes it. A document event
// names the machine whose herdr-app spaces changed. hc reports no event when a
// machine connects or drops, so each heartbeat (every 15 s) reads the machines
// again. When hc goes away or reports that this subscriber fell behind, the
// model subscribes again and starts over from hc's snapshot.
import { Array, Context, Effect, Layer, Match, Option, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import { HERDR_APP_DOC, Hc, type Notification } from "../hc/Hc.ts"
import type { Fleet, Layout, Machine, Space, Terminal } from "../shared/Fleet.ts"

class FellBehind extends Schema.TaggedError<FellBehind, { readonly brand: unique symbol }>()("FellBehind", {}) {}

export class FleetModel extends Context.Service<FleetModel>()("herdr-web/server/FleetModel", {
  make: Effect.gen(function* () {
    const hc = yield* Hc
    const fleet = yield* SubscriptionRef.make<Fleet>({ connected: false, terminals: [], machines: [] })

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

    // A machine that refuses the read (it dropped, or needs a login) keeps the
    // spaces last seen, so they do not flicker away.
    const readSpaces = ({ name, isLocal }: Pick<Machine, "name" | "isLocal">, last: ReadonlyArray<Space>) =>
      hc.spaces(isLocal ? Option.none() : Option.some(name)).pipe(
        Effect.map((spaces) => (isLocal ? spaces : Array.map(spaces, onMachine(name)))),
        Effect.catchTag("HcError", (error) =>
          Effect.as(Effect.logWarning(`cannot read herdr-app's spaces on ${name}`, error.message), last),
        ),
      )

    const refreshSpaces = (on: Option.Option<string>) =>
      Effect.gen(function* () {
        const { machines } = yield* SubscriptionRef.get(fleet)
        const isNamed = (machine: Machine) => Option.match(on, { onNone: () => machine.isLocal, onSome: (name) => machine.name === name })
        yield* Effect.forEach(Array.filter(machines, isNamed), (machine) =>
          Effect.flatMap(readSpaces(machine, machine.spaces), (spaces) =>
            SubscriptionRef.update(fleet, (f) => ({
              ...f,
              machines: Array.map(f.machines, (m) => (m.name === machine.name ? { ...m, spaces } : m)),
            })),
          ),
        )
      })

    // A machine's spaces are read when it connects; until then it keeps the last ones.
    const others = (previous: ReadonlyArray<Machine>) =>
      Effect.flatMap(hc.machines, (listed) =>
        Effect.forEach(
          listed,
          ({ name, state }) => {
            const last = Array.findFirst(previous, (machine) => machine.name === name)
            const lastSpaces = Option.match(last, { onNone: () => [], onSome: ({ spaces }) => spaces })
            const isBack = state === "connected" && !Option.exists(last, (machine) => machine.state === "connected")
            return Effect.map(isBack ? readSpaces({ name, isLocal: false }, lastSpaces) : Effect.succeed(lastSpaces), (spaces): Machine => ({
              name,
              isLocal: false,
              state,
              spaces,
            }))
          },
          { concurrency: "unbounded" },
        ),
      )

    const refreshMachines = Effect.gen(function* () {
      const { machines } = yield* SubscriptionRef.get(fleet)
      const next = yield* others(machines)
      yield* SubscriptionRef.update(fleet, (f) => ({ ...f, machines: [...Array.filter(f.machines, ({ isLocal }) => isLocal), ...next] }))
    })

    const apply = (notification: Notification) =>
      Match.valueTags(notification, {
        Heartbeat: () => refreshMachines,
        Missed: () => Effect.fail(new FellBehind()),
        Event: ({ params }) =>
          Match.valueTags(params, {
            Doc: ({ data, machine }) => (data.name === HERDR_APP_DOC ? refreshSpaces(machine) : Effect.void),
            Changed: ({ terminal }) => refetch(terminal),
          }),
      })

    const follow = Effect.gen(function* () {
      const { terminals, notifications } = yield* hc.subscribe
      const name = yield* hc.name
      const local: Machine = { name, isLocal: true, state: "connected", spaces: yield* readSpaces({ name, isLocal: true }, []) }
      yield* SubscriptionRef.set(fleet, { connected: true, terminals, machines: [local, ...(yield* others([]))] })
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

/**
 * A space read from another machine's document, addressed from here: its
 * ids, and the terminals its layout shows, take the machine's name in front,
 * as herdr-app and hc address them (`cynic/t7`).
 */
export const onMachine = (machine: string) => {
  const at = (id: string) => `${machine}/${id}`
  const layout = (node: Layout): Layout =>
    Match.valueTags(node, {
      Block: (block) => ({
        ...block,
        id: at(block.id),
        content: block.content._tag === "Terminal" ? { ...block.content, terminal: at(block.content.terminal) } : block.content,
      }),
      Split: (split) => ({ ...split, id: at(split.id), children: Array.map(split.children, layout) }),
      Unknown: (unknown) => unknown,
    })
  return (space: Space): Space => ({
    ...space,
    id: at(space.id),
    tabs: Array.map(space.tabs, (tab) => ({ ...tab, id: at(tab.id), root: layout(tab.root) })),
  })
}

/** Replaces the terminal with the same address, or adds it at the end. */
const upsert = (terminals: ReadonlyArray<Terminal>, terminal: Terminal) =>
  terminals.some((t) => t.address === terminal.address)
    ? terminals.map((t) => (t.address === terminal.address ? terminal : t))
    : [...terminals, terminal]
