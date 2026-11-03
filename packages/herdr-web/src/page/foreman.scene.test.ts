import { Option } from "effect"
import { all, click, Command, expect, expectAll, given, role, scene, selector, Subscription } from "foldkit/scene"
import { describe, test } from "vitest"
import type { Fleet, SpaceGit } from "../shared/Fleet.ts"
import type { ForemanReading, ForemanRow, ForemanState } from "../shared/Foreman.ts"
import { ListRungs, LoadForemanEpic, RefreshForeman, RunForeman, SaveOpenEpics, SaveSelection } from "./commands.ts"
import { init, update, view } from "./main.ts"
import { Bridge, EpicRecord, ForemanQueue, Message, Selection } from "./model.ts"
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
  version: 5,
  dispatcher: { state: "running" },
  policy: { paused: false, slots: 2, default: { author: "off", climb: "off", review: "on", land: "off" }, grants: [{ scope: "ep-1", steps: ["author"], remaining: 3, admitted: ["ts-q1"] }] },
  policyError: Option.none(),
  observedAt: Option.some(new Date(NOW - 30e3).toISOString()),
  projects: [{ name: "app", directory: "/src/app" }, { name: "lib", directory: "/src/lib" }],
  rows: [
    row("working", "ts-w1", "Add the login form", ["focus", "kill", "intervene", "release"]),
    row("review", "ts-r1", "Fix the date parser", ["focus"]),
    row("attention", "ts-k1", "review  Land the export", ["approve"]),
    // An account belongs to the fleet, not to a project, so every space shows it.
    { ...row("quota", "claude", "claude account", []), project: Option.none() },
  ],
  placements: [],
  stopped: [],
}

// The queue comes from `foreman queue`, not from the reading.
const queue = ForemanQueue.Listed({
  rows: [row("queue", "ts-q1", "Write the export", ["complete", "intervene", "descend"]), row("queue", "ts-q2", "Speed up the build", ["complete"], "lib")],
})

const state: ForemanState = { reading: Option.some(reading), problem: Option.none() }

const start = init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [], openEpics: [], closedPanels: [] }).model

// Three spaces: app and lib are each in a project, notes is in none.
// The sidebar names a space by its checkout's folder, so each space's checkout is its own folder.
const gitOf = (name: string, project: Option.Option<string>): SpaceGit => ({ top: `/src/${name}`, branch: Option.some("main"), changed: false, project })
const spaceOf = (id: string, folder: string) => ({ id, name: "", folder, tabs: [{ id: `tab-${id}`, name: "", root: { _tag: "Unknown" as const, type: "browser" } }] })
const fleet: Fleet = {
  connected: true,
  terminals: [],
  git: { s1: gitOf("app", Option.some("app")), s2: gitOf("lib", Option.some("lib")), s3: gitOf("notes", Option.none()) },
  machines: [{ name: "here", isLocal: true, state: "connected", spaces: [spaceOf("s1", "/src/app"), spaceOf("s2", "/src/lib"), spaceOf("s3", "/src/notes")] }],
}

const onTab = (tabId: string) => Selection.Tab({ tabId, maybeFocus: Option.none() })

// The column is on show beside the app space's tab, so its rows are app's and the fleet's own.
const open = {
  ...start,
  selection: onTab("tab-s1"),
  bridge: Bridge.Watching({ fleet }),
  foreman: Option.some(state),
  foremanPage: { ...start.foremanPage, shown: true, queue },
  now: NOW,
}

test("the sidebar row shows the column, which reads the ladder's rungs, and hides it again", () => {
  scene(
    { update, view },
    given({ ...start, bridge: Bridge.Watching({ fleet }) }),
    click(role("button", { name: "Foreman" })),
    Command.expectExact(ListRungs()),
    Command.resolve(ListRungs, Message.ReceivedRungs({ rungs: [{ rung: "sonnet", state: "proven", author: true, review: true }] })),
    expect(selector(".foreman .note")).toHaveText("Asking the bridge…"),
    click(role("button", { name: "Foreman" })),
    expect(selector(".foreman-column")).not.toExist(),
  )
})

test("the column shows the selected space's project and the fleet's own rows", () => {
  scene(
    { update, view },
    given(open),
    expect(selector(".foreman-scope .note")).toHaveText("app"),
    // The queue starts folded: its rows are app's only, when it opens.
    expectAll(all.selector(".foreman-row")).toHaveCount(4),
    click(role("button", { name: "Queue 1" })),
    expectAll(all.selector(".foreman-row")).toHaveCount(5),
  )
})

test("switching space switches the rows the column shows", () => {
  scene(
    { update, view },
    given(open),
    // The space row's name also carries its branch, so match its start.
    click(role("button", { name: /^lib/ })),
    Command.expectExact(SaveSelection({ selection: onTab("tab-s2") })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    expect(selector(".foreman-scope .note")).toHaveText("lib"),
    // lib's account row and its one queued task; app's rows are gone.
    click(role("button", { name: "Queue 1" })),
    expectAll(all.selector(".foreman-row")).toHaveCount(2),
    expect(role("button", { name: "launch ts-q2" })).toExist(),
    expect(role("button", { name: "launch ts-q1" })).not.toExist(),
  )
})

test("a space in no project shows only the fleet's own rows, and no queue", () => {
  scene(
    { update, view },
    given({ ...open, selection: onTab("tab-s3") }),
    expect(selector(".foreman-scope .note")).toHaveText("no project"),
    expectAll(all.selector(".foreman-row")).toHaveCount(1),
    expect(role("button", { name: /^Queue/ })).not.toExist(),
  )
})

test("all projects widens the column to every project's rows", () => {
  scene(
    { update, view },
    given(open),
    click(role("button", { name: "All projects" })),
    expect(selector(".foreman-scope .note")).toHaveText("all projects"),
    click(role("button", { name: "Queue 2" })),
    expectAll(all.selector(".foreman-row")).toHaveCount(6),
  )
})

test("the page says the dispatcher runs, and the policy's buttons run foreman's policy commands", () => {
  scene(
    { update, view },
    given(open),
    expect(selector(".foreman-badge")).toHaveText("running"),
    expect(selector(".foreman-heading .note")).toHaveText("Read less than a minute ago"),
    click(role("button", { name: "pause the fleet" })),
    Command.expectExact(RunForeman({ command: { _tag: "Pause" } })),
    // A command under way is not sent twice.
    expect(role("button", { name: "pause the fleet" })).toBeDisabled(),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "policy pause" })),
    click(role("button", { name: "off review for every task" })),
    Command.expectExact(RunForeman({ command: { _tag: "SetStep", step: "review", setting: "off" } })),
    Command.resolve(RunForeman, Message.FailedForemanCommand({ line: "policy set review off", reason: "the policy file is not writable" })),
    expect(role("alert")).toHaveText("the policy file is not writable"),
    click(role("button", { name: "approve ts-k1" })),
    Command.expectExact(RunForeman({ command: { _tag: "Act", action: "approve", key: "ts-k1" } })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "approve ts-k1" })),
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

test("a failed dispatcher says why, and a reading that has stopped coming says it is stale", () => {
  const failed: ForemanReading = { ...reading, dispatcher: { state: "failed", detail: "prog: command not found" } }
  scene(
    { update, view },
    given({ ...open, foreman: Option.some({ ...state, reading: Option.some(failed) }) }),
    expect(selector(".foreman-badge")).toHaveText("failed"),
    expect(selector(".foreman .note.error")).toHaveText("The dispatcher failed and starts again shortly: prog: command not found"),
  )
  const old = { ...reading, observedAt: Option.some(new Date(NOW - 600e3).toISOString()) }
  scene(
    { update, view },
    given({ ...open, foreman: Option.some({ ...state, reading: Option.some(old) }) }),
    expect(selector(".foreman-badge")).toHaveText("stale"),
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
  scene(
    { update, view },
    given({ ...open, foremanPage: { ...open.foremanPage, queue: ForemanQueue.Listed({ rows: [epic, child, ...queue.rows] }) } }),
    // The epic and its child, and app's own queued task; lib's task is out of the app space's scope.
    click(role("button", { name: "Queue 3" })),
    expect(role("button", { name: "launch ep-1" })).not.toExist(),
    click(role("button", { name: "expand ep-1" })),
    Command.expectExact(SaveOpenEpics({ openEpics: ["ep-1"] }), LoadForemanEpic({ key: "ep-1" })),
    Command.resolve(SaveOpenEpics, Message.CompletedSaveOpenEpics()),
    Command.resolve(LoadForemanEpic, Message.ReceivedForemanEpic({ key: "ep-1", description: Option.none() })),
    expect(selector(".foreman-description")).toHaveText("No description."),
    expect(role("list", { name: "tasks under ep-1" })).toContainText("Export as CSV"),
    expect(role("button", { name: "launch ts-q3" })).toExist(),
  )
})

test("the queue starts folded, and a queued task launches on a picked rung", () => {
  scene(
    { update, view },
    given({ ...open, foremanPage: { ...open.foremanPage, rungs: { _tag: "Listed", rungs: [{ rung: "haiku", state: "proven", author: true, review: true }, { rung: "sonnet", state: "trial", author: true, review: true }, { rung: "opus", state: "disabled", author: true, review: true }] } } }),
    expect(role("list", { name: "Queue" })).not.toExist(),
    click(role("button", { name: "Queue 1" })),
    expectAll(all.selector(".foreman-row")).toHaveCount(5),
    click(role("button", { name: "All projects" })),
    expectAll(all.selector(".foreman-row")).toHaveCount(6),
    click(role("button", { name: "launch ts-q1" })),
    // A disabled rung takes no task, so it is not offered.
    expect(role("button", { name: "launch ts-q1 on opus" })).not.toExist(),
    click(role("button", { name: "launch ts-q1 on sonnet" })),
    Command.expectExact(RunForeman({ command: { _tag: "Launch", key: "ts-q1", rung: "sonnet" } })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "dispatch ts-q1 --rung sonnet" })),
    expect(role("button", { name: "launch ts-q1 on sonnet" })).not.toExist(),
  )
})

test("the queue says why foreman could not rank it", () => {
  scene(
    { update, view },
    given(open),
    Subscription.emit(Message.FailedForemanQueue({ reason: "the task store did not answer" })),
    expect(selector(".foreman .note.error")).toHaveText("the task store did not answer"),
    expect(role("button", { name: /^Queue/ })).not.toExist(),
  )
})

describe("an epic row", () => {
  const epic = { ...row("queue", "ep-1", "Ship exports", []), epic: true }
  const child = { ...row("queue", "ts-q3", "Export as CSV", ["complete"]), parent: Option.some("ep-1") }
  const withEpic = { ...open, foremanPage: { ...open.foremanPage, queue: ForemanQueue.Listed({ rows: [epic, child, ...queue.rows] }) } }

  test("starts collapsed with its subtask count, expands to its description and subtasks, and collapses again", () => {
    scene(
      { update, view },
      given(withEpic),
      click(role("button", { name: "Queue 3" })),
      expect(selector(".foreman-count")).toHaveText("1 subtask"),
      expect(role("list", { name: "tasks under ep-1" })).not.toExist(),
      expect(role("button", { name: "expand ep-1" })).toHaveText("+"),
      click(role("button", { name: "expand ep-1" })),
      Command.expectExact(SaveOpenEpics({ openEpics: ["ep-1"] }), LoadForemanEpic({ key: "ep-1" })),
      Command.resolve(SaveOpenEpics, Message.CompletedSaveOpenEpics()),
      Command.resolve(LoadForemanEpic, Message.ReceivedForemanEpic({ key: "ep-1", description: Option.some("Let people export their data.") })),
      expect(selector(".foreman-description")).toHaveText("Let people export their data."),
      expect(role("list", { name: "tasks under ep-1" })).toContainText("Export as CSV"),
      expect(selector(".foreman-count")).not.toExist(),
      expect(role("button", { name: "collapse ep-1" })).toHaveText("−"),
      click(role("button", { name: "collapse ep-1" })),
      Command.expectExact(SaveOpenEpics({ openEpics: [] })),
      Command.resolve(SaveOpenEpics, Message.CompletedSaveOpenEpics()),
      expect(selector(".foreman-description")).not.toExist(),
      expect(role("list", { name: "tasks under ep-1" })).not.toExist(),
      expect(selector(".foreman-count")).toHaveText("1 subtask"),
    )
  })

  test("an expanded epic stays expanded when the space changes", () => {
    const expanded = { ...withEpic, foremanPage: { ...withEpic.foremanPage, openEpics: ["ep-1"], epicRecords: { "ep-1": EpicRecord.Read({ description: Option.some("Let people export their data.") }) } } }
    scene(
      { update, view },
      given(expanded),
      click(role("button", { name: "Queue 3" })),
      expect(selector(".foreman-description")).toHaveText("Let people export their data."),
      click(role("button", { name: /^lib/ })),
      Command.expectExact(SaveSelection({ selection: onTab("tab-s2") })),
      Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
      click(role("button", { name: "All projects" })),
      expect(selector(".foreman-description")).toHaveText("Let people export their data."),
      expect(role("button", { name: "collapse ep-1" })).toExist(),
    )
  })

  test("says why the description could not be read", () => {
    scene(
      { update, view },
      given({ ...withEpic, foremanPage: { ...withEpic.foremanPage, openEpics: ["ep-1"] } }),
      click(role("button", { name: "Queue 3" })),
      expect(selector(".foreman-row .note")).toHaveText("Reading the epic…"),
      Subscription.emit(Message.FailedForemanEpic({ key: "ep-1", reason: "no task ep-1" })),
      expect(selector(".foreman-row .note.error")).toHaveText("no task ep-1"),
    )
  })
})
