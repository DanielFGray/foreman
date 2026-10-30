// Claude's plan usage, read with Claude Code's own sign-in.
import { Array, Effect, Match, Option, Schema } from "effect"
import type { UsageReport, UsageSection, UsageWindow } from "../../shared/Usage.ts"
import { decodeOptional, getJson, parseTime, readOptionalFile, SESSION, Time, titleCase, type UsageEnv, WEEK } from "./Read.ts"

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

/** None when Claude Code is not signed in with a Claude account. */
export const readClaude = Effect.fn("readClaude")(function* (env: UsageEnv) {
  const settings = decodeOptional(ClaudeSettings)(yield* readOptionalFile(`${env.claudeDir}/settings.json`))
  const credentials = decodeOptional(Credentials)(yield* readOptionalFile(`${env.claudeDir}/.credentials.json`))
  const maybeOauth = isAccountLogin(env, settings) ? Option.map(credentials, ({ claudeAiOauth }) => claudeAiOauth) : Option.none()
  if (Option.isNone(maybeOauth)) return Option.none<UsageReport>()
  const oauth = maybeOauth.value

  const accounts = yield* Effect.forEach([`${env.claudeDir}/.claude.json`, `${env.home}/.claude.json`], readOptionalFile)
  const email = Array.head(Array.getSomes(Array.map(accounts, (text) => Option.map(decodeOptional(Account)(text), ({ oauthAccount }) => oauthAccount.emailAddress))))
  const usage = yield* getJson(
    USAGE_URL,
    { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" },
    ClaudeUsage,
  )
  return Option.some(claudeReport(usage, { plan: claudePlan(oauth.subscriptionType, oauth.rateLimitTier), email }))
})

const Maybe = Schema.OptionFromOptionalNullOr

const ClaudeSettings = Schema.Struct({
  env: Maybe(Schema.Struct({ ANTHROPIC_BASE_URL: Maybe(Schema.String) })),
  apiKeyHelper: Maybe(Schema.String),
})

const Credentials = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    subscriptionType: Maybe(Schema.String),
    rateLimitTier: Maybe(Schema.String),
  }),
})

const Account = Schema.Struct({ oauthAccount: Schema.Struct({ emailAddress: Schema.String }) })

const Money = Schema.Struct({ amount_minor: Schema.Finite, currency: Maybe(Schema.String), exponent: Maybe(Schema.Finite) })

const ClaudeWindow = Schema.Struct({ utilization: Maybe(Schema.Finite), resets_at: Maybe(Time) })

const Limit = Schema.Struct({
  kind: Schema.String,
  percent: Maybe(Schema.Finite),
  resets_at: Maybe(Time),
  scope: Maybe(Schema.Struct({ model: Maybe(Schema.Struct({ display_name: Maybe(Schema.String) })) })),
})

const Spend = Schema.Struct({ enabled: Schema.Boolean, used: Maybe(Money), limit: Maybe(Money) })

export const ClaudeUsage = Schema.Struct({
  limits: Maybe(Schema.Array(Limit)),
  five_hour: Maybe(ClaudeWindow),
  seven_day: Maybe(ClaudeWindow),
  seven_day_breakdown: Maybe(
    Schema.Struct({ rows: Schema.Array(Schema.Struct({ display_name: Maybe(Schema.String), percent: Maybe(Schema.Finite) })) }),
  ),
  spend: Maybe(Spend),
})
export type ClaudeUsage = typeof ClaudeUsage.Type

/**
 * The windows from `limits`, which name each model's own weekly limit; a
 * reply without them falls back to the older five-hour and seven-day fields.
 */
export const claudeReport = (
  usage: ClaudeUsage,
  account: Readonly<{ plan: Option.Option<string>; email: Option.Option<string> }>,
): UsageReport => {
  const fromLimits = Array.getSomes(Array.map(Option.getOrElse(usage.limits, () => []), limitWindow))
  const windows = Array.isReadonlyArrayNonEmpty(fromLimits)
    ? fromLimits
    : Array.getSomes([legacyWindow("Session", usage.five_hour, SESSION), legacyWindow("Weekly", usage.seven_day, WEEK)])
  const shares = Array.getSomes(
    Array.map(Option.match(usage.seven_day_breakdown, { onNone: () => [], onSome: ({ rows }) => rows }), (row) =>
      Option.filter(
        Option.zipWith(row.display_name, row.percent, (name, percent): readonly [string, string] => [name, `${Math.round(percent)}%`]),
        () => Option.exists(row.percent, (percent) => percent > 0),
      ),
    ),
  )
  const sections: ReadonlyArray<UsageSection> = [
    ...(Array.isReadonlyArrayNonEmpty(shares) ? [{ title: "This week by surface", facts: shares, windows: [] }] : []),
    ...Option.toArray(Option.map(usage.spend, (spend) => ({ title: "Extra usage", facts: [spendFact(spend)], windows: [] }))),
  ]
  return { plan: account.plan, email: account.email, windows, sections }
}

// A Claude Code pointed at another endpoint, or signing in through a key
// helper, is not using its account login; a token left behind may be dead.
const isAccountLogin = (env: UsageEnv, settings: Option.Option<typeof ClaudeSettings.Type>) => {
  const baseUrl = Option.orElse(env.anthropicBaseUrl, () =>
    Option.flatMap(settings, (file) => Option.flatMap(file.env, (vars) => vars.ANTHROPIC_BASE_URL)),
  )
  return (
    !Option.exists(baseUrl, (url) => !/^https:\/\/api\.anthropic\.com(\/|$)/.test(url.trim())) &&
    !Option.exists(settings, (file) => Option.isSome(file.apiKeyHelper))
  )
}

const limitWindow = (limit: typeof Limit.Type): Option.Option<UsageWindow> =>
  Option.zipWith(limitLabel(limit), limit.percent, (label, used) => ({
    label,
    used,
    resetsAt: Option.flatMap(limit.resets_at, parseTime),
    length: Option.some(limit.kind === "session" ? SESSION : WEEK),
  }))

const limitLabel = (limit: typeof Limit.Type) =>
  Match.value(limit.kind).pipe(
    Match.when("session", () => Option.some("Session")),
    Match.when("weekly_all", () => Option.some("Weekly")),
    Match.when("weekly_scoped", () =>
      Option.filter(
        Option.map(
          Option.flatMap(limit.scope, ({ model }) => Option.flatMap(model, ({ display_name }) => display_name)),
          (name) => name.trim(),
        ),
        (name) => name.length > 0,
      ),
    ),
    Match.orElse(() => Option.none<string>()),
  )

const legacyWindow = (label: string, window: Option.Option<typeof ClaudeWindow.Type>, length: number) =>
  Option.flatMap(window, ({ utilization, resets_at }) =>
    Option.map(utilization, (used) => ({ label, used, resetsAt: Option.flatMap(resets_at, parseTime), length: Option.some(length) })),
  )

const spendFact = ({ enabled, used, limit }: typeof Spend.Type): readonly [string, string] =>
  enabled
    ? [
        "This month",
        Option.match(used, {
          onNone: () => "On",
          onSome: (spent) => Option.match(limit, { onNone: () => money(spent), onSome: (cap) => `${money(spent)} of ${money(cap)}` }),
        }),
      ]
    : ["Status", "Off"]

/** `Pro`, or `Max 20x` from a rate-limit tier such as `default_claude_max_20x`. */
const claudePlan = (subscription: Option.Option<string>, tier: Option.Option<string>) =>
  Option.map(subscription, (kind) =>
    Option.match(
      Option.flatMap(tier, (text) => Option.fromNullishOr(/_(\d+x)$/.exec(text)?.[1])),
      { onNone: () => titleCase(kind), onSome: (multiple) => `${titleCase(kind)} ${multiple}` },
    ),
  )

const money = ({ amount_minor, currency, exponent }: typeof Money.Type) => {
  const places = Math.min(Option.getOrElse(exponent, () => 0), 6)
  const whole = Math.abs(amount_minor)
  const scale = 10 ** places
  const value = places > 0 ? `${Math.floor(whole / scale)}.${String(whole % scale).padStart(places, "0")}` : `${whole}`
  return `${amount_minor < 0 ? "-" : ""}${value} ${Option.getOrElse(currency, () => "").trim()}`.trim()
}
