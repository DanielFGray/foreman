import { Option } from "effect"
import { STANDARD_PIPELINE } from "foreman/pipeline"
import { all, click, Command, expect, expectAll, given, role, scene, selector } from "foldkit/scene"
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
    expectAll(all.selector(".pipeline-wire")).toHaveCount(10),
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
