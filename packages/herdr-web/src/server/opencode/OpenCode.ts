// OpenCode's adapter. Its chat, and the model each session asks for, come from
// OpenCode's database, read with `sqlite3` on the terminal's machine. hc
// reports no event when OpenCode writes, so the bridge reads the database
// again each time hc's report of the terminal changes, and on each poll while
// OpenCode works. The models it may switch to and its commands come from
// OpenCode's server, which the bridge reaches on its own machine once paired
// (see Server.ts).
import { Array, Effect, Option, Schedule, Schema, Stream } from "effect"
import { Hc } from "../../hc/Hc.ts"
import { BridgeError } from "../../shared/Api.ts"
import { type ChatUpdate, Entry } from "../../shared/Chat.ts"
import { Terminal } from "../../shared/Fleet.ts"
import type { ModelChoices } from "../../shared/Harness.ts"
import type { SlashCommand } from "../../shared/SlashCommand.ts"
import { toBridgeError } from "../hcError.ts"
import { localOf } from "../HerdrApp.ts"
import { DATABASE_PATH } from "./Database.ts"
import { Messages, messagesQuery, toEntries } from "./Messages.ts"
import { OpenCodeServer } from "./Server.ts"
import { ModelRef, type SessionSummary, Sessions, sessionsQuery, shownSession } from "./Session.ts"

export const openCode = Effect.gen(function* () {
  const hc = yield* Hc
  const server = yield* OpenCodeServer

  /** What `argv` prints on the machine `on`; fails when it exits with another code than 0. */
  const run = (on: Option.Option<string>, argv: ReadonlyArray<string>) =>
    hc.exec({ argv, cwd: Option.none(), on, timeout: Option.some(TIMEOUT) }).pipe(
      Effect.mapError(toBridgeError),
      Effect.flatMap(({ code, stdout, stderr }) =>
        Option.contains(code, 0) ? Effect.succeed(stdout) : Effect.fail(chatError(`${argv[0]} failed: ${stderr.trim()}`)),
      ),
    )

  /** A query of OpenCode's database on the terminal's machine. */
  const databaseOf = (terminal: Terminal) => {
    const { on } = localOf(terminal.address)
    return Effect.map(run(on, ["sh", "-c", DATABASE_PATH]), (database) => (sql: string) => run(on, ["sqlite3", "-readonly", "-batch", "-noheader", database, sql]))
  }

  type Query = Effect.Success<ReturnType<typeof databaseOf>>

  const sessionsOf = (query: Query, terminal: Terminal) => Effect.flatMap(query(sessionsQuery(terminal.cwd)), decodeSessions)

  /** The session the terminal shows, as it reads now; none while that is not known. */
  const shownIn = (query: Query, terminal: Terminal): Effect.Effect<Option.Option<SessionSummary>, BridgeError> =>
    Effect.map(sessionsOf(query, terminal), (sessions) => Option.flatMap(shownSession(terminal, sessions, Option.none()), (id) => Array.findFirst(sessions, (one) => one.id === id)))

  const shownSessionOf = (terminal: Terminal) =>
    databaseOf(terminal).pipe(
      Effect.flatMap((query) => shownIn(query, terminal)),
      Effect.flatMap(Effect.fromOption),
      Effect.catchTag("NoSuchElementError", () => Effect.fail(new BridgeError({ kind: "session", message: "which OpenCode session this terminal shows is not known yet" }))),
    )

  /** Reads one session's chat with `query`. */
  const reader = (query: Query) => {
    const sessionIn = (terminal: Terminal, before: Option.Option<string>) =>
      Effect.map(sessionsOf(query, terminal), (sessions) => shownSession(terminal, sessions, before))

    const entriesOf = (session: string) => query(messagesQuery(session, MESSAGES)).pipe(Effect.flatMap(decodeMessages), Effect.map((messages) => toEntries(Array.reverse(messages))))

    /**
     * Reads the chat again when it is due: the report changed, or OpenCode
     * works. The session is looked up again only when the report changed,
     * since the title and the records are what point to it.
     */
    return Effect.fnUntraced(function* (seen: Seen, terminal: Terminal) {
      const isChanged = !Option.exists(seen.terminal, (before) => sameTerminal(before, terminal))
      const isWorking = Option.exists(terminal.status, ({ state }) => state === "working")
      if (!isChanged && !isWorking) {
        return [seen, []] as const
      }
      const session = isChanged || Option.isNone(seen.session) ? yield* sessionIn(terminal, seen.session) : seen.session
      if (Option.isNone(session)) {
        return yield* chatError("which OpenCode session this terminal shows is not known yet; it shows once OpenCode works on it")
      }
      const entries = yield* entriesOf(session.value)
      const update: ReadonlyArray<ChatUpdate> = Option.exists(seen.entries, (before) => sameEntries(before, entries)) ? [] : [{ _tag: "Reset", entries }]
      return [{ terminal: Option.some(terminal), session, entries: Option.some(entries) }, update] as const
    })
  }

  // OpenCode's server listens on its own machine's loopback address, so the bridge reaches only the one on its own.
  const onServer = <A>(terminal: Terminal, call: Effect.Effect<A, BridgeError>) =>
    Option.isSome(localOf(terminal.address).on)
      ? Effect.fail(new BridgeError({ kind: "remote", message: "the bridge reaches only the OpenCode server on its own machine" }))
      : call

  const where = (terminal: Terminal) => ({ "location[directory]": terminal.cwd })

  return {
    chat: (terminal: Terminal) =>
      Stream.unwrap(
        Effect.map(databaseOf(terminal), (query) =>
          Stream.fromEffectSchedule(Effect.mapError(hc.get(terminal.address), toBridgeError), Schedule.spaced(POLL)).pipe(
            Stream.mapAccumEffect((): Seen => ({ terminal: Option.none(), session: Option.none(), entries: Option.none() }), reader(query)),
          ),
        ),
      ),
    model: {
      // Polled: a pick in the TUI or the page writes the session's row, and hc reports no event for it.
      watch: (terminal: Terminal) =>
        Stream.unwrap(
          Effect.map(databaseOf(terminal), (query) =>
            Stream.fromEffectSchedule(
              Effect.mapError(hc.get(terminal.address), toBridgeError).pipe(Effect.flatMap((now) => shownIn(query, now))),
              Schedule.spaced(MODEL_POLL),
            ).pipe(
              Stream.map((shown) => Option.map(Option.flatMap(shown, ({ model }) => model), aliasOf)),
              Stream.changes,
            ),
          ),
        ),
      choices: (terminal: Terminal) =>
        onServer(
          terminal,
          Effect.map(
            Effect.all({ models: server.get("/api/model", where(terminal), ModelList), shown: shownSessionOf(terminal) }),
            ({ models, shown }): ModelChoices => ({
              choices: Array.map(Array.filter(models.data, ({ enabled }) => enabled), (model) => ({ alias: aliasOf(model), name: model.name })),
              current: Option.map(shown.model, aliasOf),
              note: "OpenCode keeps the pick for this session.",
            }),
          ),
        ),
      pick: (terminal: Terminal, alias: string) =>
        onServer(
          terminal,
          Effect.gen(function* () {
            const model = yield* Effect.fromOption(refOf(alias)).pipe(Effect.mapError(() => new BridgeError({ kind: "model", message: `${alias} names no OpenCode model` })))
            const { id } = yield* shownSessionOf(terminal)
            yield* server.post(`/api/session/${encodeURIComponent(id)}/model`, SwitchModel, { model })
          }),
        ),
    },
    commands: (terminal: Terminal) =>
      onServer(
        terminal,
        Effect.map(server.get("/api/command", where(terminal), CommandList), ({ data }) =>
          Array.dedupeWith(
            [...BUILT_INS, ...Array.map(data, ({ name, description }): SlashCommand => ({ name, description: Option.getOrElse(description, () => ""), hint: Option.none(), origin: "server" }))],
            (a: SlashCommand, b: SlashCommand) => a.name === b.name,
          ),
        ),
      ),
    pairing: (terminal: Terminal) => onServer(terminal, server.pair),
  }
})

/**
 * The commands of OpenCode's TUI the composer offers, as OpenCode 2.1.4 names
 * them: the ones that act on their own, or with what is typed after them.
 * The ones that open a dialog need the terminal. `init` and `review` come
 * from the server, with the user's own commands.
 */
export const BUILT_INS: ReadonlyArray<SlashCommand> = Array.map(
  [
    ["new", "Start a new session", Option.none()],
    ["clear", "Clear the session", Option.none()],
    ["compact", "Summarise the session to free context", Option.none()],
    ["undo", "Undo the previous message", Option.none()],
    ["redo", "Redo the message undone last", Option.none()],
    ["fork", "Fork the session", Option.none()],
    ["rename", "Rename the session", Option.some("<name>")],
    ["cd", "Change the working directory", Option.some("<directory>")],
    ["btw", "Ask a side question", Option.some("<question>")],
    ["reload", "Reload the configuration", Option.none()],
  ] as const,
  ([name, description, hint]) => ({ name, description, hint, origin: "built-in" }),
)

/** A model's alias: `<provider>/<model>`, as OpenCode itself writes a model. */
const aliasOf = ({ providerID, id }: ModelRef) => `${providerID}/${id}`

/** The model an alias names; the model's own id may hold more slashes. */
const refOf = (alias: string): Option.Option<ModelRef> =>
  Option.map(Option.fromNullOr(/^([^/]+)\/(.+)$/.exec(alias)), ([, providerID = "", id = ""]) => ({ providerID, id }))

/** What `/api/model` answers, of what the picker shows. */
const ModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ ...ModelRef.fields, name: Schema.String, enabled: Schema.Boolean })) })

/** What `/api/command` answers. */
const CommandList = Schema.Struct({ data: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.OptionFromOptionalKey(Schema.String) })) })

const SwitchModel = Schema.Struct({ model: ModelRef })
/** What the chat read last: the terminal as hc reported it, its session, and the entries sent. */
type Seen = Readonly<{ terminal: Option.Option<Terminal>; session: Option.Option<string>; entries: Option.Option<ReadonlyArray<Entry>> }>

const POLL = "1 second"

const MODEL_POLL = "2 seconds"

/** Seconds a read may take before hc ends it. */
const TIMEOUT = 10

/** The newest messages the chat shows. */
const MESSAGES = 100

const sameTerminal = Schema.toEquivalence(Terminal)
const sameEntries = Schema.toEquivalence(Schema.Array(Entry))

const chatError = (message: string) => new BridgeError({ kind: "transcript", message })

const decodeSessions = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Sessions))(text).pipe(Effect.mapError(({ message }) => chatError(`OpenCode's sessions cannot be read: ${message}`)))

const decodeMessages = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Messages))(text).pipe(Effect.mapError(({ message }) => chatError(`OpenCode's messages cannot be read: ${message}`)))
