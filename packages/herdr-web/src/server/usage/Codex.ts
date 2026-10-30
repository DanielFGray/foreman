// Codex's plan usage, read with the ChatGPT login of Codex, or else OpenCode's.
import { Array, Effect, Option, Schema } from "effect"
import type { UsageReport, UsageSection, UsageWindow } from "../../shared/Usage.ts"
import { readOpencodeAuth } from "./OpenCode.ts"
import { decodeOptional, getJson, parseTime, readOptionalFile, SESSION, Time, titleCase, type UsageEnv, WEEK } from "./Read.ts"

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

/** None when neither Codex nor OpenCode holds a ChatGPT login. */
export const readCodex = Effect.fn("readCodex")(function* (env: UsageEnv) {
  const codex = Option.flatMap(decodeOptional(CodexAuth)(yield* readOptionalFile(`${env.codexHome}/auth.json`)), ({ tokens }) =>
    Option.flatMap(tokens, ({ access_token, account_id }) => Option.map(access_token, (token) => ({ token, account: account_id }))),
  )
  // OpenCode renews and saves this token itself, so it is read on every poll.
  const login = Option.isSome(codex)
    ? codex
    : Option.flatMap(yield* readOpencodeAuth(env), ({ openai }) =>
        Option.flatMap(
          Option.filter(openai, ({ type }) => type === "oauth"),
          ({ access, accountId }) => Option.map(access, (token) => ({ token, account: accountId })),
        ),
      )
  if (Option.isNone(login)) return Option.none<UsageReport>()
  const usage = yield* getJson(
    USAGE_URL,
    {
      Authorization: `Bearer ${login.value.token}`,
      "User-Agent": "codex_cli_rs/0.1",
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
      ...Option.match(login.value.account, { onNone: () => ({}), onSome: (account) => ({ "ChatGPT-Account-Id": account }) }),
    },
    CodexUsage,
  )
  return Option.some(codexReport(usage, yield* Effect.clockWith((clock) => clock.currentTimeMillis)))
})

const Maybe = Schema.OptionFromOptionalNullOr

// An API-key login has no tokens.
const CodexAuth = Schema.Struct({
  tokens: Maybe(Schema.Struct({ access_token: Maybe(Schema.String), account_id: Maybe(Schema.String) })),
})

const CodexWindow = Schema.Struct({
  used_percent: Maybe(Schema.Finite),
  limit_window_seconds: Maybe(Schema.Finite),
  reset_at: Maybe(Time),
  reset_after_seconds: Maybe(Schema.Finite),
})

const RateLimit = Schema.Struct({ primary_window: Maybe(CodexWindow), secondary_window: Maybe(CodexWindow) })

export const CodexUsage = Schema.Struct({
  email: Maybe(Schema.String),
  plan_type: Maybe(Schema.String),
  rate_limit: Maybe(RateLimit),
  code_review_rate_limit: Maybe(RateLimit),
  rate_limit_reset_credits: Maybe(Schema.Struct({ available_count: Schema.Finite })),
  credits: Maybe(Schema.Struct({ unlimited: Maybe(Schema.Boolean), balance: Maybe(Schema.Union([Schema.String, Schema.Finite])) })),
})
export type CodexUsage = typeof CodexUsage.Type

export const codexReport = (usage: CodexUsage, now: number): UsageReport => {
  const review = Array.head(codexWindows(usage.code_review_rate_limit, now))
  const sections: ReadonlyArray<UsageSection> = [
    ...Option.toArray(Option.map(review, (window) => ({ title: "Code review", facts: [], windows: [{ ...window, label: "Code review" }] }))),
    ...Option.toArray(
      Option.map(usage.rate_limit_reset_credits, ({ available_count }) => ({
        title: "Limit reset credits",
        facts: [["Available", String(available_count)] as const],
        windows: [],
      })),
    ),
    ...Option.toArray(
      Option.map(usage.credits, ({ unlimited, balance }) => ({
        title: "Credits",
        facts: [["Balance", Option.getOrElse(unlimited, () => false) ? "Unlimited" : String(Option.getOrElse(balance, () => "0"))] as const],
        windows: [],
      })),
    ),
  ]
  return {
    email: Option.filter(Option.map(usage.email, (email) => email.trim()), (email) => email.length > 0),
    plan: Option.map(usage.plan_type, titleCase),
    windows: codexWindows(usage.rate_limit, now),
    sections,
  }
}

// A window is known by its length; the slot it arrives in decides only when
// the length is missing or unfamiliar.
const codexWindows = (limits: Option.Option<typeof RateLimit.Type>, now: number): Array<UsageWindow> =>
  Option.match(limits, {
    onNone: () => [],
    onSome: ({ primary_window, secondary_window }) =>
      Array.getSomes([codexWindow("Session", primary_window, now), codexWindow("Weekly", secondary_window, now)]),
  })

const codexWindow = (slot: string, window: Option.Option<typeof CodexWindow.Type>, now: number) =>
  Option.flatMap(window, ({ used_percent, limit_window_seconds, reset_at, reset_after_seconds }) =>
    Option.map(used_percent, (used) => {
      const length = Option.map(limit_window_seconds, (seconds) => seconds * 1000)
      const isNear = (target: number) => Option.exists(length, (ms) => Math.abs(ms - target) <= 60e3)
      return {
        label: isNear(SESSION) ? "Session" : isNear(WEEK) ? "Weekly" : slot,
        used,
        resetsAt: Option.orElse(Option.flatMap(reset_at, parseTime), () =>
          Option.map(reset_after_seconds, (seconds) => now + seconds * 1000),
        ),
        length,
      }
    }),
  )
