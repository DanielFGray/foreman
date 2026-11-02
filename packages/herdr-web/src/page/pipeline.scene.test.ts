import { Option } from "effect"
import { STANDARD_PIPELINE } from "foreman/pipeline"
import { all, click, Command, expect, expectAll, given, role, scene, selector, Subscription } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, SpaceGit } from "../shared/Fleet.ts"
import type { ForemanReading } from "../shared/Foreman.ts"
import { LoadForemanPipeline, SaveForemanPipeline } from "./commands.ts"
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

const start = init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [], openEpics: [] }).model

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
  foremanPage: { ...start.foremanPage, shown: true, rungs: RungList.Listed({ rungs: ["haiku", "sonnet", "opus"] }) },
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
    // The router's two routes and its else are three wires, each labelled; the other blocks have one.
    expectAll(all.selector(".pipeline-track")).toHaveCount(12),
    expect(selector(".pipeline-wire-label[title='failed']")).toExist(),
    expect(selector(".pipeline-wire-label[title='else']")).toExist(),
    // The retry gate stands on a row of its own, below the main belt.
    expect(role("button", { name: "gate climb" })).toHaveAttr("data-row", "1"),
    expect(role("button", { name: "gate start" })).toHaveAttr("data-row", "0"),
    expect(role("button", { name: "land land" })).toHaveAttr("data-row", "0"),
    expect(selector(".pipeline-problems")).not.toExist(),
  )
})

test("putting a block on a wire shows it on the belt", () => {
  scene(
    { update, view },
    ...opened,
    click(role("button", { name: "add a block after queue on next" })),
    click(role("button", { name: "put a gate on the wire" })),
    expectAll(all.selector(".pipeline-station")).toHaveCount(STANDARD_PIPELINE.nodes.length + 1),
    // The new block is picked, so its settings are open.
    expect(selector(".pipeline-inspector h4")).toContainText("gate gate-"),
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
    click(role("button", { name: "add a block after queue on next" })),
    expect(role("button", { name: "put a branch on the wire" })).toExist(),
    expect(role("button", { name: "put a worktree on the wire" })).toExist(),
    click(role("button", { name: "land land" })),
    expect(role("combobox", { name: "how" })).toExist(),
    expect(selector(".pipeline-inspector option[value='merge']")).toHaveAttr("selected", "true"),
    expect(selector(".pipeline-inspector option[value='fast-forward']")).toExist(),
    expect(role("button", { name: "Make it a done" })).toExist(),
  )
})
