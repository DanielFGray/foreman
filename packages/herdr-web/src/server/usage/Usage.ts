// Keeps one reading per provider fresh while a page watches. The services rate
// limit these endpoints and the numbers move slowly, so reads are rare; a
// failed read keeps the last good numbers rather than blanking them.
import { Array, Clock, Config, Context, Duration, Effect, Layer, Option, Queue, RcRef, Result, Stream, SubscriptionRef } from "effect"
import type { ProviderId, Reading, UsageReport, UsageWindow } from "../../shared/Usage.ts"
import { readClaude } from "./Claude.ts"
import { readCodex } from "./Codex.ts"
import { readCursor } from "./Cursor.ts"
import { readOpencode } from "./OpenCode.ts"
import type { UsageEnv, UsageError } from "./Read.ts"

const PROVIDERS = [
  { id: "claude", name: "Claude", dashboard: "https://claude.ai/settings/usage", read: readClaude },
  { id: "codex", name: "Codex", dashboard: "https://chatgpt.com/codex/settings/usage", read: readCodex },
  { id: "opencode", name: "OpenCode", dashboard: "https://opencode.ai/auth", read: readOpencode },
  { id: "cursor", name: "Cursor", dashboard: "https://cursor.com/dashboard?tab=usage", read: readCursor },
] as const

export class Usage extends Context.Service<Usage>()("herdr-web/server/usage/Usage", {
  make: Effect.gen(function* () {
    const env = yield* UsageEnvConfig
    const states = yield* SubscriptionRef.make(Array.map(PROVIDERS, ({ id, name, dashboard }) => initialState({ id, name, dashboard })))
    // A refresh wakes a provider's sleeping poll; one waiting wake is enough.
    const slots = yield* Effect.forEach(PROVIDERS, (provider) => Effect.map(Queue.sliding<void>(1), (wake) => ({ provider, wake })))

    const stateOf = (id: ProviderId) =>
      Effect.map(SubscriptionRef.get(states), Array.findFirst(({ reading }) => reading.id === id))
    const setState = (id: ProviderId, f: (state: ProviderState) => ProviderState) =>
      SubscriptionRef.update(states, Array.map((state) => (state.reading.id === id ? f(state) : state)))

    // One fiber per provider, so that a slow or rate-limited service delays
    // no other. Each sleeps until its read is due, or until a refresh wakes it.
    const poll = ({ provider, wake }: (typeof slots)[number]) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const wait = Option.getOrElse(Option.map(yield* stateOf(provider.id), ({ nextAt }) => nextAt - now), () => 0)
        if (wait > 0) {
          yield* Effect.raceFirst(Effect.sleep(Duration.millis(wait)), Queue.take(wake))
          return
        }
        yield* setState(provider.id, (state) => ({ ...state, reading: { ...state.reading, isReading: true } }))
        const outcome = yield* Effect.result(provider.read(env))
        const at = yield* Clock.currentTimeMillis
        yield* setState(provider.id, (state) => afterRead(state, outcome, at))
      }).pipe(Effect.forever)

    const polling = yield* RcRef.make({
      acquire: Effect.forEach(slots, (slot) => Effect.forkScoped(poll(slot))),
      idleTimeToLive: IDLE_POLLING,
    })

    return {
      /** Every provider's reading now, then after each change; polls while read. */
      changes: Stream.unwrap(
        Effect.as(
          RcRef.get(polling),
          Stream.map(SubscriptionRef.changes(states), (all) => ({ readings: Array.map(all, ({ reading }) => reading) })),
        ),
      ),
      /** Reads one provider, or all, now: past the schedule and any backoff, but spaced. */
      refresh: (only: Option.Option<ProviderId>) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const all = yield* SubscriptionRef.get(states)
          const isChosen = ({ provider }: (typeof slots)[number]) =>
            Option.match(only, { onNone: () => true, onSome: (id) => id === provider.id }) &&
            Array.some(all, ({ reading, lastManual }) => reading.id === provider.id && now - lastManual >= MANUAL_SPACING)
          yield* Effect.forEach(Array.filter(slots, isChosen), ({ provider, wake }) =>
            setState(provider.id, (state) => ({ ...state, nextAt: 0, rejections: 0, lastManual: now })).pipe(
              Effect.andThen(Queue.offer(wake, undefined)),
            ),
          )
        }),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/** A provider's reading, and when to read it next. */
export type ProviderState = Readonly<{
  reading: Reading
  /** Rejected reads in a row. */
  rejections: number
  nextAt: number
  lastManual: number
}>

export const REFRESH = 10 * 60e3
export const RATE_LIMITED = 30 * 60e3
export const ERROR_BACKOFF = 5 * 60e3
// A sign-in the service rejected is asked again half as often after each
// rejection, up to this: a dead token sent every refresh can read as abuse.
export const REJECTED_LIMIT = 6 * 3600e3
const MANUAL_SPACING = 10e3
// A page reloading, or a phone waking, should find the polling still running.
const IDLE_POLLING = Duration.minutes(1)

/**
 * The state after a read at `now`: the new numbers, or the old ones with the
 * failure, and when to read next. Signed out drops the numbers.
 */
export const afterRead = (state: ProviderState, outcome: Result.Result<Option.Option<UsageReport>, UsageError>, now: number): ProviderState =>
  Result.match(outcome, {
    onSuccess: (report) => ({
      ...state,
      reading: {
        ...state.reading,
        report: Option.map(report, clampReport),
        updated: Option.map(report, () => now),
        error: Option.none(),
        isReading: false,
      },
      rejections: 0,
      nextAt: now + REFRESH,
    }),
    onFailure: ({ kind, message }) => {
      const rejections = kind === "rejected" ? state.rejections + 1 : state.rejections
      const delay =
        kind === "rejected" ? Math.min(REFRESH * 2 ** (rejections - 1), REJECTED_LIMIT) : kind === "rate_limited" ? RATE_LIMITED : ERROR_BACKOFF
      return {
        ...state,
        reading: { ...state.reading, error: Option.some(message), isReading: false },
        rejections,
        nextAt: now + delay,
      }
    },
  })

const initialState = (provider: Pick<Reading, "id" | "name" | "dashboard">): ProviderState => ({
  reading: { ...provider, report: Option.none(), updated: Option.none(), error: Option.none(), isReading: false },
  rejections: 0,
  nextAt: 0,
  lastManual: Number.NEGATIVE_INFINITY,
})

// A service can report past 100% (overage); the meters read 0 to 100.
const clampReport = (report: UsageReport): UsageReport => ({
  ...report,
  windows: Array.map(report.windows, clampWindow),
  sections: Array.map(report.sections, (section) => ({ ...section, windows: Array.map(section.windows, clampWindow) })),
})

const clampWindow = (window: UsageWindow): UsageWindow => ({ ...window, used: Math.min(100, Math.max(0, window.used)) })

/** Where each agent keeps its sign-in, as the agent itself finds it. */
const UsageEnvConfig = Effect.gen(function* () {
  const home = yield* Config.String("HOME")
  const optional = (name: string) => Config.option(Config.String(name))
  return {
    home,
    claudeDir: Option.getOrElse(yield* optional("CLAUDE_CONFIG_DIR"), () => `${home}/.claude`),
    codexHome: Option.getOrElse(yield* optional("CODEX_HOME"), () => `${home}/.codex`),
    dataHome: Option.getOrElse(yield* optional("XDG_DATA_HOME"), () => `${home}/.local/share`),
    anthropicBaseUrl: yield* optional("ANTHROPIC_BASE_URL"),
    opencodeKey: yield* optional("OPENCODE_API_KEY"),
  } satisfies UsageEnv
})
