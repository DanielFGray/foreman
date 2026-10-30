import { Option } from "effect"
import { click, Command, expect, given, Mount, role, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { init, Message, PressKeys, Selection, update, view } from "./main.ts"
import { KeepTypingFocus } from "./keys.ts"
import { LiveTerminal } from "./terminal.ts"

const focused = { ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none() }).model, selection: Selection.Loose({ address: "t7" }) }

test("ctrl and alt stay armed for the next soft key, then let go", () => {
  scene(
    { update, view },
    given(focused),
    Mount.resolveAll(
      [KeepTypingFocus, Message.CompletedKeepTypingFocus()],
      [LiveTerminal, Message.ChangedLink({ address: "t7", link: { _tag: "Live" } })],
    ),
    click(role("button", { name: "ctrl" })),
    click(role("button", { name: "alt" })),
    expect(role("button", { name: "ctrl", pressed: true })).toExist(),
    // A key typed into the focused terminal now takes them too.
    expect(selector(".terminal")).toHaveAttr("data-modifiers", "ctrl alt"),
    click(role("button", { name: "left" })),
    Command.expectExact(PressKeys({ address: "t7", keys: ["ctrl+alt+left"] })),
    Command.resolve(PressKeys, Message.SucceededPressKeys({ address: "t7" })),
    expect(role("button", { name: "ctrl", pressed: false })).toExist(),
    expect(selector(".terminal")).toHaveAttr("data-modifiers", ""),
    click(role("button", { name: "tab" })),
    Command.expectExact(PressKeys({ address: "t7", keys: ["tab"] })),
    Command.resolve(PressKeys, Message.SucceededPressKeys({ address: "t7" })),
  )
})
