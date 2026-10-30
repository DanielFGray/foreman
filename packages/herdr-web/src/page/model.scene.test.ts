import { Option } from "effect"
import { click, Command, expect, given, Mount, role, scene, selector, Subscription } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Layout, Terminal } from "../shared/Fleet.ts"
import { BridgeError } from "../shared/Api.ts"
import type { ModelChoices } from "../shared/Harness.ts"
import { ListModelChoices, Pair, PickModel, SaveRecent, SaveSelection } from "./commands.ts"
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
  records: Option.none(),
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
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.none() }), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false }).model,
  bridge: Bridge.Watching({ fleet }),
}

const claudeChoices: ModelChoices = {
  choices: [
    { alias: "opus", name: "Opus" },
    { alias: "haiku", name: "Haiku" },
  ],
  current: Option.some("opus"),
  note: "A note under the models.",
}

test("an agent's pane names its model, and the tag picks another of the choices the bridge reads", () => {
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
    expect(selector(".model-menu")).toContainText("Reading the models"),
    Command.resolve(ListModelChoices, Message.ReceivedModelChoices({ address: "t1", choices: claudeChoices })),
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

const opencode: Terminal = {
  ...agent,
  status: Option.some({ state: "idle", app: Option.some("opencode"), msg: Option.none(), kind: Option.none(), progress: Option.none() }),
  foreground: Option.some({ name: "opencode", pid: 8, argv: ["opencode"] }),
}

test("an agent whose server lists its models offers to pair, and reads them again once paired", () => {
  scene(
    { update, view },
    given({ ...start, bridge: Bridge.Watching({ fleet: { ...fleet, terminals: [opencode] } }) }),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()], [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })]),
    Subscription.emit(Message.ReceivedModel({ address: "t1", model: Option.some("acme/model-one") })),
    expect(selector(".model-tag")).toHaveText("model-one"),
    click(role("button", { name: "model: model-one; pick another" })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    Command.resolve(SaveRecent, Message.CompletedSaveRecent()),
    Command.resolve(ListModelChoices, Message.FailedModelChoices({ address: "t1", failure: new BridgeError({ kind: "unpaired", message: "not paired yet" }) })),
    expect(selector(".model-menu")).toContainText("The models cannot be read: not paired yet"),
    click(role("button", { name: "Pair" })),
    Command.expectExact(Pair({ address: "t1" })),
    expect(role("button", { name: "Pairing…" })).toBeDisabled(),
    Command.resolve(Pair, Message.SucceededPair({ address: "t1" })),
    Command.expectExact(ListModelChoices({ address: "t1" })),
    Command.resolve(
      ListModelChoices,
      Message.ReceivedModelChoices({ address: "t1", choices: { choices: [{ alias: "acme/model-one", name: "Model One" }], current: Option.some("acme/model-one"), note: "A note." } }),
    ),
    expect(role("menuitem", { name: "Model One" })).toHaveAttr("aria-current", "true"),
  )
})

test("a failure that pairing cannot mend shows no Pair button", () => {
  scene(
    { update, view },
    given({ ...start, bridge: Bridge.Watching({ fleet: { ...fleet, terminals: [opencode] } }) }),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()], [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })]),
    Subscription.emit(Message.ReceivedModel({ address: "t1", model: Option.some("acme/model-one") })),
    click(role("button", { name: "model: model-one; pick another" })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    Command.resolve(SaveRecent, Message.CompletedSaveRecent()),
    Command.resolve(ListModelChoices, Message.FailedModelChoices({ address: "t1", failure: new BridgeError({ kind: "remote", message: "on another machine" }) })),
    expect(selector(".model-menu")).toContainText("on another machine"),
    expect(role("button", { name: "Pair" })).not.toExist(),
  )
})
