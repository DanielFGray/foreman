import { Option } from "effect"
import { all, click, Command, change, expect, expectAll, given, inside, label, role, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import { FetchFonts, init, Message, SaveSettings, update, view } from "./main.ts"
import { DEFAULT_SETTINGS, MAX_SIZE } from "./settings.ts"

const families = [
  { name: "Cascadia Code", isMono: true },
  { name: "DejaVu Sans", isMono: false },
]

const terminalSettings = (font: Option.Option<string>, size: number) => ({
  ...DEFAULT_SETTINGS,
  terminal: { font, size },
})

test("settings offer the bridge's fonts, and a terminal only the monospaced ones", () => {
  scene(
    { update, view },
    given(init(DEFAULT_SETTINGS).model),
    click(role("button", { name: "settings" })),
    expect(selector(".settings")).toContainText("Asking the bridge for its fonts"),
    Command.expectExact(FetchFonts),
    Command.resolve(FetchFonts, Message.ReceivedFonts({ families })),
    // The fallback, then the fonts.
    expectAll(all.selector("#chat-font option")).toHaveCount(3),
    expectAll(all.selector("#terminal-font option")).toHaveCount(2),
    change(selector("#terminal-font"), "Cascadia Code"),
    Command.expectExact(SaveSettings({ settings: terminalSettings(Option.some("Cascadia Code"), 13) })),
    Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
    inside(
      role("group", { name: "Terminal" }),
      expect(selector(".sample")).toHaveStyle("font-family", '"Cascadia Code", ui-monospace, monospace'),
    ),
  )
})

test("a size steps from the current settings and stops at its limit", () => {
  scene(
    { update, view },
    given({ ...init(terminalSettings(Option.none(), MAX_SIZE - 1)).model, isSettingsOpen: true }),
    click(role("button", { name: "larger terminal text" })),
    Command.expectExact(SaveSettings({ settings: terminalSettings(Option.none(), MAX_SIZE) })),
    Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
    expect(role("button", { name: "larger terminal text" })).toBeDisabled(),
    expect(label("Font")).toExist(),
  )
})
