import { Option } from "effect"
import { expect, given, Mount, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { LiveTerminal } from "./terminal.ts"

const editor: Terminal = {
  address: "t1",
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  status: Option.none(),
  foreground: Option.some({ name: "nvim", pid: 1, argv: ["nvim", "notes.md"] }),
  labels: {},
  status_ms: Option.none(),
  created_ms: 0,
  records: Option.none(),
  parent: Option.none(),
  cols: 80,
  rows: 24,
}

const fleet: Fleet = {
  connected: true,
  git: {},
  terminals: [editor],
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
          tabs: [{ id: "a", name: "", root: { _tag: "Block", type: "block", id: "p1", size: Option.none(), content: { _tag: "Terminal", terminal: "t1" } } }],
        },
      ],
    },
  ],
}

test("a pane running an editor shows the editor's name and icon in its head", () => {
  scene(
    { update, view },
    given({
      ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.some("t1") }), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, chatRuns: [] }).model,
      bridge: Bridge.Watching({ fleet }),
    }),
    Mount.resolveAll(
      [KeepTypingFocus, Message.CompletedKeepTypingFocus()],
      [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })],
    ),
    expect(selector(".pane-head .name")).toContainText("Neovim"),
    expect(selector(".pane-head svg.icon")).toExist(),
  )
})
