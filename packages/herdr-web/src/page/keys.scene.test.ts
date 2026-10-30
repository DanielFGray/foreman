import { Option } from "effect"
import { click, Command, expect, given, Mount, placeholder, role, scene, selector, type } from "foldkit/scene"
import { test } from "vitest"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { ForgetSoftKeys, PressKeys, SaveSoftKeys } from "./commands.ts"
import { init, update, view } from "./main.ts"
import { Message, Selection } from "./model.ts"
import { DEFAULT_SOFT_KEYS, KeepTypingFocus } from "./keys.ts"
import { LiveTerminal } from "./terminal.ts"

const focused = { ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false }).model, selection: Selection.Loose({ address: "t7" }) }

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

test("the Send keys sheet sends any key with modifiers, pins it to the row, and the row is edited and restored", () => {
  scene(
    { update, view },
    given(focused),
    Mount.resolveAll(
      [KeepTypingFocus, Message.CompletedKeepTypingFocus()],
      [LiveTerminal, Message.ChangedLink({ address: "t7", link: { _tag: "Live" } })],
    ),
    click(role("button", { name: "more keys" })),
    click(role("button", { name: "F keys" })),
    click(role("button", { name: "key f5" })),
    click(role("button", { name: "with ctrl" })),
    expect(role("status", { name: "the key to send" })).toHaveText("ctrl+F5"),
    click(role("button", { name: "Send" })),
    Command.expectExact(PressKeys({ address: "t7", keys: ["ctrl+f5"] })),
    Command.resolve(PressKeys, Message.SucceededPressKeys({ address: "t7" })),
    // A capital is refused with how to send it.
    click(role("button", { name: "Character" })),
    type(placeholder("one character"), "R"),
    expect(role("status", { name: "the key to send" })).toHaveText("Type r and turn on Shift."),
    expect(role("button", { name: "Pin" })).toBeDisabled(),
    type(placeholder("one character"), "r"),
    click(role("button", { name: "Pin" })),
    Command.expectExact(SaveSoftKeys({ softKeys: [...DEFAULT_SOFT_KEYS, { _tag: "Press", key: "ctrl+r" }] })),
    Command.resolve(SaveSoftKeys, Message.CompletedSaveSoftKeys()),
    expect(role("button", { name: "ctrl+r" })).toHaveText("^R"),
    click(role("button", { name: "Edit the row" })),
    click(role("button", { name: "move ctrl+r earlier" })),
    Command.expectExact(SaveSoftKeys({ softKeys: [...DEFAULT_SOFT_KEYS.slice(0, 11), { _tag: "Press", key: "ctrl+r" }, { _tag: "Press", key: "n" }] })),
    Command.resolve(SaveSoftKeys, Message.CompletedSaveSoftKeys()),
    click(role("button", { name: "remove esc" })),
    Command.expectExact(SaveSoftKeys({ softKeys: [...DEFAULT_SOFT_KEYS.slice(1, 11), { _tag: "Press", key: "ctrl+r" }, { _tag: "Press", key: "n" }] })),
    Command.resolve(SaveSoftKeys, Message.CompletedSaveSoftKeys()),
    // Restoring forgets the row, so later defaults reach this browser too.
    click(role("button", { name: "Restore defaults" })),
    Command.expectExact(ForgetSoftKeys({})),
    Command.resolve(ForgetSoftKeys, Message.CompletedSaveSoftKeys()),
    expect(role("button", { name: "ctrl+r" })).not.toExist(),
    click(role("button", { name: "close the sheet" })),
    expect(role("dialog", { name: "Edit the soft keys" })).not.toExist(),
  )
})
