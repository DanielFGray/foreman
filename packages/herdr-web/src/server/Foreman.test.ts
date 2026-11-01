import { Option, Result, Schema as S } from "effect"
import { describe, expect, test } from "vitest"
import { ForemanCommand } from "../shared/Foreman.ts"
import { EMPTY_STATE, readingOf, withReading } from "./Foreman.ts"

const published = (fields: { daemon: boolean; observedAt: string | null }) =>
  JSON.stringify({
    version: 2,
    ...fields,
    policy: { paused: false, slots: 3, default: { author: false, climb: false, review: false, land: false }, grants: [] },
    policyError: null,
    projects: [{ name: "app", directory: "/src/app" }],
    rows: [{ view: "queue", key: "ts-1", label: "Write the export", detail: null, project: "app", actions: ["complete"] }],
  })

const reading = (fields: { daemon: boolean; observedAt: string | null }) => Result.getOrThrow(readingOf(published(fields)))

describe("readingOf", () => {
  test("reads foreman's published shape", () => {
    const read = reading({ daemon: true, observedAt: "2026-10-30T01:00:00.000Z" })
    expect(read.rows[0]?.project).toEqual(Option.some("app"))
    expect(read.rows[0]?.detail).toEqual(Option.none())
  })

  test("refuses a version it does not read, by name", () => {
    expect(readingOf(JSON.stringify({ version: 3 }))).toEqual(Result.fail("foreman publishes version 3; this page reads version 2"))
  })

  test("refuses text that is not JSON", () => {
    expect(readingOf("{")).toEqual(Result.fail("foreman's reading is not JSON"))
  })
})

describe("withReading", () => {
  const daemon = reading({ daemon: true, observedAt: "2026-10-30T01:00:00.000Z" })
  const oneShot = reading({ daemon: false, observedAt: "2026-10-30T01:00:30.000Z" })

  test("keeps the newer reading, and dates the daemon by its own even when that reading is older", () => {
    const state = withReading(withReading(EMPTY_STATE, oneShot), daemon)
    expect(state.reading).toEqual(Option.some(oneShot))
    expect(state.daemonAt).toEqual(Option.some(Date.parse("2026-10-30T01:00:00.000Z")))
  })

  test("a one-shot reading leaves the daemon's date alone", () => {
    expect(withReading(withReading(EMPTY_STATE, daemon), oneShot).daemonAt).toEqual(Option.some(Date.parse("2026-10-30T01:00:00.000Z")))
  })

  test("a reading clears the last problem", () => {
    expect(withReading({ ...EMPTY_STATE, problem: Option.some("unreadable") }, daemon).problem).toEqual(Option.none())
  })
})

test("a command refuses a name foreman would read as an option", () => {
  const decode = S.decodeUnknownResult(ForemanCommand)
  expect(Result.isFailure(decode({ _tag: "Act", action: "kill", key: "--all" }))).toBe(true)
  expect(Result.isSuccess(decode({ _tag: "Act", action: "kill", key: "ts-1a2b" }))).toBe(true)
})
