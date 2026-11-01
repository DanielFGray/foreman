import { Option, Schema as S } from "effect"
import { all, click, Command, change, expect, expectAll, given, inside, label, role, scene, selector } from "foldkit/scene"
import { expect as expectValue, test } from "vitest"
import { FetchFonts, SaveSelection, SaveSettings } from "./commands.ts"
import { init, update, view } from "./main.ts"
import { Alerts, Message, Selection } from "./model.ts"
import { SendTestAlert, SyncAlerts, TurnAlertsOff, TurnAlertsOn } from "./alerts.ts"
import { DEFAULT_ALERT_EVENTS } from "../shared/Push.ts"
import { DEFAULT_SETTINGS, MAX_SIZE, Settings } from "./settings.ts"

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
    given(init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [], openEpics: [] }).model),
    click(role("button", { name: "Settings" })),
    expect(selector(".fleet")).toHaveClass("folded"),
    expect(selector(".settings")).toContainText("Asking the bridge for its fonts"),
    // A reload opens on the settings again.
    Command.expectExact(FetchFonts, SaveSelection({ selection: Selection.Settings() })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
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
    given({ ...init({ settings: terminalSettings(Option.none(), MAX_SIZE - 1), selection: Selection.Settings(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [], openEpics: [] }).model }),
    click(role("button", { name: "larger terminal text" })),
    Command.expectExact(SaveSettings({ settings: terminalSettings(Option.none(), MAX_SIZE) })),
    Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
    expect(role("button", { name: "larger terminal text" })).toBeDisabled(),
    expect(label("Font")).toExist(),
  )
})

test("the agent choices save, and settings saved before they existed keep their fonts", () => {
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Settings(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [], openEpics: [] }).model }),
    click(label("Under each space")),
    Command.expectExact(SaveSettings({ settings: { ...DEFAULT_SETTINGS, agents: "nested" } })),
    Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
    expect(label("Under each space")).toBeChecked(),
    click(label("Always the chat")),
    Command.expectExact(SaveSettings({ settings: { ...DEFAULT_SETTINGS, agents: "nested", agentView: "chat" } })),
    Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
    expect(label("Always the chat")).toBeChecked(),
    click(label("Wrapped onto more lines")),
    Command.expectExact(SaveSettings({ settings: { ...DEFAULT_SETTINGS, agents: "nested", agentView: "chat", keyRow: "wrap" } })),
    Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
    expect(label("Wrapped onto more lines")).toBeChecked(),
  )
  const saved = { chat: { font: "Inter", size: 15 }, terminal: { font: null, size: 13 } }
  expectValue(S.decodeOption(Settings)(saved)).toEqual(
    Option.some({ chat: { font: Option.some("Inter"), size: 15 }, terminal: { font: Option.none(), size: 13 }, agents: "below", agentView: "run", keyRow: "scroll", alerts: DEFAULT_ALERT_EVENTS }),
  )
})

const device = { endpoint: "https://push.example/device-1", keys: { p256dh: "key", auth: "secret" } }

test("alerts turn on through the browser, and a device with alerts on tests them and gives the bridge its new events", () => {
  const opened = init({ settings: DEFAULT_SETTINGS, selection: Selection.Settings(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [], openEpics: [] }).model
  scene(
    { update, view },
    given({ ...opened, alerts: Alerts.Off() }),
    click(role("button", { name: "Turn on alerts" })),
    Command.expectExact(TurnAlertsOn({ events: DEFAULT_ALERT_EVENTS })),
    expect(selector(".alerts")).toContainText("Asking the browser"),
    Command.resolve(TurnAlertsOn, Message.GotAlerts({ alerts: Alerts.On({ subscription: device }), note: Option.none() })),
    click(role("button", { name: "Send a test alert" })),
    Command.expectExact(SendTestAlert({ subscription: device })),
    Command.resolve(SendTestAlert, Message.NotedAlerts({ note: "A test alert is on its way." })),
    expect(selector(".alerts")).toContainText("A test alert is on its way."),
    click(label("An agent went idle")),
    Command.expectExact(
      SaveSettings({ settings: { ...DEFAULT_SETTINGS, alerts: [...DEFAULT_ALERT_EVENTS, "idle"] } }),
      SyncAlerts({ subscription: device, events: [...DEFAULT_ALERT_EVENTS, "idle"] }),
    ),
    Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
    Command.resolve(SyncAlerts, Message.NotedAlerts({ note: "This device gets the alerts picked." })),
    click(role("button", { name: "Turn off" })),
    Command.expectExact(TurnAlertsOff({ subscription: device })),
    Command.resolve(TurnAlertsOff, Message.GotAlerts({ alerts: Alerts.Off(), note: Option.none() })),
    expect(role("button", { name: "Turn on alerts" })).toExist(),
  )
})
