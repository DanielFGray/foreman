import { Option } from "effect"
import { all, click, Command, expect, expectAll, given, Mount, role, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Layout, Terminal } from "../shared/Fleet.ts"
import { CloseTab, NewTab, SaveSelection } from "./commands.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { LiveTerminal } from "./terminal.ts"

const agent: Terminal = {
  address: "t1",
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  status: Option.some({ state: "working", app: Option.some("claude-code"), msg: Option.none(), kind: Option.none(), progress: Option.none() }),
  foreground: Option.some({ name: "claude", pid: 1, argv: [] }),
  labels: {},
  status_ms: Option.none(),
  created_ms: 0,
  records: Option.none(),
  parent: Option.none(),
  cols: 80,
  rows: 24,
}

const block = (terminal: string): Layout =>
  ({ _tag: "Block", type: "block", id: `p-${terminal}`, size: Option.none(), content: { _tag: "Terminal", terminal } })

const fleetOf = (tabIds: ReadonlyArray<string>): Fleet => ({
  connected: true,
  git: {},
  terminals: [agent],
  machines: [
    {
      name: "here",
      isLocal: true,
      state: "connected",
      spaces: [{ id: "s1", name: "work", folder: "/", tabs: tabIds.map((id) => ({ id, name: id, root: block("t1") })) }],
    },
  ],
})

const start = (fleet: Fleet) => ({
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.none() }), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [] }).model,
  bridge: Bridge.Watching({ fleet }),
})

const mounts = Mount.resolveAll(
  [KeepTypingFocus, Message.CompletedKeepTypingFocus()],
  [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })],
)

test("a working agent's tab spins, and closing the shown tab asks first, ends it, and shows the next", () => {
  scene(
    { update, view },
    given(start(fleetOf(["a", "b"]))),
    mounts,
    expectAll(all.selector(".tab .spinner")).toHaveCount(2),
    expectAll(all.selector(".tab .dot")).toHaveCount(0),
    // The program's icon, then the name.
    expectAll(all.selector(".tab svg.icon")).toHaveCount(2),
    click(role("button", { name: "close tab a" })),
    expect(role("button", { name: "close the tab and end its programs" })).toExist(),
    click(role("button", { name: "keep the tab" })),
    expect(role("button", { name: "close the tab and end its programs" })).not.toExist(),
    click(role("button", { name: "close tab a" })),
    click(role("button", { name: "close the tab and end its programs" })),
    Command.expectExact(CloseTab({ tab: "a" }), SaveSelection({ selection: Selection.Tab({ tabId: "b", maybeFocus: Option.none() }) })),
    Command.resolve(CloseTab, Message.SucceededCloseTab()),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    expect(selector(".tab.on")).toHaveText("b"),
  )
})

test("the last tab of a space has no ×", () => {
  scene(
    { update, view },
    given(start(fleetOf(["a"]))),
    mounts,
    expect(role("button", { name: "close tab a" })).not.toExist(),
    expect(selector(".tab-new")).toExist(),
  )
})

test("the + opens a tab in the shown space and shows it", () => {
  scene(
    { update, view },
    given(start(fleetOf(["a", "b"]))),
    mounts,
    click(role("button", { name: "new tab" })),
    Command.expectExact(NewTab({ space: "s1" })),
    Command.resolve(NewTab, Message.SucceededNewTab({ tab: "c" })),
    Command.expectExact(SaveSelection({ selection: Selection.Tab({ tabId: "c", maybeFocus: Option.none() }) })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    // The fleet does not list the new tab yet, so the old one leaves the screen.
    Mount.expectEnded(LiveTerminal),
    Mount.expectEnded(KeepTypingFocus),
  )
})
