import { Option } from "effect"
import { click, Command, expect, expectAll, all, given, inside, role, scene, selector } from "foldkit/scene"
import { describe, expect as expectValue, test } from "vitest"
import type { Reading } from "../shared/Usage.ts"
import { RefreshUsage } from "./commands.ts"
import { init, update, view } from "./main.ts"
import { Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { countdown, describePace, pace, tightest } from "./usage.ts"

const NOW = Date.parse("2026-10-30T01:00:00Z")
const HOUR = 3600e3

const reading = (id: Reading["id"], name: string, report: Reading["report"]): Reading => ({
  id,
  name,
  dashboard: `https://example.com/${id}`,
  report,
  updated: Option.some(NOW - 5 * 60e3),
  error: Option.none(),
  isReading: false,
})

const claude = reading(
  "claude",
  "Claude",
  Option.some({
    plan: Option.some("Pro"),
    email: Option.none(),
    windows: [
      { label: "Session", used: 85, resetsAt: Option.some(NOW + HOUR), length: Option.some(5 * HOUR) },
      { label: "Weekly", used: 9, resetsAt: Option.some(NOW + 100 * HOUR), length: Option.some(168 * HOUR) },
    ],
    sections: [{ title: "Extra usage", facts: [["Status", "Off"]], windows: [] }],
  }),
)
const signedOut = reading("opencode", "OpenCode", Option.none())

const withUsage = {
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, chatRuns: [] }).model,
  usage: Option.some({ readings: [claude, { ...signedOut, updated: Option.none() }] }),
  now: NOW,
}

test("the bar shows a meter per signed-in plan, and a tap opens its every window", () => {
  scene(
    { update, view },
    given(withUsage),
    expectAll(all.selector(".usage-segment")).toHaveCount(1),
    expect(role("button", { name: "Claude usage, Session 85% used" })).toHaveAttr("aria-expanded", "false"),
    expect(selector(".usage-meter")).toHaveClass("critical"),
    click(role("button", { name: "Claude usage, Session 85% used" })),
    inside(
      role("region", { name: "Claude usage" }),
      expect(selector(".usage-window")).toContainText("Session 15% left"),
      expect(selector(".usage-window")).toContainText("Resets in 1h 0m"),
      expect(selector(".usage-section")).toContainText("Extra usage"),
      expect(selector(".usage-updated")).toContainText("Read 5m ago"),
    ),
    click(role("button", { name: "refresh" })),
    Command.expectExact(RefreshUsage({ provider: Option.some("claude") })),
    Command.resolve(RefreshUsage, Message.CompletedRefreshUsage()),
  )
})

test("no bar before any plan has numbers", () => {
  scene(
    { update, view },
    given({ ...withUsage, usage: Option.some({ readings: [signedOut] }) }),
    expect(selector(".usage")).not.toExist(),
  )
})

describe("the usage numbers", () => {
  const window = { label: "Session", used: 50, resetsAt: Option.some(NOW + 2 * HOUR), length: Option.some(5 * HOUR) }

  test("countdown keeps the two coarsest units", () => {
    expectValue([countdown(47 * 60e3), countdown(173 * 60e3), countdown((4 * 24 + 11) * HOUR)]).toEqual(["47m", "2h 53m", "4d 11h"])
  })

  test("tightest picks the most used window, the last of equal ones", () => {
    const weekly = { ...window, label: "Weekly" }
    expectValue(tightest([window, weekly])).toEqual(Option.some(weekly))
    expectValue(tightest([])).toEqual(Option.none())
  })

  test("pace compares the use with an even spend, and says when it runs out", () => {
    // 3 of 5 hours gone and half used: 10% in reserve, and the rest lasts.
    const even = pace(window, NOW)
    expectValue(Option.map(even, (p) => describePace(p, window.used))).toEqual(Option.some("10% in reserve · Lasts until reset"))
    // 3 hours gone and 90% used: out in 20 minutes, before the reset.
    const fast = pace({ ...window, used: 90 }, NOW)
    expectValue(Option.map(fast, (p) => describePace(p, 90))).toEqual(Option.some("30% in deficit · Runs out in 20m"))
    expectValue(pace({ ...window, length: Option.none() }, NOW)).toEqual(Option.none())
  })
})
