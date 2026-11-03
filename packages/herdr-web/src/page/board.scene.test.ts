// @vitest-environment happy-dom
import { Option } from "effect"
import { all, click, Command, expect, expectAll, given, pointerDown, role, scene, selector, Subscription } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, SpaceGit } from "../shared/Fleet.ts"
import { FOREMAN_VERSION, type ForemanPlacement, type ForemanReading } from "../shared/Foreman.ts"
import { CapturePointer, ListRungs, RunForeman } from "./commands.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, RungList, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"

const NOW = Date.parse("2026-10-30T01:00:00Z")

const placed = (key: string, column: ForemanPlacement["column"], project = "app"): ForemanPlacement => ({ key, label: `task ${key}`, project, column, url: Option.none(), pr: Option.none() })

const reading: ForemanReading = {
  version: FOREMAN_VERSION,
  dispatcher: { state: "running" },
  policy: { paused: false, slots: 2, default: { author: "ask", climb: "on", review: "on", publish: "on", land: "on" }, grants: [] },
  policyError: Option.none(),
  observedAt: Option.some(new Date(NOW - 30e3).toISOString()),
  projects: [
    { name: "app", grantSteps: ["author"], tracker: "prog", repo: Option.none(), unreachable: Option.none() },
    { name: "lib", grantSteps: [], tracker: "prog", repo: Option.none(), unreachable: Option.none() },
  ],
  rows: [
    { view: "attention", key: "ts-ask", label: "task ts-ask", detail: Option.some("claimed, but no agent works on it"), project: Option.some("app"), parent: Option.none(), epic: false, actions: ["release", "retry"], url: Option.none(), pr: Option.none() },
  ],
  placements: [placed("ts-q1", "queue"), placed("ts-ask", "needs-you"), placed("ts-a1", "authoring"), placed("ts-r1", "review"), placed("ts-f1", "fixing"), placed("ts-done", "landed"), placed("ts-lib", "queue", "lib")],
  stopped: [],
  landed: [{ key: "ts-l1", label: "task ts-l1", project: "app", landedAt: new Date(NOW - 3600e3).toISOString() }],
}

const start = init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [], openEpics: [] }).model

const git: SpaceGit = { top: "/src/app", branch: Option.some("main"), changed: false, project: Option.some("app") }
const fleet: Fleet = {
  connected: true,
  terminals: [],
  git: { s1: git },
  machines: [{ name: "here", isLocal: true, state: "connected", spaces: [{ id: "s1", name: "", folder: "/src/app", tabs: [{ id: "tab-s1", name: "", root: { _tag: "Unknown" as const, type: "browser" } }] }] }],
}

const rungs = [
  { rung: "haiku", state: "proven", author: true, review: true },
  { rung: "sonnet", state: "trial", author: true, review: true },
  { rung: "opus", state: "disabled", author: true, review: true },
]

// The column is on show beside app's space, with its board, and the ladder's rungs are read.
const open = {
  ...start,
  selection: Selection.Tab({ tabId: "tab-s1", maybeFocus: Option.none() }),
  bridge: Bridge.Watching({ fleet }),
  foreman: Option.some({ reading: Option.some(reading), problem: Option.none() }),
  foremanPage: { ...start.foremanPage, shown: true, isBoardShown: true, rungs: RungList.Listed({ rungs }) },
  now: NOW,
}

const withReading = (change: Partial<ForemanReading>) => Message.ReceivedForeman({ state: { reading: Option.some({ ...reading, ...change }), problem: Option.none() } })

// The layout board.ts draws: columns 220px wide with an 8px gap under a 32px
// head, so the first Queue card's centre is at (110, 64), and the first place
// in Authoring, the third column, is centred at (566, 64).
const QUEUE_CARD = { x: 110, y: 64 }
const AUTHORING = { x: 566, y: 64 }
const grant = { _tag: "Grant", scope: "ts-q1", steps: ["author"] } as const

test("each card stands in the column foreman names, and Landed holds what landed", () => {
  scene(
    { update, view },
    given(open),
    expect(selector(".board-column.queue")).toContainText("ts-q1"),
    expect(selector(".board-column.needs-you")).toContainText("ts-ask"),
    expect(selector(".board-column.authoring")).toContainText("ts-a1"),
    expect(selector(".board-column.review")).toContainText("ts-r1"),
    expect(selector(".board-column.fixing")).toContainText("ts-f1"),
    expect(selector(".board-column.landed")).toContainText("ts-l1"),
    // Landed shows the reading's `landed`, not a placement foreman has yet to settle.
    expect(selector(".board")).not.toContainText("ts-done"),
    // Another project's card shows only for all projects.
    expect(selector(".board")).not.toContainText("ts-lib"),
    click(role("button", { name: "All projects" })),
    expect(selector(".board-column.queue")).toContainText("ts-lib"),
  )
})

test("a later reading moves a card; the board predicts nothing", () => {
  scene(
    { update, view },
    given(open),
    Subscription.emit(withReading({ placements: [placed("ts-q1", "authoring")] })),
    expect(selector(".board-column.queue")).not.toContainText("ts-q1"),
    expect(selector(".board-column.authoring")).toContainText("ts-q1"),
  )
})

test("a Needs-you card shows the attention row's detail and runs its actions", () => {
  scene(
    { update, view },
    given(open),
    expect(selector(".board-column.needs-you .board-detail")).toHaveText("claimed, but no agent works on it"),
    click(role("button", { name: "retry ts-ask" })),
    Command.expectExact(RunForeman({ command: { _tag: "Act", action: "retry", key: "ts-ask" } })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "retry ts-ask" })),
  )
})

test("a Queue card dragged onto Authoring grants its project's grant steps", () => {
  scene(
    { update, view },
    given(open),
    pointerDown(selector("#board-card-ts-q1"), { clientX: QUEUE_CARD.x, clientY: QUEUE_CARD.y, pointerId: 7 }),
    Command.expectExact(CapturePointer({ elementId: "board-card-ts-q1", pointerId: 7 })),
    Command.resolve(CapturePointer, Message.CompletedCapturePointer()),
    Subscription.emit(Message.MovedPointer({ at: { x: AUTHORING.x - 10, y: AUTHORING.y + 20 } })),
    // The card floats with the pointer, and the place it would take is outlined.
    expect(selector(".board-card.floating.snapped")).toExist(),
    expect(selector(".board-preview")).toExist(),
    Subscription.emit(Message.ReleasedPointer()),
    Command.expectExact(RunForeman({ command: grant })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "policy grant ts-q1 author" })),
    // The card stays in Queue until foreman's next reading moves it.
    expect(selector(".board-column.queue")).toContainText("ts-q1"),
    expect(selector(".board-card.floating")).not.toExist(),
  )
})

test("a card let go away from Authoring runs nothing", () => {
  scene(
    { update, view },
    given(open),
    pointerDown(selector("#board-card-ts-q1"), { clientX: QUEUE_CARD.x, clientY: QUEUE_CARD.y }),
    Command.resolve(CapturePointer, Message.CompletedCapturePointer()),
    Subscription.emit(Message.MovedPointer({ at: { x: QUEUE_CARD.x + 30, y: QUEUE_CARD.y + 10 } })),
    Subscription.emit(Message.ReleasedPointer()),
    Command.expectNone(),
  )
})

test("a touch drags only once held, and one that moves first is a scroll", () => {
  scene(
    { update, view },
    given(open),
    pointerDown(selector("#board-card-ts-q1"), { pointerType: "touch", clientX: QUEUE_CARD.x, clientY: QUEUE_CARD.y, pointerId: 3 }),
    Command.expectNone(),
    Subscription.emit(Message.MovedPointer({ at: { x: QUEUE_CARD.x + 40, y: QUEUE_CARD.y } })),
    Subscription.emit(Message.HeldCard({ key: "ts-q1" })),
    Command.expectNone(),
    expect(selector(".board-card.floating")).not.toExist(),
    pointerDown(selector("#board-card-ts-q1"), { pointerType: "touch", clientX: QUEUE_CARD.x, clientY: QUEUE_CARD.y, pointerId: 4 }),
    Subscription.emit(Message.HeldCard({ key: "ts-q1" })),
    Command.expectExact(CapturePointer({ elementId: "board-card-ts-q1", pointerId: 4 })),
    Command.resolve(CapturePointer, Message.CompletedCapturePointer()),
    Subscription.emit(Message.MovedPointer({ at: AUTHORING })),
    Subscription.emit(Message.ReleasedPointer()),
    Command.expectExact(RunForeman({ command: grant })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "policy grant ts-q1 author" })),
  )
})

test("a drag the browser takes back runs nothing", () => {
  scene(
    { update, view },
    given(open),
    pointerDown(selector("#board-card-ts-q1"), { clientX: QUEUE_CARD.x, clientY: QUEUE_CARD.y }),
    Command.resolve(CapturePointer, Message.CompletedCapturePointer()),
    Subscription.emit(Message.MovedPointer({ at: AUTHORING })),
    Subscription.emit(Message.CanceledPointer()),
    Subscription.emit(Message.ReleasedPointer()),
    Command.expectNone(),
  )
})

test("a project with no grant steps, and any column but Queue, takes no drag", () => {
  scene(
    { update, view },
    given({ ...open, foremanPage: { ...open.foremanPage, all: true } }),
    expect(selector("#board-card-ts-q1.movable")).toExist(),
    expect(selector("#board-card-ts-lib.movable")).not.toExist(),
    expect(selector("#board-card-ts-a1.movable")).not.toExist(),
  )
})

test("a stopped project in scope shows why", () => {
  scene(
    { update, view },
    given(open),
    Subscription.emit(withReading({ stopped: [{ project: "app", problems: ["queue: no route reaches a land"] }, { project: "lib", problems: ["not shown"] }] })),
    expect(selector(".board-stopped")).toContainText("queue: no route reaches a land"),
    expect(selector(".board-stopped")).not.toContainText("not shown"),
  )
})

test("the ladder lists the rungs in order with their states", () => {
  scene(
    { update, view },
    given(open),
    expectAll(all.selector(".foreman-rungs-list li")).toHaveCount(3),
    expect(selector(".foreman-rungs-list li.off .foreman-rung")).toHaveText("opus"),
  )
})

// Each switch runs one foreman command; the column reads the ladder again once it is done.
test("a ladder switch runs its foreman command and reads the ladder again", () => {
  const disable = { _tag: "SetRung", rung: "sonnet", on: false } as const
  const cheaper = { _tag: "MoveRung", rung: "sonnet", side: "below", of: "haiku" } as const
  scene(
    { update, view },
    given(open),
    expect(role("button", { name: "move haiku below sonnet" })).not.toExist(),
    click(role("button", { name: "disable sonnet" })),
    Command.expectHas(RunForeman({ command: disable })),
    Command.resolve(RunForeman({ command: disable }), Message.SucceededForemanCommand({ line: "ladder disable sonnet" })),
    Command.expectHas(ListRungs()),
    Command.resolve(ListRungs(), Message.ReceivedRungs({ rungs: [rungs[0]!, { ...rungs[1]!, state: "disabled" }, rungs[2]!] })),
    expect(role("button", { name: "enable sonnet" })).toExist(),
    click(role("button", { name: "move sonnet below haiku" })),
    Command.expectHas(RunForeman({ command: cheaper })),
    Command.resolve(RunForeman({ command: cheaper }), Message.FailedForemanCommand({ line: "ladder move sonnet --below haiku", reason: "no such rung" })),
  )
})

test("a board shown again drags from where its cards now stand", () => {
  scene(
    { update, view },
    given(open),
    Subscription.emit(Message.ScrolledBoardColumn({ column: "queue", top: 300 })),
    click(role("button", { name: "Board" })),
    click(role("button", { name: "Board" })),
    pointerDown(selector("#board-card-ts-q1"), { clientX: QUEUE_CARD.x, clientY: QUEUE_CARD.y }),
    Command.resolve(CapturePointer, Message.CompletedCapturePointer()),
    Subscription.emit(Message.MovedPointer({ at: AUTHORING })),
    Subscription.emit(Message.ReleasedPointer()),
    Command.expectExact(RunForeman({ command: grant })),
    Command.resolve(RunForeman, Message.SucceededForemanCommand({ line: "policy grant ts-q1 author" })),
  )
})

test("a card links its issue and shows its pull request, and an unreachable project says why", () => {
  const issue = "https://github.com/o/app/issues/7"
  const pr = { number: 9, url: "https://github.com/o/app/pull/9", state: "open", checks: Option.some("passing" as const), waiting: Option.some("you" as const) } as const
  scene(
    { update, view },
    given(open),
    Subscription.emit(
      withReading({
        placements: [{ ...placed("app#7", "review"), url: Option.some(issue), pr: Option.some(pr) }],
        projects: [{ name: "app", grantSteps: [], tracker: "github", repo: Option.some("o/app"), unreachable: Option.some("gh auth status: not signed in") }],
      }),
    ),
    expect(selector(`.board-column.review a[href="${issue}"]`)).toContainText("app#7"),
    expect(selector(`.board-column.review a[href="${pr.url}"]`)).toContainText("PR #9"),
    expect(selector(".board-column.review")).toContainText("checks passing, waits for your approval"),
    expect(selector(".board-stopped")).toContainText("The github tracker of app did not answer"),
    expect(selector(".board-stopped")).toContainText("gh auth status: not signed in"),
  )
})
