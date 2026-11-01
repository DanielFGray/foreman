// When an agent's terminal is worth an alert: its status changed, or its
// terminal ended. Only terminals that report a status (agents) count, and
// only changes the bridge saw happen: a terminal's first sighting is not news,
// and nothing counts across a lost hc connection, whose fresh snapshot would
// otherwise read every terminal that went away as ended. A terminal on
// another machine that goes away with its machine has not ended either.
import { Array, Duration, Effect, FiberMap, Option, pipe, Stream, String } from "effect"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
import type { AlertEvent } from "../shared/Push.ts"
import { localOf } from "./HerdrApp.ts"

export interface Alert {
  readonly terminal: string
  readonly event: AlertEvent
  /** The terminal's name, or its program's. */
  readonly title: string
}

/**
 * How long an alert waits before it goes out. A newer change in the same
 * terminal calls it off and waits in its place, so a question answered at
 * the desk, or a finish followed by the next prompt, never reaches the phone.
 */
export const ALERT_DELAY = Duration.seconds(10)

/** Runs `deliver` for each alert in the fleet's changes, ALERT_DELAY after the change, until the stream ends. */
export const watchAlerts = <R>(changes: Stream.Stream<Fleet>, deliver: (alert: Alert) => Effect.Effect<void, never, R>) =>
  Effect.gen(function* () {
    const pending = yield* FiberMap.make<string>()
    yield* changes.pipe(
      Stream.mapAccum(
        () => Option.none<Fleet>(),
        (last, next) => [Option.some(next), Option.match(last, { onNone: () => [], onSome: (previous) => alertsBetween(previous, next) })] as const,
      ),
      Stream.runForEach((alert) => FiberMap.run(pending, alert.terminal, Effect.delay(deliver(alert), ALERT_DELAY))),
    )
  }).pipe(Effect.scoped)

/** The alerts that the change from `previous` to `next` gives. */
export const alertsBetween = (previous: Fleet, next: Fleet): ReadonlyArray<Alert> => {
  if (!previous.connected || !next.connected) {
    return []
  }
  const changed = Array.flatMap(next.terminals, (terminal) =>
    Option.match(
      Array.findFirst(previous.terminals, ({ address }) => address === terminal.address),
      { onNone: () => [], onSome: (before) => Array.map(Option.toArray(eventBetween(before, terminal)), (event) => alertOf(terminal, event)) },
    ),
  )
  const gone = Array.filter(
    previous.terminals,
    (before) =>
      isAgent(before) && before.state === "live" && isReachable(next, before.address) && !Array.some(next.terminals, ({ address }) => address === before.address),
  )
  return [...changed, ...Array.map(gone, (terminal) => alertOf(terminal, "ended"))]
}

const eventBetween = (before: Terminal, after: Terminal): Option.Option<AlertEvent> =>
  isAgent(before) && before.state === "live" && after.state === "finished"
    ? Option.some("ended")
    : Option.filter(stateOf(after), (state) => !Option.contains(stateOf(before), state))

/** Whether a terminal that went away could have ended: one on another machine may only have dropped off the network with it. */
const isReachable = (fleet: Fleet, address: string) =>
  Option.match(localOf(address).on, {
    onNone: () => true,
    onSome: (machine) => Array.some(fleet.machines, ({ name, state }) => name === machine && state === "connected"),
  })

const isAgent = (terminal: Terminal) => Option.isSome(terminal.status)

const stateOf = (terminal: Terminal) => Option.map(terminal.status, ({ state }) => state)

const alertOf = (terminal: Terminal, event: AlertEvent): Alert => ({
  terminal: terminal.address,
  event,
  title: pipe(
    Option.filter(terminal.name, String.isNonEmpty),
    Option.orElse(() => Option.map(terminal.foreground, ({ name }) => name)),
    Option.getOrElse(() => "terminal"),
  ),
})
