// Cursor's plan usage. Cursor keeps its access token in a local SQLite state
// database; the dashboard API takes it as the WorkOS session cookie
// `<user id>::<token>`.
import { Array, Effect, FileSystem, Option, Schema as S, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { UsageReport, UsageSection, UsageWindow } from "../../shared/Usage.ts"
import { getJson, MONTH, parseTime, Time, type UsageEnv, UsageError } from "./Read.ts"

const USAGE_URL = "https://cursor.com/api/usage-summary"

const STATE_DBS = ["/.config/Cursor/User/globalStorage/state.vscdb", "/Library/Application Support/Cursor/User/globalStorage/state.vscdb"]

/** None when Cursor is not installed or not signed in. */
export const readCursor = Effect.fn("readCursor")(function* (env: UsageEnv) {
  const fs = yield* FileSystem.FileSystem
  const found = yield* Effect.filter(Array.map(STATE_DBS, (db) => `${env.home}${db}`), (path) =>
    fs.exists(path).pipe(Effect.orElseSucceed(() => false)),
  )
  const maybeDb = Array.head(found)
  if (Option.isNone(maybeDb)) return Option.none<UsageReport>()
  const token = yield* stateValue(maybeDb.value, "cursorAuth/accessToken")
  const login = Option.flatMap(token, (jwt) => Option.map(jwtUser(jwt), (user) => ({ user, jwt })))
  if (Option.isNone(login)) return Option.none<UsageReport>()
  const { user, jwt } = login.value
  const usage = yield* getJson(
    USAGE_URL,
    { Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${user}::${jwt}`)}`, Accept: "application/json" },
    CursorUsage,
  )
  const email = yield* stateValue(maybeDb.value, "cursorAuth/cachedEmail")
  return Option.some(cursorReport(usage, email))
})

const Maybe = S.OptionFromOptionalNullOr

const Amounts = S.Struct({ used: Maybe(S.Finite), limit: Maybe(S.Finite) })
type Amounts = typeof Amounts.Type

export const CursorUsage = S.Struct({
  billingCycleStart: Maybe(Time),
  billingCycleEnd: Maybe(Time),
  membershipType: Maybe(S.String),
  individualUsage: Maybe(
    S.Struct({
      plan: Maybe(
        S.Struct({
          ...Amounts.fields,
          autoPercentUsed: Maybe(S.Finite),
          apiPercentUsed: Maybe(S.Finite),
          totalPercentUsed: Maybe(S.Finite),
        }),
      ),
      overall: Maybe(Amounts),
      onDemand: Maybe(Amounts),
    }),
  ),
  teamUsage: Maybe(S.Struct({ pooled: Maybe(Amounts), onDemand: Maybe(Amounts) })),
})
export type CursorUsage = typeof CursorUsage.Type

/**
 * One monthly window for the whole plan, and one each for Auto and the API
 * when the reply splits them. Amounts arrive in cents.
 */
export const cursorReport = (usage: CursorUsage, email: Option.Option<string>): UsageReport => {
  const end = Option.flatMap(usage.billingCycleEnd, parseTime)
  const start = Option.flatMap(usage.billingCycleStart, parseTime)
  const length = Option.orElse(
    Option.filter(Option.zipWith(start, end, (from, to) => to - from), (ms) => ms > 0),
    () => Option.some(MONTH),
  )
  const individual = usage.individualUsage
  const plan = Option.flatMap(individual, ({ plan }) => plan)
  const overall = Option.flatMap(individual, ({ overall }) => overall)
  const pooled = Option.flatMap(usage.teamUsage, ({ pooled }) => pooled)
  const auto = Option.flatMap(plan, ({ autoPercentUsed }) => autoPercentUsed)
  const api = Option.flatMap(plan, ({ apiPercentUsed }) => apiPercentUsed)
  const headline = Array.head(
    Array.getSomes([
      Option.flatMap(plan, ({ totalPercentUsed }) => totalPercentUsed),
      Option.zipWith(auto, api, (a, b) => (a + b) / 2),
      api,
      auto,
      Option.flatMap(plan, ratio),
      Option.flatMap(overall, ratio),
      Option.flatMap(pooled, ratio),
    ]),
  )
  const window = (label: string, used: number): UsageWindow => ({ label, used, resetsAt: end, length })
  const windows = [
    window("Monthly", Option.getOrElse(headline, () => 0)),
    ...Option.toArray(Option.map(auto, (used) => window("Auto + Composer", used))),
    ...Option.toArray(Option.map(api, (used) => window("API", used))),
  ]
  const included = Array.findFirst(Array.getSomes([plan, overall, pooled]), ({ used, limit }) =>
    Option.exists(used, (cents) => cents > 0) || Option.exists(limit, (cents) => cents > 0),
  )
  const sections: ReadonlyArray<UsageSection> = [
    ...Option.toArray(
      Option.map(included, ({ used, limit }) => ({
        title: "Included usage",
        facts: [["This cycle", `${dollars(used)} of ${dollars(limit)}`] as const],
        windows: [],
      })),
    ),
    ...Option.toArray(onDemandSection(Option.flatMap(individual, ({ onDemand }) => onDemand), Option.flatMap(usage.teamUsage, ({ onDemand }) => onDemand))),
  ]
  return {
    email,
    plan: Option.map(usage.membershipType, (kind) => `Cursor ${MEMBERSHIPS[kind.toLowerCase()] ?? kind}`),
    windows,
    sections,
  }
}

// A personal cap wins; a team with no member cap shares one budget.
const onDemandSection = (personal: Option.Option<Amounts>, team: Option.Option<Amounts>): Option.Option<UsageSection> => {
  const personalUsed = cents(Option.flatMap(personal, ({ used }) => used))
  const personalCap = Option.filter(Option.flatMap(personal, ({ limit }) => limit), (limit) => limit > 0)
  const teamCap = Option.filter(Option.flatMap(team, ({ limit }) => limit), (limit) => limit > 0)
  const facts = (spent: number, cap: number): Array<readonly [string, string]> => [
    ["Spent this cycle", `$${spent.toFixed(2)}`],
    ["Left", `$${Math.max(cap - spent, 0).toFixed(2)} of $${cap.toFixed(2)}`],
  ]
  return Option.isSome(personalCap)
    ? Option.some({ title: "On-demand", facts: facts(personalUsed, personalCap.value / 100), windows: [] })
    : Option.isSome(teamCap)
      ? Option.some({
          title: "Team on-demand",
          facts: [
            ...facts(cents(Option.flatMap(team, ({ used }) => used)), teamCap.value / 100),
            ...(personalUsed > 0 ? [["Your share", `$${personalUsed.toFixed(2)}`] as const] : []),
          ],
          windows: [],
        })
      : personalUsed > 0
        ? Option.some({ title: "On-demand", facts: [["Spent this cycle", `$${personalUsed.toFixed(2)}`] as const], windows: [] })
        : Option.none()
}

const ratio = ({ used, limit }: Amounts) =>
  Option.map(
    Option.filter(limit, (cap) => cap > 0),
    (cap) => (Option.getOrElse(used, () => 0) / cap) * 100,
  )

const cents = (amount: Option.Option<number>) => Option.getOrElse(amount, () => 0) / 100
const dollars = (amount: Option.Option<number>) => `$${cents(amount).toFixed(2)}`

const MEMBERSHIPS: Readonly<Record<string, string>> = {
  enterprise: "Enterprise",
  express: "Start",
  free: "Free",
  free_trial: "Pro Trial",
  hobby: "Hobby",
  pro: "Pro",
  pro_student: "Pro",
  pro_plus: "Pro+",
  team: "Team",
  ultra: "Ultra",
}

/** The user id in the token's subject, `<provider>|<user>`. */
export const jwtUser = (jwt: string) =>
  Option.flatMap(Array.get(jwt.split("."), 1), (payload) =>
    Option.flatMap(
      Option.flatMap(S.decodeOption(S.StringFromBase64Url)(payload), S.decodeOption(S.fromJsonString(JwtClaims))),
      ({ sub }) => Option.filter(Array.last(sub.split("|")), (user) => user.length > 0),
    ),
  )

const JwtClaims = S.Struct({ sub: S.String })

/** A value from Cursor's state database; none when the key is not set. */
const stateValue = (db: string, key: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make("sqlite3", ["-readonly", db, `select value from ItemTable where key='${key}'`]))
      const [stdout, stderr, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
        { concurrency: "unbounded" },
      )
      // A locked or unreadable database is a failed read, not a signed-out Cursor.
      return code === 0
        ? Option.filter(Option.some(stdout.trim()), (value) => value.length > 0)
        : yield* new UsageError({ kind: "invalid", message: `sqlite3 cannot read Cursor's state: ${stderr.trim()}` })
    }),
  ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new UsageError({ kind: "invalid", message: `sqlite3 did not run: ${error.message}` }))))
