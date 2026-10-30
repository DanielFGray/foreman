// The hc calls the bridge makes. Calls share one connection, opened on first
// use and opened again after hc restarts. A subscription has a connection of
// its own, because once subscribed a plain-mode connection carries only
// notifications.
import { Config, Context, Duration, Effect, Layer, Option, RcRef, Schema as S } from "effect"
import { MachineState, Terminal } from "../shared/Fleet.ts"
import { wireTag } from "../shared/Wire.ts"
import { LayoutDoc, spacesOf } from "./LayoutDoc.ts"
import { connect, method, type Method } from "./Connection.ts"

/**
 * What a subscription reports. Every terminal event (status, turn, title,
 * labels, finished, removed, ...) only says which terminal changed: the read
 * model fetches it again, so this client depends on no event's payload.
 */
export const Event = S.Union([
  S.Struct({
    _tag: wireTag("Doc"),
    type: S.Literal("doc"),
    data: S.Struct({ name: S.String }),
    /** Set when the document is another machine's. */
    machine: S.OptionFromOptionalKey(S.String),
  }),
  S.Struct({ _tag: wireTag("Changed"), type: S.String, terminal: S.String }),
])

export const Notification = S.Union([
  S.Struct({ _tag: wireTag("Event"), method: S.Literal("event"), params: Event }),
  S.Struct({ _tag: wireTag("Heartbeat"), method: S.Literal("heartbeat") }),
  /** The subscriber fell behind and events were dropped: start again from a snapshot. */
  S.Struct({ _tag: wireTag("Missed"), method: S.Literal("missed") }),
])
export type Notification = typeof Notification.Type

const TerminalParams = S.Struct({ terminal: S.String })

const get = method("terminal.get", TerminalParams, Terminal)

/** Pastes text and presses Enter once nobody has typed for about 3 s; refused while the program is blocked, unless `force`. */
const send = method(
  "terminal.send",
  S.Struct({ terminal: S.String, text: S.String, force: S.optionalKey(S.Boolean) }),
  S.Struct({ turn: S.Int }),
)

/** Presses named keys: enter, esc, tab, up, ctrl+c, 1, y, ... */
const keys = method(
  "terminal.keys",
  S.Struct({ terminal: S.String, keys: S.Array(S.String) }),
  S.Struct({ turn: S.Int }),
)

/** The terminal's screen as text. */
const read = method("terminal.read", TerminalParams, S.Struct({ text: S.String }))

const DocName = S.Struct({ name: S.String, on: S.OptionFromOptionalKey(S.String) })

/** herdr-app's layout and its version; none, at version 0, before herdr-app first runs there. */
const layoutGet = method("doc.get", DocName, S.Struct({ value: S.OptionFromNullOr(LayoutDoc), version: S.Int }))

/** Writes the layout if its version is still `version`; else fails with kind `conflict`. */
const layoutSet = method(
  "doc.set",
  S.Struct({ name: S.String, value: LayoutDoc, version: S.Int, on: S.OptionFromOptionalKey(S.String) }),
  S.Struct({ version: S.Int }),
)

/** Starts a program, or with no argv that machine's shell, in a new terminal kept after it exits, as herdr-app starts a pane's. */
const run = method(
  "terminal.run",
  S.Struct({
    argv: S.Array(S.String),
    cwd: S.String,
    env: S.Record(S.String, S.String),
    labels: S.Record(S.String, S.String),
    keep: S.Boolean,
    on: S.OptionFromOptionalKey(S.String),
  }),
  S.Struct({ address: S.String, cwd: S.String }),
)

/** Ends the program: hangup, then terminate, then kill. */
const kill = method("terminal.kill", TerminalParams, S.Struct({}))

const machineList = method(
  "machine.list",
  S.Struct({}),
  S.Struct({ machines: S.Array(S.Struct({ name: S.String, state: MachineState })) }),
)

const serverStatus = method("server.status", S.Struct({}), S.Struct({ core: S.Struct({ name: S.String }) }))

const subscribeMethod = method(
  "events.subscribe",
  S.Struct({}),
  S.Struct({ terminals: S.Array(Terminal) }),
)

const ExecParams = S.Struct({
  argv: S.Array(S.String),
  cwd: S.OptionFromOptionalKey(S.String),
  on: S.OptionFromOptionalKey(S.String),
  /** Seconds before the program and what it started are ended. */
  timeout: S.OptionFromOptionalKey(S.Finite),
})

/** Runs a program with no terminal, here or on the machine `on` names. A nonzero exit or a timeout is a result, not an error. */
const exec = method(
  "machine.exec",
  ExecParams,
  S.Struct({
    /** None when a signal ended the program. */
    code: S.OptionFromOptionalNullOr(S.Int),
    stdout: S.StringFromBase64,
    stderr: S.StringFromBase64,
    truncated: S.Boolean,
    timed_out: S.Boolean,
  }),
)

/** herdr-app's document: its spaces and their tabs. */
export const HERDR_APP_DOC = "herdr-app"

export class Hc extends Context.Service<Hc>()("herdr-web/hc/Hc", {
  make: Effect.gen(function* () {
    const runtime = yield* Config.String("XDG_RUNTIME_DIR")
    const path = `${runtime}/herdr-core/default.sock`
    const requests = yield* RcRef.make({
      acquire: connect(path, S.Never),
      // Kept open between calls; a lost connection is dropped on its first failure.
      idleTimeToLive: Duration.minutes(5),
    })

    const call = <P, A, AI>(m: Method<P, A, AI>, params: P) =>
      RcRef.get(requests).pipe(
        Effect.flatMap((connection) => connection.call(m, params)),
        Effect.tapErrorTag("HcLost", () => RcRef.invalidate(requests)),
        Effect.scoped,
      )

    // Before herdr-app first runs on a machine its document is null, at version 0.
    const layout = (on: Option.Option<string>) =>
      call(layoutGet, { name: HERDR_APP_DOC, on }).pipe(
        Effect.map(({ value, version }) => ({ doc: Option.getOrElse(value, (): LayoutDoc => ({ spaces: [] })), version })),
      )

    return {
      get: (terminal: string) => call(get, { terminal }),
      send: (terminal: string, text: string) => call(send, { terminal, text }),
      /** Types text into the dialog a blocked program shows; the caller first checks that the screen still shows it. */
      answer: (terminal: string, text: string) => call(send, { terminal, text, force: true }),
      keys: (terminal: string, names: ReadonlyArray<string>) => call(keys, { terminal, keys: names }),
      /** What the terminal shows now, as text. */
      screen: (terminal: string) => Effect.map(call(read, { terminal }), ({ text }) => text),
      /** herdr-app's spaces here, or on another machine, as the page shows them. None before herdr-app first runs there. */
      spaces: (on: Option.Option<string>) => Effect.map(layout(on), ({ doc }) => spacesOf(doc)),
      /** herdr-app's layout here, or on another machine, at its version. */
      layout,
      /** Writes herdr-app's layout over the one read at `version`; fails with kind `conflict` when another write came first. */
      setLayout: (on: Option.Option<string>, doc: LayoutDoc, version: number) =>
        call(layoutSet, { name: HERDR_APP_DOC, value: doc, version, on }).pipe(Effect.asVoid),
      /** Starts a pane's program in a new terminal, in `cwd`, with `labels`; its address and the folder it started in. An empty argv starts the shell. */
      start: (params: Readonly<{ argv: ReadonlyArray<string>; cwd: string; labels: Readonly<Record<string, string>>; on: Option.Option<string> }>) =>
        call(run, { ...params, env: SHELL_ENV, keep: true }),
      kill: (terminal: string) => call(kill, { terminal }).pipe(Effect.asVoid),
      /** Runs a program here or on another machine, with no shell. */
      exec: (params: typeof ExecParams.Type) => call(exec, params),
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

/** What herdr-app gives a pane's shell, so programs in it draw as they do in the window. */
const SHELL_ENV = { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "herdr" }
