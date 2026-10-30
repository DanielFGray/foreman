// @vitest-environment happy-dom
import { Option } from "effect"
import { all, click, Command, expect, expectAll, given, keydown, Mount, role, scene, selector, Subscription, type } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
import { FetchFonts, FocusField, SaveRecent, SaveSelection } from "./commands.ts"
import { PALETTE_INPUT_ID } from "./palette.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { KeepTypingFocus } from "./keys.ts"
import { LiveTerminal } from "./terminal.ts"

const agent: Terminal = {
  address: "t1",
  name: Option.some("claude"),
  title: Option.none(),
  cwd: "/home/dan/build/prog",
  state: "live",
  status: Option.some({ state: "idle", app: Option.some("claude-code"), msg: Option.none(), kind: Option.none(), progress: Option.none() }),
  foreground: Option.none(),
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
  git: { s2: { branch: Option.some("feat/login"), changed: false } },
  terminals: [agent],
  machines: [
    {
      name: "here",
      isLocal: true,
      state: "connected",
      spaces: [
        {
          id: "s1",
          name: "",
          folder: "/home/dan/build/prog",
          tabs: [
            { id: "b", name: "notes", root: { _tag: "Unknown", type: "browser" } },
            { id: "a", name: "", root: { _tag: "Block", type: "block", id: "p1", size: Option.none(), content: { _tag: "Terminal", terminal: "t1" } } },
          ],
        },
        { id: "s2", name: "quiet", folder: "/srv/web", tabs: [{ id: "c", name: "logs", root: { _tag: "Unknown", type: "browser" } }] },
      ],
    },
  ],
}

const start = {
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [] }).model,
  bridge: Bridge.Watching({ fleet }),
}

const box = role("combobox", { name: "Search spaces, tabs, panes, agents and settings" })

test("Ctrl+K opens the palette and again closes it", () => {
  scene(
    { update, view },
    given(start),
    expect(role("dialog", { name: "Command palette" })).not.toExist(),
    Subscription.emit(Message.PressedPaletteKey()),
    Command.expectExact(FocusField({ id: PALETTE_INPUT_ID })),
    Command.resolve(FocusField, Message.CompletedFocusField()),
    expect(role("dialog", { name: "Command palette" })).toExist(),
    expectAll(all.role("option")).toHaveCount(10),
    Subscription.emit(Message.PressedPaletteKey()),
    expect(role("dialog", { name: "Command palette" })).not.toExist(),
  )
})

test("arrow keys move over the results that match, and Enter opens the one reached", () => {
  scene(
    { update, view },
    given(start),
    Subscription.emit(Message.PressedPaletteKey()),
    Command.resolve(FocusField, Message.CompletedFocusField()),
    type(box, "srv"),
    expectAll(all.role("option")).toHaveCount(2),
    expect(role("option", { name: /^quiet/ })).toHaveAttr("aria-selected", "true"),
    keydown(box, "ArrowDown"),
    expect(role("option", { name: /^logs/ })).toHaveAttr("aria-selected", "true"),
    keydown(box, "Enter"),
    Command.expectExact(SaveSelection({ selection: Selection.Tab({ tabId: "c", maybeFocus: Option.none() }) })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    expect(role("dialog", { name: "Command palette" })).not.toExist(),
  )
})

test("a pane opened from the palette is kept as recent, and Escape closes the palette", () => {
  scene(
    { update, view },
    given({ ...start, palette: { _tag: "Open", query: "claude", highlighted: 0 } }),
    expect(role("option", { name: /^claude/ })).toExist(),
    click(role("option", { name: /^claude/ })),
    Command.expectHas(SaveRecent({ recent: ["t1"] })),
    Command.resolve(SaveRecent, Message.CompletedSaveRecent()),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    Mount.resolveAll(
      [KeepTypingFocus, Message.CompletedKeepTypingFocus()],
      [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })],
    ),
    Subscription.emit(Message.PressedPaletteKey()),
    Command.resolve(FocusField, Message.CompletedFocusField()),
    // The recent pane heads the empty search.
    expect(selector(".palette-group")).toContainText("Recent"),
    expect(role("option", { name: /^claude/ })).toExist(),
    keydown(box, "Escape"),
    expect(role("dialog", { name: "Command palette" })).not.toExist(),
  )
})

test("a setting is found by a word a user would try, and opens the settings", () => {
  scene(
    { update, view },
    given({ ...start, palette: { _tag: "Open", query: "font", highlighted: 0 } }),
    expectAll(all.role("option")).toHaveCount(3),
    click(role("option", { name: /^Terminal font/ })),
    Command.expectHas(SaveSelection({ selection: Selection.Settings() })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    Command.resolve(FetchFonts, Message.ReceivedFonts({ families: [] })),
  )
})

test("a space is found by its git branch", () => {
  scene(
    { update, view },
    given(start),
    Subscription.emit(Message.PressedPaletteKey()),
    Command.resolve(FocusField, Message.CompletedFocusField()),
    type(box, "login"),
    expectAll(all.role("option")).toHaveCount(1),
    expect(role("option", { name: /^quiet/ })).toContainText("feat/login"),
  )
})
