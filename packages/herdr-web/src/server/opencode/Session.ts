// Which OpenCode session a terminal shows. OpenCode does not tell the
// terminal. Two signals point to it:
//   - the terminal title, `OC | <session title>` clipped to 40 characters, or
//     `OpenCode` on the home screen and for a session with no title yet;
//   - the status records (OSC 7501), one per session that works or waits on
//     the user, keyed by the session id, for each of the TUI's tabs.
// The title picks the sessions, the records narrow them, and the session the
// chat showed before breaks a tie. A record of a session id that is not 1–32
// characters of [\w.+-] is keyed by a hash instead; OpenCode's own ids always
// fit, so such a record narrows nothing.
import { Array, Option, Record, Schema as S, String } from "effect"
import type { Terminal } from "../../shared/Fleet.ts"
import { quoted } from "./Database.ts"

/** SQL for the sessions OpenCode ran in `directory`, as one JSON array of `SessionSummary`. */
export const sessionsQuery = (directory: string) => `
select json_group_array(json_object('id', id, 'title', title, 'parentID', parent_id, 'model', json(model)))
from session_v2 where directory = ${quoted(directory)}`

/** A model as OpenCode names it: by its provider, and its id there. */
export const ModelRef = S.Struct({ id: S.String, providerID: S.String })
export type ModelRef = typeof ModelRef.Type

export const SessionSummary = S.Struct({
  id: S.String,
  title: S.OptionFromNullOr(S.String),
  parentID: S.OptionFromNullOr(S.String),
  /** The model the session asks for, which a pick changes at once; none while it takes OpenCode's default. */
  model: S.OptionFromNullOr(ModelRef),
})
export type SessionSummary = typeof SessionSummary.Type

/** What `sessionsQuery` prints. */
export const Sessions = S.Array(SessionSummary)

/** The session `terminal` shows, among `sessions` in its folder; none when the signals do not settle on one. */
export const shownSession = (terminal: Terminal, sessions: ReadonlyArray<SessionSummary>, before: Option.Option<string>): Option.Option<string> => {
  const says = titleSays(terminal.title)
  const candidates = Array.filter(sessions, (session) => Option.isNone(session.parentID) && says.fits(session))
  const pending = pendingIds(terminal)
  const named = Array.filter(candidates, ({ id }) => Array.contains(pending, id))
  const pool = Array.map(Array.isReadonlyArrayNonEmpty(named) ? named : candidates, ({ id }) => id)
  return Option.orElse(Option.filter(before, (id) => Array.contains(pool, id)), () =>
    pool.length === 1 && (says.isExact || Array.isReadonlyArrayNonEmpty(named)) ? Array.head(pool) : Option.none(),
  )
}

/**
 * Which sessions the title can belong to. `isExact` when the title names its
 * session; a title OpenCode did not set, when its `terminal.title` setting is
 * off, fits every session.
 */
const titleSays = (title: Option.Option<string>): Readonly<{ fits: (session: SessionSummary) => boolean; isExact: boolean }> =>
  Option.match(title, {
    onNone: () => ANY,
    onSome: (text) =>
      String.startsWith(TITLED)(text)
        ? { fits: ({ title }) => Option.exists(title, (own) => !isFallback(own) && clipped(own) === text.slice(TITLED.length)), isExact: true }
        : text === UNTITLED
          ? { fits: ({ title }) => Option.match(title, { onNone: () => true, onSome: isFallback }), isExact: false }
          : ANY,
  })

const ANY = { fits: () => true, isExact: false }

const TITLED = "OC | "
const UNTITLED = "OpenCode"

/** OpenCode's own rule for the title it shows. */
const clipped = (title: string) => (title.length > 40 ? `${title.slice(0, 37)}…` : title)

/** A title OpenCode does not show: none yet, or one it made up for a session with none of its own. */
const isFallback = (title: string) => String.isEmpty(title) || FALLBACK.test(title)

const FALLBACK = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const pendingIds = ({ records }: Terminal) =>
  Option.match(records, {
    onNone: () => [],
    onSome: (all) => Record.keys(Record.filter(all, ({ state }) => state === "working" || state === "blocked")),
  })
