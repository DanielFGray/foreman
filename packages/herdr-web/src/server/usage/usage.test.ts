import { Effect, Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { UsageReport } from "../../shared/Usage.ts"
import { ClaudeUsage, claudeReport } from "./Claude.ts"
import { CodexUsage, codexReport } from "./Codex.ts"
import { CursorUsage, cursorReport, jwtUser } from "./Cursor.ts"
import { OpencodeUsage, opencodeReport } from "./OpenCode.ts"
import { parseTime, replyBody, SESSION, UsageError, WEEK } from "./Read.ts"
import { afterRead, type ProviderState, REFRESH, REJECTED_LIMIT } from "./Usage.ts"

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, json: string): S["Type"] =>
  Schema.decodeSync(Schema.fromJsonString(schema))(json)

const NOW = Date.parse("2026-10-30T01:00:00Z")

describe("parseTime", () => {
  test("reads epoch seconds, milliseconds, and ISO dates with or without a zone", () => {
    expect(parseTime(1793343265)).toEqual(Option.some(1793343265000))
    expect(parseTime(1793343265000)).toEqual(Option.some(1793343265000))
    expect(parseTime("1793343265")).toEqual(Option.some(1793343265000))
    expect(parseTime("2026-10-30T02:00:00.408835+00:00")).toEqual(Option.some(Date.parse("2026-10-30T02:00:00.408Z")))
    expect(parseTime("2026-10-30 02:00:00")).toEqual(Option.some(Date.parse("2026-10-30T02:00:00Z")))
    expect(parseTime("soon")).toEqual(Option.none())
    expect(parseTime(0)).toEqual(Option.none())
  })
})

describe("replyBody", () => {
  const kindOf = (status: number, text: string) =>
    Effect.runSync(replyBody(status, text).pipe(Effect.as("ok"), Effect.catchTag("UsageError", ({ kind, message }) => Effect.succeed(`${kind}: ${message}`))))

  test("sorts a reply by its status, keeping a refusal's own message", () => {
    expect(kindOf(200, "{}")).toBe("ok")
    expect(kindOf(401, '{"error":{"type":"authentication_error","message":"This API key has expired."}}')).toBe("rejected: This API key has expired.")
    expect(kindOf(403, "Forbidden")).toBe("rejected: sign-in rejected (403)")
    expect(kindOf(429, "")).toBe("rate_limited: rate limited")
    expect(kindOf(502, "")).toBe("http: HTTP 502")
  })
})

describe("claudeReport", () => {
  const usage = decode(
    ClaudeUsage,
    JSON.stringify({
      five_hour: { utilization: 22, resets_at: "2026-10-30T02:00:00+00:00" },
      limits: [
        { kind: "session", percent: 22, resets_at: "2026-10-30T02:00:00+00:00", scope: null },
        { kind: "weekly_all", percent: 9, resets_at: "2026-11-05T16:00:00+00:00", scope: null },
        { kind: "weekly_scoped", percent: 0, resets_at: "2026-11-05T16:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
        { kind: "unknown_kind", percent: 50 },
      ],
      seven_day_breakdown: { rows: [{ display_name: "Claude Code", percent: 100 }, { display_name: "Chats", percent: 0 }] },
      spend: { used: { amount_minor: 1250, currency: "USD", exponent: 2 }, limit: { amount_minor: 5000, currency: "USD", exponent: 2 }, enabled: true },
    }),
  )

  test("names each limit, a model's own by its model, and skips kinds it does not know", () => {
    const report = claudeReport(usage, { plan: Option.some("Pro"), email: Option.none() })
    expect(report.windows).toEqual([
      { label: "Session", used: 22, resetsAt: Option.some(Date.parse("2026-10-30T02:00:00Z")), length: Option.some(SESSION) },
      { label: "Weekly", used: 9, resetsAt: Option.some(Date.parse("2026-11-05T16:00:00Z")), length: Option.some(WEEK) },
      { label: "Fable", used: 0, resetsAt: Option.some(Date.parse("2026-11-05T16:00:00Z")), length: Option.some(WEEK) },
    ])
    expect(report.sections).toEqual([
      { title: "This week by surface", facts: [["Claude Code", "100%"]], windows: [] },
      { title: "Extra usage", facts: [["This month", "12.50 USD of 50.00 USD"]], windows: [] },
    ])
  })

  test("falls back to the five-hour and seven-day fields without limits", () => {
    const old = decode(ClaudeUsage, JSON.stringify({ five_hour: { utilization: 40, resets_at: null }, seven_day: { utilization: 70 } }))
    expect(claudeReport(old, { plan: Option.none(), email: Option.none() }).windows.map(({ label, used }) => [label, used])).toEqual([
      ["Session", 40],
      ["Weekly", 70],
    ])
  })
})

describe("codexReport", () => {
  test("labels a window by its length, and resets it by reset_at or else the seconds left", () => {
    const usage = decode(
      CodexUsage,
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1793798375 },
          secondary_window: { used_percent: 3, limit_window_seconds: 18000, reset_after_seconds: 600 },
        },
        rate_limit_reset_credits: { available_count: 1 },
        credits: { unlimited: false, balance: "0" },
      }),
    )
    const report = codexReport(usage, NOW)
    expect(report.plan).toEqual(Option.some("Plus"))
    expect(report.windows).toEqual([
      { label: "Weekly", used: 10, resetsAt: Option.some(1793798375000), length: Option.some(WEEK) },
      { label: "Session", used: 3, resetsAt: Option.some(NOW + 600e3), length: Option.some(SESSION) },
    ])
    expect(report.sections.map(({ title, facts }) => [title, facts])).toEqual([
      ["Limit reset credits", [["Available", "1"]]],
      ["Credits", [["Balance", "0"]]],
    ])
  })
})

describe("opencodeReport", () => {
  test("reads a meter's percent, or its used and limit, and its reset in seconds", () => {
    const usage = decode(
      OpencodeUsage,
      JSON.stringify({ usage: { rolling: { usagePercent: 12, resetInSec: 60 }, weekly: { used: 25, limit: 100, resetAt: "2026-11-01T00:00:00Z" } } }),
    )
    const report = Effect.runSync(opencodeReport(usage, NOW))
    expect(report.windows.map(({ label, used, resetsAt }) => [label, used, resetsAt])).toEqual([
      ["Session", 12, Option.some(NOW + 60e3)],
      ["Weekly", 25, Option.some(Date.parse("2026-11-01T00:00:00Z"))],
    ])
  })

  test("fails when the reply has no window", () => {
    const usage = decode(OpencodeUsage, JSON.stringify({ usage: {} }))
    expect(Effect.runSync(Effect.flip(opencodeReport(usage, NOW)))).toMatchObject({ kind: "invalid" })
  })
})

describe("cursorReport", () => {
  test("shows the plan's total, its Auto and API parts, and the included spend", () => {
    const usage = decode(
      CursorUsage,
      JSON.stringify({
        billingCycleStart: "2026-10-12T21:38:45.000Z",
        billingCycleEnd: "2026-11-12T21:38:45.000Z",
        membershipType: "pro_plus",
        individualUsage: {
          plan: { used: 7000, limit: 7000, autoPercentUsed: 29.8, apiPercentUsed: 0, totalPercentUsed: 28.5 },
          onDemand: { used: 0, limit: null },
        },
        teamUsage: {},
      }),
    )
    const report = cursorReport(usage, Option.none())
    expect(report.plan).toEqual(Option.some("Cursor Pro+"))
    expect(report.windows.map(({ label, used }) => [label, used])).toEqual([
      ["Monthly", 28.5],
      ["Auto + Composer", 29.8],
      ["API", 0],
    ])
    expect(report.windows[0]?.length).toEqual(Option.some(31 * 86400e3))
    expect(report.sections).toEqual([{ title: "Included usage", facts: [["This cycle", "$70.00 of $70.00"]], windows: [] }])
  })

  test("reads the user from the token's subject", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "auth0|user_123" })).toString("base64url")
    expect(jwtUser(`header.${payload}.signature`)).toEqual(Option.some("user_123"))
    expect(jwtUser("not-a-token")).toEqual(Option.none())
  })
})

describe("afterRead", () => {
  const report: UsageReport = {
    plan: Option.none(),
    email: Option.none(),
    windows: [{ label: "Session", used: 140, resetsAt: Option.none(), length: Option.none() }],
    sections: [],
  }
  const start: ProviderState = {
    reading: { id: "claude", name: "Claude", dashboard: "", report: Option.none(), updated: Option.none(), error: Option.none(), isReading: true },
    rejections: 0,
    nextAt: 0,
    lastManual: 0,
  }
  const fail = (kind: UsageError["kind"]) => Result.fail(new UsageError({ kind, message: kind }))

  test("a good read clamps the numbers and reads again after the refresh", () => {
    const state = afterRead(start, Result.succeed(Option.some(report)), NOW)
    expect(Option.map(state.reading.report, ({ windows }) => windows[0]?.used)).toEqual(Option.some(100))
    expect(state.reading.updated).toEqual(Option.some(NOW))
    expect(state.nextAt).toBe(NOW + REFRESH)
  })

  test("a failure keeps the last numbers and says why", () => {
    const good = afterRead(start, Result.succeed(Option.some(report)), NOW)
    const state = afterRead(good, fail("http"), NOW)
    expect(state.reading.report).toEqual(good.reading.report)
    expect(state.reading.error).toEqual(Option.some("http"))
    expect(state.nextAt).toBe(NOW + 5 * 60e3)
  })

  test("each rejection in a row doubles the wait, up to its limit", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7].reduce<{ state: ProviderState; waits: Array<number> }>(
      ({ state, waits }) => {
        const next = afterRead(state, fail("rejected"), NOW)
        return { state: next, waits: [...waits, next.nextAt - NOW] }
      },
      { state: start, waits: [] },
    ).waits
    expect(waits).toEqual([REFRESH, 2 * REFRESH, 4 * REFRESH, 8 * REFRESH, 16 * REFRESH, 32 * REFRESH, REJECTED_LIMIT])
  })

  test("signed out drops the numbers", () => {
    const good = afterRead(start, Result.succeed(Option.some(report)), NOW)
    expect(afterRead(good, Result.succeed(Option.none()), NOW).reading).toMatchObject({ report: Option.none(), updated: Option.none() })
  })
})
