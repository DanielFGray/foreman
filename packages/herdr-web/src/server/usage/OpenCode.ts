// OpenCode Go's usage, read with a key from OpenCode's own auth file.
import { Array, Effect, Option, Schema as S } from "effect"
import type { UsageReport, UsageWindow } from "../../shared/Usage.ts"
import {
  decodeOptional,
  decodeReply,
  getReply,
  MONTH,
  parseTime,
  readOptionalFile,
  replyBody,
  ServiceError,
  SESSION,
  Time,
  type UsageEnv,
  UsageError,
  WEEK,
} from "./Read.ts"

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

/** None without a key, or for a workspace with no Go subscription. */
export const readOpencode = Effect.fn("readOpencode")(function* (env: UsageEnv) {
  // Any key of the workspace reads its Go usage; the CLI saves one per entry.
  const auth = yield* readOpencodeAuth(env)
  const key = Option.orElse(env.opencodeKey, () =>
    Option.flatMap(auth, (file) =>
      Option.orElse(
        Option.flatMap(file["opencode-go"], ({ key }) => key),
        () => Option.flatMap(file.opencode, ({ key }) => key),
      ),
    ),
  )
  if (Option.isNone(key)) return Option.none<UsageReport>()
  const { status, text } = yield* getReply(USAGE_URL, {
    Authorization: `Bearer ${key.value}`,
    Accept: "application/json",
    "User-Agent": "herdr-usage",
  })
  if (status === 403 && isUnentitled(text)) return Option.none<UsageReport>()
  const usage = yield* replyBody(status, text).pipe(Effect.flatMap((body) => decodeReply(OpencodeUsage, body)))
  return Option.some(yield* opencodeReport(usage, yield* Effect.clockWith((clock) => clock.currentTimeMillis)))
})

/** OpenCode's saved sign-ins: its own keys, and the ChatGPT login Codex can also use. */
export const readOpencodeAuth = (env: UsageEnv) =>
  Effect.map(readOptionalFile(`${env.dataHome}/opencode/auth.json`), decodeOptional(OpencodeAuth))

const Maybe = S.OptionFromOptionalNullOr

const OpencodeAuth = S.Struct({
  "opencode-go": Maybe(S.Struct({ key: Maybe(S.String) })),
  opencode: Maybe(S.Struct({ key: Maybe(S.String) })),
  openai: Maybe(S.Struct({ type: S.String, access: Maybe(S.String), accountId: Maybe(S.String) })),
})

// A valid key whose workspace has no Go subscription: nothing to show.
const isUnentitled = (text: string) =>
  Option.exists(S.decodeOption(S.fromJsonString(ServiceError))(text), ({ error }) =>
    Option.contains(error.type, "EntitlementError"),
  )

// The service names its fields differently from one version to the next; a
// meter's percent, or its used and limit, and its reset are each read from
// the first of these that it sends.
const PERCENT_KEYS = ["usagePercent", "usedPercent", "percentUsed", "percent", "usage_percent", "used_percent", "utilization", "utilizationPercent", "utilization_percent"] as const
const USED_KEYS = ["used", "usage", "consumed", "usedMicroCents"] as const
const LIMIT_KEYS = ["limit", "total", "quota", "limitMicroCents"] as const
const RESET_IN_KEYS = ["resetInSec", "resetInSeconds", "resetSeconds", "reset_sec", "reset_in_sec", "resetsInSec", "resetsInSeconds", "resetIn", "resetSec"] as const
const RESET_AT_KEYS = ["resetAt", "resetsAt", "reset_at", "resets_at", "nextReset", "next_reset", "renewAt", "renew_at"] as const

const Meter = S.Struct({
  usagePercent: Maybe(S.Finite),
  usedPercent: Maybe(S.Finite),
  percentUsed: Maybe(S.Finite),
  percent: Maybe(S.Finite),
  usage_percent: Maybe(S.Finite),
  used_percent: Maybe(S.Finite),
  utilization: Maybe(S.Finite),
  utilizationPercent: Maybe(S.Finite),
  utilization_percent: Maybe(S.Finite),
  used: Maybe(S.Finite),
  usage: Maybe(S.Finite),
  consumed: Maybe(S.Finite),
  usedMicroCents: Maybe(S.Finite),
  limit: Maybe(S.Finite),
  total: Maybe(S.Finite),
  quota: Maybe(S.Finite),
  limitMicroCents: Maybe(S.Finite),
  resetInSec: Maybe(S.Finite),
  resetInSeconds: Maybe(S.Finite),
  resetSeconds: Maybe(S.Finite),
  reset_sec: Maybe(S.Finite),
  reset_in_sec: Maybe(S.Finite),
  resetsInSec: Maybe(S.Finite),
  resetsInSeconds: Maybe(S.Finite),
  resetIn: Maybe(S.Finite),
  resetSec: Maybe(S.Finite),
  resetAt: Maybe(Time),
  resetsAt: Maybe(Time),
  reset_at: Maybe(Time),
  resets_at: Maybe(Time),
  nextReset: Maybe(Time),
  next_reset: Maybe(Time),
  renewAt: Maybe(Time),
  renew_at: Maybe(Time),
})
type Meter = typeof Meter.Type

export const OpencodeUsage = S.Struct({
  usage: S.Struct({ rolling: Maybe(Meter), weekly: Maybe(Meter), monthly: Maybe(Meter) }),
})
export type OpencodeUsage = typeof OpencodeUsage.Type

/** Fails when the reply has none of its three windows. */
export const opencodeReport = (usage: OpencodeUsage, now: number) => {
  const windows = Array.getSomes([
    meterWindow("Session", usage.usage.rolling, SESSION, now),
    meterWindow("Weekly", usage.usage.weekly, WEEK, now),
    meterWindow("Monthly", usage.usage.monthly, MONTH, now),
  ])
  return Array.isReadonlyArrayNonEmpty(windows)
    ? Effect.succeed<UsageReport>({ plan: Option.some("Go"), email: Option.none(), windows, sections: [] })
    : Effect.fail(new UsageError({ kind: "invalid", message: "no usage windows" }))
}

const meterWindow = (label: string, maybeMeter: Option.Option<Meter>, length: number, now: number): Option.Option<UsageWindow> =>
  Option.flatMap(maybeMeter, (meter) => {
    const first = <K extends keyof Meter>(keys: ReadonlyArray<K>) => Array.head(Array.getSomes(Array.map(keys, (key) => meter[key])))
    const fromAmounts = Option.flatMap(first(USED_KEYS), (spent) =>
      Option.map(
        Option.filter(first(LIMIT_KEYS), (limit) => limit > 0),
        (limit) => (spent / limit) * 100,
      ),
    )
    const resetsAt = Option.orElse(
      Option.map(
        Option.filter(first(RESET_IN_KEYS), (seconds) => seconds >= 0),
        (seconds) => now + seconds * 1000,
      ),
      () => Array.head(Array.getSomes(Array.map(RESET_AT_KEYS, (key) => Option.flatMap(meter[key], parseTime)))),
    )
    return Option.map(Option.orElse(first(PERCENT_KEYS), () => fromAmounts), (used) => ({
      label,
      used,
      resetsAt,
      length: Option.some(length),
    }))
  })
