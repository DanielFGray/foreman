import { Option } from "effect"
import { click, Command, expect, given, keydown, Mount, placeholder, role, scene, selector, submit, type } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Layout } from "../shared/Fleet.ts"
import { CloseSpace, FocusField, NewSpace, RenameSpace, SaveSelection } from "./commands.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { LiveTerminal } from "./terminal.ts"

const block = (terminal: string): Layout =>
  ({ _tag: "Block", type: "block", id: `p-${terminal}`, size: Option.none(), content: { _tag: "Terminal", terminal } })

const fleet: Fleet = {
  connected: true,
  git: {},
  terminals: [],
  machines: [
    { name: "here", isLocal: true, state: "connected", spaces: [{ id: "s1", name: "work", folder: "/src/work", tabs: [{ id: "a", name: "a", root: block("t1") }, { id: "b", name: "b", root: block("t2") }] }] },
    { name: "cynic", isLocal: false, state: "connected", spaces: [] },
  ],
}

const start = (selection: Selection) => ({
  ...init({ settings: DEFAULT_SETTINGS, selection, sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [] }).model,
  bridge: Bridge.Watching({ fleet }),
})

const mounts = Mount.resolveAll(
  [KeepTypingFocus, Message.CompletedKeepTypingFocus()],
  [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })],
)

test("a space is renamed in the tab bar: Escape keeps the old name, Enter sends the new one", () => {
  scene(
    { update, view },
    given(start(Selection.Tab({ tabId: "a", maybeFocus: Option.none() }))),
    mounts,
    click(role("button", { name: "rename space work" })),
    Command.resolve(FocusField, Message.CompletedFocusField()),
    expect(role("textbox", { name: "new name for work" })).toHaveValue("work"),
    keydown(role("textbox", { name: "new name for work" }), "Escape"),
    expect(selector(".space-name")).toHaveText("work"),
    click(role("button", { name: "rename space work" })),
    Command.resolve(FocusField, Message.CompletedFocusField()),
    type(role("textbox", { name: "new name for work" }), "api"),
    submit(selector(".space-rename")),
    Command.expectExact(RenameSpace({ space: "s1", name: "api" })),
    Command.resolve(RenameSpace, Message.SucceededSpaceChange()),
  )
})

test("closing the shown space says what it ends, asks first, and then shows nothing", () => {
  scene(
    { update, view },
    given(start(Selection.Tab({ tabId: "a", maybeFocus: Option.none() }))),
    mounts,
    click(role("button", { name: "close space work" })),
    expect(selector(".space-closing")).toHaveText("Ends 2 tabs and 2 terminals."),
    click(role("button", { name: "close the space and end its programs" })),
    Command.expectExact(CloseSpace({ space: "s1" }), SaveSelection({ selection: Selection.Nothing() })),
    Command.resolve(CloseSpace, Message.SucceededSpaceChange()),
    Mount.expectEnded(LiveTerminal),
    Mount.expectEnded(KeepTypingFocus),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    expect(selector(".workspace")).toHaveText("Pick a tab or an agent."),
  )
})

test("the new-space form opens a space on the chosen machine and then shows its tab", () => {
  scene(
    { update, view },
    given(start(Selection.Nothing())),
    click(role("button", { name: "New space" })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    Command.resolve(FocusField, Message.CompletedFocusField()),
    // Two machines, so the form asks which.
    expect(selector("select")).toExist(),
    type(placeholder("such as ~/src/project; empty: the home folder"), " ~/src/demo "),
    type(placeholder("such as claude; empty: a shell"), " claude "),
    submit(selector(".space-form")),
    Command.expectExact(NewSpace({ machine: Option.none(), folder: "~/src/demo", name: "", program: Option.some("claude") })),
    expect(role("button", { name: "Opening…" })).toExist(),
    Command.resolve(NewSpace, Message.SucceededNewSpace({ tab: "tb9" })),
    Command.expectExact(SaveSelection({ selection: Selection.Tab({ tabId: "tb9", maybeFocus: Option.none() }) })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
  )
})
