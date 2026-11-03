import { Option } from "effect"
import { STANDARD_PIPELINE } from "foreman/pipeline"
import { all, click, Command, expect, expectAll, given, role, scene, selector, Subscription, type } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, SpaceGit } from "../shared/Fleet.ts"
import type { ForemanReading } from "../shared/Foreman.ts"
import { ListRungs, LoadForemanPipeline, RunForeman, SaveClosedPanels, SaveForemanPipeline } from "./commands.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, RungList, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"

const NOW = Date.parse("2026-10-30T01:00:00Z")

const reading: ForemanReading = {
  version: 5,
  dispatcher: { state: "running" },
  policy: { paused: false, slots: 2, default: { author: "on", climb: "on", review: "on", land: "on" }, grants: [] },
  policyError: Option.none(),
  observedAt: Option.some(new Date(NOW - 30e3).toISOString()),
  projects: [{ name: "app", directory: "/src/app" }],
  rows: [],
  placements: [],
  stopped: [],
}

const start = init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [], openEpics: [], closedPanels: [] }).model

const git: SpaceGit = { top: "/src/app", branch: Option.some("main"), changed: false, project: Option.some("app") }
const fleet: Fleet = {
  connected: true,
  terminals: [],
  git: { s1: git },
  machines: [{ name: "here", isLocal: true, state: "connected", spaces: [{ id: "s1", name: "", folder: "/src/app", tabs: [{ id: "tab-s1", name: "", root: { _tag: "Unknown" as const, type: "browser" } }] }] }],
}

// The column is on show beside app's space, and the ladder's rungs are read.
const open = {
  ...start,
  selection: Selection.Tab({ tabId: "tab-s1", maybeFocus: Option.none() }),
  bridge: Bridge.Watching({ fleet }),
  foreman: Option.some({ reading: Option.some(reading), problem: Option.none() }),
  foremanPage: { ...start.foremanPage, shown: true, rungs: RungList.Listed({ rungs: [{ rung: "haiku", state: "proven", author: true, review: true }, { rung: "sonnet", state: "trial", author: true, review: true }, { rung: "opus", state: "disabled", author: true, review: true }] }) },
  now: NOW,
}

const opened = [
  given(open),
  click(role("button", { name: "Pipeline of app" })),
  Command.expectExact(LoadForemanPipeline({ project: "app" })),
  Command.resolve(LoadForemanPipeline, Message.ReceivedPipeline({ project: "app", drawn: false, pipeline: STANDARD_PIPELINE })),
] as const

test("the standard pipeline draws as one belt with the retry branch", () => {
  scene(
    { update, view },
    ...opened,
    expectAll(all.selector(".pipeline-station")).toHaveCount(STANDARD_PIPELINE.nodes.length),
    // The router's two routes and its else are three wires, each labelled; the author's
    // done and already-done are two; review has approved and returned.
    expectAll(all.selector(".pipeline-track")).toHaveCount(14),
    expect(selector(".pipeline-wire-label[title='returned']")).toExist(),
    expect(selector(".pipeline-wire-label[title='failed']")).toExist(),
    expect(selector(".pipeline-wire-label[title='else']")).toExist(),
    // The retry gate stands on a row of its own, below the main belt.
    expect(role("button", { name: "gate climb" })).toHaveAttr("data-row", "1"),
    expect(role("button", { name: "gate start" })).toHaveAttr("data-row", "0"),
    expect(role("button", { name: "land land" })).toHaveAttr("data-row", "0"),
    expect(selector(".pipeline-problems")).not.toExist(),
  )
})

test("a kind picked in the palette goes on the belt whose + is picked", () => {
  scene(
    { update, view },
    ...opened,
    // No "+" shows until a kind is picked.
    expect(selector(".pipeline-add")).not.toExist(),
    click(role("button", { name: "◧ gate" })),
    expect(role("button", { name: "◧ gate" })).toHaveAttr("aria-pressed", "true"),
    click(role("button", { name: "put the gate after queue on next" })),
    expectAll(all.selector(".pipeline-station")).toHaveCount(STANDARD_PIPELINE.nodes.length + 1),
    // The pick is spent, and the new block is picked, so its inspector floats on the drawing.
    expect(selector(".pipeline-add")).not.toExist(),
    expect(selector(".pipeline-belt .pipeline-inspector h4")).toContainText("gate gate-"),
    expect(selector(".pipeline-changes li")).toContainText("added gate gate-"),
    expect(selector(".pipeline-changes li")).toContainText("after queue"),
  )
})

test("the palette adds a source at once", () => {
  scene(
    { update, view },
    ...opened,
    click(role("button", { name: "⇥ Add source" })),
    expectAll(all.selector(".pipeline-station.source")).toHaveCount(2),
    expect(selector(".pipeline-inspector h4")).toContainText("source source-"),
  )
})

test("the changes panel lists the unsaved edits, and a revert empties it", () => {
  scene(
    { update, view },
    ...opened,
    expect(selector(".pipeline-changes")).toContainText("No changes since the last save."),
    expect(role("button", { name: "Revert to saved" })).toBeDisabled(),
    click(role("button", { name: "land land" })),
    click(role("button", { name: "Make it a done" })),
    expect(selector(".pipeline-changes li")).toHaveText("made land a done"),
    click(role("button", { name: "Revert to saved" })),
    expect(selector(".pipeline-changes")).toContainText("No changes since the last save."),
  )
})

test("the ladder panel lists the rungs in order with their states", () => {
  scene(
    { update, view },
    ...opened,
    expectAll(all.selector(".pipeline-rungs li")).toHaveCount(3),
    expectAll(all.selector(".pipeline-rungs .pipeline-rung")).toHaveCount(3),
    expect(selector(".pipeline-rungs li.off .pipeline-rung")).toHaveText("opus"),
  )
})

// Each switch runs one foreman command; the panel reads the ladder again once it is done.
test("a ladder switch runs its foreman command and reads the ladder again", () => {
  const disable = { _tag: "SetRung", rung: "sonnet", on: false } as const
  const cheaper = { _tag: "MoveRung", rung: "sonnet", side: "below", of: "haiku" } as const
  scene(
    { update, view },
    ...opened,
    expect(role("button", { name: "move haiku below sonnet" })).not.toExist(),
    click(role("button", { name: "disable sonnet" })),
    Command.expectHas(RunForeman({ command: disable })),
    Command.resolve(RunForeman({ command: disable }), Message.SucceededForemanCommand({ line: "ladder disable sonnet" })),
    Command.expectHas(ListRungs()),
    Command.resolve(ListRungs(), Message.ReceivedRungs({ rungs: [{ rung: "haiku", state: "proven", author: true, review: true }, { rung: "sonnet", state: "disabled", author: true, review: true }, { rung: "opus", state: "disabled", author: true, review: true }] })),
    expect(role("button", { name: "enable sonnet" })).toExist(),
    click(role("button", { name: "keep opus out of review" })),
    Command.expectHas(RunForeman({ command: { _tag: "SetRole", rung: "opus", role: "review", on: false } })),
    Command.resolve(RunForeman({ command: { _tag: "SetRole", rung: "opus", role: "review", on: false } }), Message.SucceededForemanCommand({ line: "ladder role opus review off" })),
    Command.resolve(ListRungs(), Message.ReceivedRungs({ rungs: [{ rung: "haiku", state: "proven", author: true, review: true }, { rung: "sonnet", state: "disabled", author: true, review: true }, { rung: "opus", state: "disabled", author: true, review: false }] })),
    expect(role("button", { name: "let opus review" })).toExist(),
    click(role("button", { name: "move sonnet below haiku" })),
    Command.expectHas(RunForeman({ command: cheaper })),
    Command.resolve(RunForeman({ command: cheaper }), Message.FailedForemanCommand({ line: "ladder move sonnet --below haiku", reason: "no such rung" })),
  )
})

test("a panel closes and opens again, and the choice is kept in this browser", () => {
  scene(
    { update, view },
    ...opened,
    click(role("button", { name: "close the Ladder panel" })),
    Command.expectExact(SaveClosedPanels({ closedPanels: ["ladder"] })),
    Command.resolve(SaveClosedPanels, Message.CompletedSaveClosedPanels()),
    expect(selector(".pipeline-ladder")).not.toExist(),
    expect(role("button", { name: "Ladder" })).toHaveAttr("aria-pressed", "false"),
    click(role("button", { name: "Ladder" })),
    Command.expectExact(SaveClosedPanels({ closedPanels: [] })),
    Command.resolve(SaveClosedPanels, Message.CompletedSaveClosedPanels()),
    expect(selector(".pipeline-ladder")).toExist(),
  )
})

test("a viewer who closed a panel opens the pipeline without it", () => {
  scene(
    { update, view },
    given({ ...open, foremanPage: { ...open.foremanPage, closedPanels: ["blocks", "changes"] } }),
    click(role("button", { name: "Pipeline of app" })),
    Command.resolve(LoadForemanPipeline, Message.ReceivedPipeline({ project: "app", drawn: false, pipeline: STANDARD_PIPELINE })),
    expect(selector(".pipeline-blocks")).not.toExist(),
    expect(selector(".pipeline-changes")).not.toExist(),
    expect(selector(".pipeline-ladder")).toExist(),
  )
})

test("a disabled rung is a valid model, as foreman checks it, and an unlisted one is not", () => {
  scene(
    { update, view },
    ...opened,
    click(role("button", { name: "agent author" })),
    type(role("textbox", { name: "model" }), "opus"),
    expect(selector(".pipeline-problems")).not.toExist(),
    type(role("textbox", { name: "model" }), "gpt-9"),
    expect(selector(".pipeline-problems")).toContainText("gpt-9"),
  )
})

test("a problem shows under the drawing and the save is disabled", () => {
  scene(
    { update, view },
    ...opened,
    expect(role("button", { name: "Save" })).not.toBeDisabled(),
    // Without its reviewer, the land is reached with no review after the author.
    click(role("button", { name: "agent review" })),
    click(role("button", { name: "Remove block" })),
    expect(selector(".pipeline-problems")).toContainText("with no review after it"),
    expect(role("button", { name: "Save" })).toBeDisabled(),
  )
})

test("save sends the draft, and a refusal is shown", () => {
  scene(
    { update, view },
    ...opened,
    click(role("button", { name: "agent author" })),
    click(role("button", { name: "Remove block" })),
    click(role("button", { name: "Save" })),
    Command.expectExact(
      SaveForemanPipeline({ project: "app", pipeline: { nodes: STANDARD_PIPELINE.nodes.filter((node) => node.id !== "author").map((node) => (node.kind === "gate" && node.next === "author" ? { ...node, next: "review-gate" } : node)) } }),
    ),
    Command.resolve(SaveForemanPipeline, Message.FailedPipelineChange({ project: "app", reason: "the ladder has no rung haiku" })),
    expect(selector(".pipeline .note.error")).toHaveText("the ladder has no rung haiku"),
  )
})

const placed = (key: string, node: string, state: "waiting" | "running" | "ended", gates: ReadonlyArray<{ id: string; step: string }> = []) => ({
  key,
  label: `Task ${key}`,
  project: "app",
  node,
  state,
  gates,
  runs: [],
})

const withReading = (change: Partial<ForemanReading>) => Message.ReceivedForeman({ state: { reading: Option.some({ ...reading, ...change }), problem: Option.none() } })

test("tasks show at their block by state, and a later reading moves them", () => {
  scene(
    { update, view },
    ...opened,
    expect(selector(".pipeline-standing")).not.toExist(),
    expect(selector(".pipeline-standing-block")).not.toExist(),
    Subscription.emit(Message.ReceivedForeman({
      state: {
        reading: Option.some({
          ...reading,
          placements: [
            placed("ts-1", "author", "running"),
            placed("ts-2", "author", "waiting", [{ id: "start", step: "author" }]),
            placed("ts-3", "author", "waiting", [{ id: "start", step: "author" }]),
            placed("ts-4", "review", "ended"),
            { ...placed("ts-5", "author", "running"), project: "lib" },
          ],
        }),
        problem: Option.none(),
      },
    })),
    // The author block counts its three tasks; the other project's task is not shown.
    expect(selector(".pipeline-station[aria-label='agent author'] .pipeline-count")).toHaveText("3"),
    expect(selector(".pipeline-station[aria-label='agent author'] .pipeline-count")).toHaveAttr("title", "2 waiting, 1 running"),
    expect(selector(".pipeline-station[aria-label='agent review'] .pipeline-count")).toHaveText("1"),
    // The gate shows how many tasks wait behind it.
    expect(selector(".pipeline-station[aria-label='gate start'] .pipeline-count")).toHaveText("2"),
    expect(selector(".pipeline-station[aria-label='land land'] .pipeline-count")).not.toExist(),
    expectAll(all.selector(".pipeline-standing-block")).toHaveCount(2),
    expect(selector("ul[aria-label='tasks at author']")).toContainText("ts-2 Task ts-2 (held by start for author)"),
    // A later reading moves a task on, and the view follows with no other message.
    Subscription.emit(Message.ReceivedForeman({
      state: { reading: Option.some({ ...reading, placements: [placed("ts-2", "review", "waiting")] }), problem: Option.none() },
    })),
    expect(selector(".pipeline-station[aria-label='agent author'] .pipeline-count")).not.toExist(),
    expect(selector(".pipeline-station[aria-label='agent review'] .pipeline-count")).toHaveText("1"),
  )
})

test("a stopped project shows its problems at the top, and the editor still opens", () => {
  const stopped = withReading({ stopped: [{ project: "app", problems: ["queue: no route reaches a land"] }, { project: "lib", problems: ["not shown"] }] })
  scene(
    { update, view },
    given(open),
    Subscription.emit(stopped),
    // Closed, the problems stand above the button that opens the editor.
    expect(selector(".pipeline-stopped")).toContainText("queue: no route reaches a land"),
    expect(selector(".pipeline-stopped")).not.toContainText("not shown"),
    click(role("button", { name: "Pipeline of app" })),
    Command.expectExact(LoadForemanPipeline({ project: "app" })),
    Command.resolve(LoadForemanPipeline, Message.ReceivedPipeline({ project: "app", drawn: false, pipeline: STANDARD_PIPELINE })),
    expect(selector(".pipeline .pipeline-stopped")).toContainText("is stopped, so no task takes a step"),
    expectAll(all.selector(".pipeline-station")).toHaveCount(STANDARD_PIPELINE.nodes.length),
  )
})

test("the block palette offers the workspace blocks, and a land's inspector sets how it lands", () => {
  scene(
    { update, view },
    ...opened,
    expect(role("button", { name: "⎇ branch" })).toExist(),
    expect(role("button", { name: "▤ worktree" })).toExist(),
    click(role("button", { name: "land land" })),
    expect(role("combobox", { name: "how" })).toExist(),
    expect(selector(".pipeline-inspector option[value='merge']")).toHaveAttr("selected", "true"),
    expect(selector(".pipeline-inspector option[value='fast-forward']")).toExist(),
    expect(role("button", { name: "Make it a done" })).toExist(),
  )
})
