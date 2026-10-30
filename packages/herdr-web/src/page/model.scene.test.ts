import { Option } from "effect"
import { click, Command, expect, given, Mount, role, scene, selector, Subscription } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Layout, Terminal } from "../shared/Fleet.ts"
import { PickModel, SaveRecent, SaveSelection } from "./commands.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { LiveTerminal } from "./terminal.ts"

const block: Layout = { _tag: "Block", type: "block", id: "p1", size: Option.none(), content: { _tag: "Terminal", terminal: "t1" } }

const agent: Terminal = {
  address: "t1",
  name: Option.none(),
  title: Option.none(),
  cwd: "/src/app",
  state: "live",
  status: Option.some({ state: "idle", app: Option.some("claude-code"), msg: Option.none(), kind: Option.none(), progress: Option.none() }),
  status_ms: Option.none(),
  foreground: Option.some({ name: "claude", pid: 7, argv: ["claude"] }),
  labels: {},
  created_ms: 0,
  cols: 80,
  rows: 24,
  parent: Option.none(),
}

const fleet: Fleet = {
  connected: true,
  git: {},
  terminals: [agent],
  machines: [{ name: "here", isLocal: true, state: "connected", spaces: [{ id: "s1", name: "app", folder: "/src/app", tabs: [{ id: "a", name: "a", root: block }] }] }],
}

const start = {
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.none() }), sidebarWidth: Option.none(), recent: [], softKeys: Option.none() }).model,
  bridge: Bridge.Watching({ fleet }),
}

test("an agent's pane names its model, and the tag picks another through /model", () => {
  scene(
    { update, view },
    given(start),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()], [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })]),
    // No tag before the first reply.
    expect(selector(".model-tag")).not.toExist(),
    Subscription.emit(Message.ReceivedModel({ address: "t1", model: Option.some("claude-opus-5-5[1m]") })),
    expect(selector(".model-tag")).toHaveText("Opus 5.5"),
    click(role("button", { name: "model: Opus 5.5; pick another" })),
    // The click reaches the pane head too, which focuses the pane.
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    Command.resolve(SaveRecent, Message.CompletedSaveRecent()),
    expect(role("menuitem", { name: "Opus" })).toHaveAttr("aria-current", "true"),
    click(role("menuitem", { name: "Haiku" })),
    Command.expectExact(PickModel({ address: "t1", alias: "haiku" })),
    Command.resolve(PickModel, Message.SucceededPickModel()),
    expect(role("menu", { name: "models" })).not.toExist(),
  )
})

test("the page fits the part of the window a person sees, and the whole window when the browser says nothing", () => {
  scene(
    { update, view },
    given(start),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()], [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })]),
    expect(selector(".app")).toHaveStyle("--viewport-height", "100dvh"),
    // A phone's keyboard opened, and the browser moved what it shows down by 40px.
    Subscription.emit(Message.ChangedViewport({ viewport: Option.some({ top: 40, height: 400 }) })),
    expect(selector(".app")).toHaveStyle("--viewport-top", "40px"),
    expect(selector(".app")).toHaveStyle("--viewport-height", "400px"),
  )
})
