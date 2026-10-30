import { Option } from "effect"
import { all, click, Command, expect, expectAll, given, Mount, role, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Layout, Terminal } from "../shared/Fleet.ts"
import { SaveRecent, SaveSelection, SaveZoom } from "./commands.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { LiveTerminal } from "./terminal.ts"

const shell: Terminal = {
  address: "t2",
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  status: Option.none(),
  foreground: Option.some({ name: "zsh", pid: 2, argv: ["zsh"] }),
  labels: {},
  status_ms: Option.none(),
  created_ms: 0,
  records: Option.none(),
  parent: Option.none(),
  cols: 80,
  rows: 24,
}

const claude: Terminal = {
  ...shell,
  address: "t1",
  foreground: Option.some({ name: "claude", pid: 1, argv: ["claude"] }),
  status: Option.some({ state: "idle", app: Option.some("claude-code"), msg: Option.none(), kind: Option.none(), progress: Option.none() }),
}

const block = (terminal: string): Layout =>
  ({ _tag: "Block", type: "block", id: `p-${terminal}`, size: Option.none(), content: { _tag: "Terminal", terminal } })

const fleet: Fleet = {
  connected: true,
  git: {},
  terminals: [claude, shell],
  machines: [
    {
      name: "here",
      isLocal: true,
      state: "connected",
      spaces: [
        {
          id: "s1",
          name: "work",
          folder: "/",
          tabs: [{ id: "a", name: "", root: { _tag: "Split", type: "row", id: "r", size: Option.none(), children: [block("t1"), block("t2")] } }],
        },
      ],
    },
  ],
}

const remembered = Selection.Tab({ tabId: "a", maybeFocus: Option.some("t1") })

test("a pane shows its terminal first, and only an agent's pane offers a chat, with the prompt inside it", () => {
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: remembered, sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false }).model, bridge: Bridge.Watching({ fleet }) }),
    Mount.resolveAll(
      [KeepTypingFocus, Message.CompletedKeepTypingFocus()],
      [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })],
      [LiveTerminal, Message.ChangedLink({ address: "t2", link: { _tag: "Live" } })],
    ),
    expectAll(all.selector(".terminal")).toHaveCount(2),
    expect(role("textbox", { name: "Prompt" })).not.toExist(),
    expectAll(all.role("button", { name: "chat" })).toHaveCount(1),
    click(role("button", { name: "chat" })),
    // The chat takes the terminal's place, which lets go of it.
    Mount.expectEnded(LiveTerminal),
    expect(selector(".chat-view .prompt")).toExist(),
    expectAll(all.selector(".terminal")).toHaveCount(1),
  )
})

test("a reload opens on the remembered tab, and waits for the bridge to show it", () => {
  const { model } = init({ settings: DEFAULT_SETTINGS, selection: remembered, sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false })
  scene({ update, view }, given(model), expect(selector(".workspace")).toContainText("Waiting for the bridge."), expect(selector(".fleet")).toHaveClass("folded"))
})

test("zoom fills the window with the pane whose button was clicked, and the page remembers it", () => {
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: remembered, sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false }).model, bridge: Bridge.Watching({ fleet }) }),
    Mount.resolveAll(
      [KeepTypingFocus, Message.CompletedKeepTypingFocus()],
      [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })],
      [LiveTerminal, Message.ChangedLink({ address: "t2", link: { _tag: "Live" } })],
    ),
    expect(selector(".app.zoomed")).not.toExist(),
    click(selector(".pane:not(.focused) .zoom-chip")),
    Command.expectHas(SaveZoom({ isZoomed: true })),
    Command.resolveAll([SaveZoom, Message.CompletedSaveZoom()], [SaveSelection, Message.CompletedSaveSelection()], [SaveRecent, Message.CompletedSaveRecent()]),
    expect(selector(".app.zoomed")).toExist(),
    // The click reaches the pane head too, so the zoomed pane is the one clicked.
    expect(selector(".pane.focused .name")).toHaveText("zsh"),
    expect(role("button", { name: "zoom", pressed: true })).toExist(),
    click(selector(".pane.focused .zoom-chip")),
    Command.expectExact(SaveZoom({ isZoomed: false })),
    Command.resolve(SaveZoom, Message.CompletedSaveZoom()),
    expect(selector(".app.zoomed")).not.toExist(),
  )
})
