// OpenCode's adapter: its chat from OpenCode's database, read with `sqlite3`
// on the terminal's machine. hc reports no event when OpenCode writes a
// message, so the bridge reads the session again each time hc's report of the
// terminal changes, and on each poll while OpenCode works.
import { Array, Effect, Option, Schedule, Schema, Stream } from "effect"
import { Hc } from "../../hc/Hc.ts"
import { BridgeError } from "../../shared/Api.ts"
import { type ChatUpdate, Entry } from "../../shared/Chat.ts"
import { Terminal } from "../../shared/Fleet.ts"
import { toBridgeError } from "../hcError.ts"
import { localOf } from "../HerdrApp.ts"
import { DATABASE_PATH } from "./Database.ts"
import { Messages, messagesQuery, toEntries } from "./Messages.ts"
import { Sessions, sessionsQuery, shownSession } from "./Session.ts"

export const openCode = Effect.gen(function* () {
  const hc = yield* Hc

  /** What `argv` prints on the machine `on`; fails when it exits with another code than 0. */
  const run = (on: Option.Option<string>, argv: ReadonlyArray<string>) =>
    hc.exec({ argv, cwd: Option.none(), on, timeout: Option.some(TIMEOUT) }).pipe(
      Effect.mapError(toBridgeError),
      Effect.flatMap(({ code, stdout, stderr }) =>
        Option.contains(code, 0) ? Effect.succeed(stdout) : Effect.fail(chatError(`${argv[0]} failed: ${stderr.trim()}`)),
      ),
    )

  /** Reads one session's chat from the database at `database` on the machine `on`. */
  const reader = (on: Option.Option<string>, database: string) => {
    const query = (sql: string) => run(on, ["sqlite3", "-readonly", "-batch", "-noheader", database, sql])

    const sessionIn = (terminal: Terminal, before: Option.Option<string>) =>
      query(sessionsQuery(terminal.cwd)).pipe(Effect.flatMap(decodeSessions), Effect.map((sessions) => shownSession(terminal, sessions, before)))

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

  return {
    chat: (terminal: Terminal) => {
      const { on } = localOf(terminal.address)
      return Stream.unwrap(
        Effect.map(run(on, ["sh", "-c", DATABASE_PATH]), (database) =>
          Stream.fromEffectSchedule(Effect.mapError(hc.get(terminal.address), toBridgeError), Schedule.spaced(POLL)).pipe(
            Stream.mapAccumEffect((): Seen => ({ terminal: Option.none(), session: Option.none(), entries: Option.none() }), reader(on, database)),
          ),
        ),
      )
    },
  }
})

/** What the chat read last: the terminal as hc reported it, its session, and the entries sent. */
type Seen = Readonly<{ terminal: Option.Option<Terminal>; session: Option.Option<string>; entries: Option.Option<ReadonlyArray<Entry>> }>

const POLL = "1 second"

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
