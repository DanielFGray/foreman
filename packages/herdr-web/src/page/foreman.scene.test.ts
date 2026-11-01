import { Option } from "effect"
import { all, click, Command, expect, expectAll, given, role, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import type { ForemanReading, ForemanRow, ForemanState } from "../shared/Foreman.ts"
import { ListRungs, RefreshForeman, RunForeman, SaveSelection } from "./commands.ts"
import { init, update, view } from "./main.ts"
import { Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"

const NOW = Date.parse("2026-10-30T01:00:00Z")

const row = (view: ForemanRow["view"], key: string, label: string, actions: ReadonlyArray<string>, project = "app"): ForemanRow => ({
  view,
  key,
  label,
  detail: Option.none(),
  project: Option.some(project),
  parent: Option.none(),
  epic: false,
  actions,
})

const reading: ForemanReading = {
  daemon: false,
  policy: { paused: false, slots: 2, default: { author: false, climb: false, review: true, land: false }, grants: [{ scope: "ep-1", steps: ["author"], remaining: 3, admitted: ["ts-q1"] }] },
  policyError: Option.none(),
  observedAt: Option.some(new Date(NOW - 30e3).toISOString()),
  projects: [{ name: "app", directory: "/src/app" }, { name: "lib", directory: "/src/lib" }],
  rows: [
    row("working", "ts-w1", "Add the login form", ["focus", "kill", "intervene", "release"]),
    row("review", "ts-r1", "Fix the date parser", ["focus"]),
    row("queue", "ts-q1", "Write the export", ["complete", "intervene", "descend"]),
    row("queue", "ts-q2", "Speed up the build", ["complete"], "lib"),
  ],
}

// The daemon last wrote ten minutes ago; the reading shown is the bridge's own, newer one.
const state: ForemanState = { reading: Option.some(reading), daemonAt: Option.some(NOW - 600e3), problem: Option.none(), isReading: false }

const start = init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [] }).model

const open = { ...start, selection: Selection.Foreman(), foreman: Option.some(state), now: NOW }

test("the sidebar opens the page, which reads the ladder's rungs", () => {
  scene(
    { update, view },
    given(start),
    click(role("button", { name: "Foreman" })),
    Command.expectExact(SaveSelection({ selection: Selection.Foreman() }), ListRungs()),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    Command.resolve(ListRungs, Message.ReceivedRungs({ rungs: ["sonnet"] })),
    expect(selector(".foreman .note")).toHaveText("Asking the bridge…"),
  )
})

test("the page says the daemon is off, and the policy's buttons run foreman's policy commands", () => {
  scene(
    { update, view },
    given(open),
    expect(selector(".foreman-badge")).toHaveText("daemon off"),
    expect(selector(".foreman-heading .note")).toHaveText("Read less than a minute ago"),
    click(role("button", { name: "pause the fleet" })),
    Command.expectExact(RunForeman({ command: { _tag: "Pause" } })),
    // A command under way is not sent twice.
    expect(role("button", { name: "pause the fleet" })).toBeDisabled(),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "policy pause" })),
    click(role("button", { name: "stop review for every task" })),
    Command.expectExact(RunForeman({ command: { _tag: "SetStep", step: "review", on: false } })),
    Command.resolve(RunForeman, Message.FailedForemanCommand({ line: "policy set review off", reason: "the policy file is not writable" })),
    expect(role("alert")).toHaveText("the policy file is not writable"),
    click(role("button", { name: "one agent fewer" })),
    Command.expectExact(RunForeman({ command: { _tag: "SetSlots", slots: 1 } })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "policy slots 1" })),
    expect(selector(".foreman-grants span")).toHaveText("ep-1: author · 1 of 3 tasks"),
    click(role("button", { name: "revoke the grant for ep-1" })),
    Command.expectExact(RunForeman({ command: { _tag: "Revoke", scope: "ep-1" } })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "policy revoke ep-1" })),
    click(role("button", { name: "read the fleet again" })),
    Command.expectExact(RefreshForeman()),
    Command.resolve(RefreshForeman, Message.CompletedRefreshForeman()),
  )
})

test("kill takes a second click, a review can be allowed once, and the needs-input actions show no button", () => {
  scene(
    { update, view },
    given(open),
    expect(role("button", { name: "intervene ts-w1" })).not.toExist(),
    click(role("button", { name: "kill ts-w1" })),
    expect(role("button", { name: "kill ts-w1" })).toHaveText("kill?"),
    click(role("button", { name: "kill ts-w1" })),
    Command.expectExact(RunForeman({ command: { _tag: "Act", action: "kill", key: "ts-w1" } })),
    expect(role("button", { name: "kill ts-w1" })).toHaveText("kill…"),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "kill ts-w1" })),
    click(role("button", { name: "allow review for ts-r1 once" })),
    Command.expectExact(RunForeman({ command: { _tag: "Allow", key: "ts-r1", step: "review" } })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "policy grant ts-r1 review --count 1" })),
  )
})

test("an epic leads its queued tasks and takes no launch", () => {
  const epic = { ...row("queue", "ep-1", "Ship exports", []), epic: true }
  const child = { ...row("queue", "ts-q3", "Export as CSV", ["complete"]), parent: Option.some("ep-1") }
  const grouped = { ...state, reading: Option.some({ ...reading, rows: [epic, child, ...reading.rows] }) }
  scene(
    { update, view },
    given({ ...open, foreman: Option.some(grouped) }),
    click(role("button", { name: "Queue 4" })),
    expect(role("button", { name: "launch ep-1" })).not.toExist(),
    expect(role("list", { name: "tasks under ep-1" })).toContainText("Export as CSV"),
    expect(role("button", { name: "launch ts-q3" })).toExist(),
  )
})

test("the queue starts folded, and a queued task launches on a picked rung", () => {
  scene(
    { update, view },
    given({ ...open, foremanPage: { ...open.foremanPage, rungs: { _tag: "Listed", rungs: ["haiku", "sonnet"] } } }),
    expect(role("list", { name: "Queue" })).not.toExist(),
    click(role("button", { name: "Queue 2" })),
    expectAll(all.selector(".foreman-row")).toHaveCount(4),
    click(role("button", { name: "lib" })),
    expectAll(all.selector(".foreman-row")).toHaveCount(1),
    click(role("button", { name: "All projects" })),
    click(role("button", { name: "launch ts-q1" })),
    click(role("button", { name: "launch ts-q1 on sonnet" })),
    Command.expectExact(RunForeman({ command: { _tag: "Launch", key: "ts-q1", rung: "sonnet" } })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "dispatch ts-q1 --rung sonnet" })),
    expect(role("button", { name: "launch ts-q1 on sonnet" })).not.toExist(),
  )
})
