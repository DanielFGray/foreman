// The hc calls the bridge makes. Calls share one connection, opened on first
// use and opened again after hc restarts. A subscription has a connection of
// its own, because once subscribed a plain-mode connection carries only
// notifications.
import { Config, Context, Duration, Effect, Layer, Option, RcRef, Schema } from "effect"
import { HerdrAppDoc, MachineState, Terminal } from "../shared/Fleet.ts"
import { wireTag } from "../shared/Wire.ts"
import { connect, method, type Method } from "./Connection.ts"

/**
 * What a subscription reports. Every terminal event (status, turn, title,
 * labels, finished, removed, ...) only says which terminal changed: the read
 * model fetches it again, so this client depends on no event's payload.
 */
export const Event = Schema.Union([
  Schema.Struct({
    _tag: wireTag("Doc"),
    type: Schema.Literal("doc"),
    data: Schema.Struct({ name: Schema.String }),
    /** Set when the document is another machine's. */
    machine: Schema.OptionFromOptionalKey(Schema.String),
  }),
  Schema.Struct({ _tag: wireTag("Changed"), type: Schema.String, terminal: Schema.String }),
])

export const Notification = Schema.Union([
  Schema.Struct({ _tag: wireTag("Event"), method: Schema.Literal("event"), params: Event }),
  Schema.Struct({ _tag: wireTag("Heartbeat"), method: Schema.Literal("heartbeat") }),
  /** The subscriber fell behind and events were dropped: start again from a snapshot. */
  Schema.Struct({ _tag: wireTag("Missed"), method: Schema.Literal("missed") }),
])
export type Notification = typeof Notification.Type

const TerminalParams = Schema.Struct({ terminal: Schema.String })

const get = method("terminal.get", TerminalParams, Terminal)

/** Pastes text and presses Enter once nobody has typed for about 3 s; refused while the program is blocked. */
const send = method(
  "terminal.send",
  Schema.Struct({ terminal: Schema.String, text: Schema.String }),
  Schema.Struct({ turn: Schema.Int }),
)

/** Presses named keys: enter, esc, tab, up, ctrl+c, 1, y, ... */
const keys = method(
  "terminal.keys",
  Schema.Struct({ terminal: Schema.String, keys: Schema.Array(Schema.String) }),
  Schema.Struct({ turn: Schema.Int }),
)

/** The terminal's screen as text. */
const read = method("terminal.read", TerminalParams, Schema.Struct({ text: Schema.String }))

/** A document here, or on the machine `on` names. */
const docGet = method(
  "doc.get",
  Schema.Struct({ name: Schema.String, on: Schema.OptionFromOptionalKey(Schema.String) }),
  Schema.Struct({ value: Schema.OptionFromNullOr(HerdrAppDoc) }),
)

const machineList = method(
  "machine.list",
  Schema.Struct({}),
  Schema.Struct({ machines: Schema.Array(Schema.Struct({ name: Schema.String, state: MachineState })) }),
)

const serverStatus = method("server.status", Schema.Struct({}), Schema.Struct({ core: Schema.Struct({ name: Schema.String }) }))

const subscribeMethod = method(
  "events.subscribe",
  Schema.Struct({}),
  Schema.Struct({ terminals: Schema.Array(Terminal) }),
)

/** herdr-app's document: its spaces and their tabs. */
export const HERDR_APP_DOC = "herdr-app"

export class Hc extends Context.Service<Hc>()("herdr-web/hc/Hc", {
  make: Effect.gen(function* () {
    const runtime = yield* Config.String("XDG_RUNTIME_DIR")
    const path = `${runtime}/herdr-core/default.sock`
    const requests = yield* RcRef.make({
      acquire: connect(path, Schema.Never),
      // Kept open between calls; a lost connection is dropped on its first failure.
      idleTimeToLive: Duration.minutes(5),
    })

    const call = <P, A, AI>(m: Method<P, A, AI>, params: P) =>
      RcRef.get(requests).pipe(
        Effect.flatMap((connection) => connection.call(m, params)),
        Effect.tapErrorTag("HcLost", () => RcRef.invalidate(requests)),
        Effect.scoped,
      )

    return {
      get: (terminal: string) => call(get, { terminal }),
      send: (terminal: string, text: string) => call(send, { terminal, text }),
      keys: (terminal: string, names: ReadonlyArray<string>) => call(keys, { terminal, keys: names }),
      /** What the terminal shows now, as text. */
      screen: (terminal: string) => Effect.map(call(read, { terminal }), ({ text }) => text),
      /** herdr-app's spaces here, or on another machine. None yet means herdr-app has not run there. */
      spaces: (on: Option.Option<string>) =>
        call(docGet, { name: HERDR_APP_DOC, on }).pipe(
          Effect.map(({ value }) => Option.match(value, { onNone: () => [], onSome: (doc) => doc.spaces })),
        ),
      /** The other machines and how hc reaches each now. */
      machines: Effect.map(call(machineList, {}), ({ machines }) => machines),
      /** This machine's name. */
      name: Effect.map(call(serverStatus, {}), ({ core }) => core.name),
      /**
       * Opens a subscription in the current scope: the terminals now, then
       * notifications. The stream fails with HcLost when hc goes away.
       */
      subscribe: Effect.gen(function* () {
        const connection = yield* connect(path, Notification)
        const { terminals } = yield* connection.call(subscribeMethod, {})
        return { terminals, notifications: connection.notifications }
      }),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
