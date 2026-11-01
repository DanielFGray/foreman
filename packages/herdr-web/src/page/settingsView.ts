// The settings page: this browser's fonts, text sizes, agent list, the view agents open in, the soft key row, and its push alerts.
import { Array, Option, Result, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AlertEvent, DEFAULT_ALERT_EVENTS } from "../shared/Push.ts"
import { Alerts, FontCatalog, Message, type Model } from "./model.ts"
import { AgentList, AgentView, fontStack, KeyRow, MAX_SIZE, MIN_SIZE, Surface, type TextStyle } from "./settings.ts"

export const settingsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("workspace settings")],
    [
      h.h2([], ["Settings"]),
      h.p([h.Class("note")], ["This browser keeps its own settings, so a phone and a desk can differ."]),
      textStyleView("chat", model.settings.chat, model, h),
      textStyleView("terminal", model.settings.terminal, model, h),
      choicesView({ legend: "Sidebar agents", choices: AgentList.literals, text: AGENT_LIST_TEXT, current: model.settings.agents, picked: (agents) => Message.PickedAgentList({ agents }) }, h),
      choicesView(
        { legend: "Agent panes open as", choices: AgentView.literals, text: AGENT_VIEW_TEXT, current: model.settings.agentView, picked: (agentView) => Message.PickedAgentView({ agentView }) },
        h,
      ),
      h.p([h.Class("note")], ["A pane on screen keeps its view; this applies when a pane comes on screen."]),
      choicesView({ legend: "Soft keys on a phone", choices: KeyRow.literals, text: KEY_ROW_TEXT, current: model.settings.keyRow, picked: (keyRow) => Message.PickedKeyRow({ keyRow }) }, h),
      alertsView(model, h),
      ...FontCatalog.match(model.fontCatalog, {
        Loading: () => [h.p([h.Class("note")], ["Asking the bridge for its fonts…"])],
        Loaded: () => [],
        Failed: ({ reason }) => [h.p([h.Class("note error")], [`The bridge's fonts are not available: ${reason}`])],
      }),
    ],
  )

const AGENT_LIST_TEXT = { below: "Below the spaces", nested: "Under each space" } satisfies Record<AgentList, string>

const KEY_ROW_TEXT = { scroll: "One row that scrolls sideways", wrap: "Wrapped onto more lines" } satisfies Record<KeyRow, string>

const AGENT_VIEW_TEXT = {
  run: "The view last picked for that agent",
  space: "The view last picked in its space",
  chat: "Always the chat",
} satisfies Record<AgentView, string>

/** A setting with a few named choices, as radio buttons. */
const choicesView = <A extends string>(
  { legend, choices, text, current, picked }: Readonly<{ legend: string; choices: ReadonlyArray<A>; text: Record<A, string>; current: A; picked: (choice: A) => Message }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.fieldset(
    [h.Class("setting choices")],
    [
      h.legend([], [legend]),
      ...Array.map(choices, (choice) =>
        h.label(
          [],
          [
            h.input([
              h.Type("radio"),
              h.Name(legend),
              h.Value(choice),
              h.Checked(choice === current),
              // A browser fires click on a radio for a key press too.
              h.OnClick(picked(choice)),
            ]),
            text[choice],
          ],
        ),
      ),
    ],
  )

const SURFACE_TEXT = {
  chat: { title: "Chat", sample: "Fixed the login bug — 3 files changed, tests pass.", fallback: "the page's font" },
  terminal: { title: "Terminal", sample: "$ ls -la ~/build  {} [] => 0O 1lI", fallback: "the browser's monospace" },
} satisfies Record<Surface, Readonly<{ title: string; sample: string; fallback: string }>>

/** A surface's font and size; a terminal offers only monospaced fonts. */
const textStyleView = (surface: Surface, { font, size }: TextStyle, model: Model, h: HtmlBuilder<Message>): Html => {
  const { title, sample, fallback } = SURFACE_TEXT[surface]
  const offered = FontCatalog.match(model.fontCatalog, {
    Loading: () => [],
    Loaded: ({ families }) =>
      Array.filterMap(families, ({ name, isMono }) => (surface === "terminal" && !isMono ? Result.failVoid : Result.succeed(name))),
    Failed: () => [],
  })
  // The chosen font stays in the list while the catalog loads, or if the bridge stops serving it.
  const names = Array.dedupe([...Option.toArray(font), ...offered])
  return h.fieldset(
    [h.Class("setting")],
    [
      h.legend([], [title]),
      h.label([h.For(`${surface}-font`)], ["Font"]),
      h.select(
        [
          h.Id(`${surface}-font`),
          h.OnChange((value) => Message.PickedFont({ surface, font: Option.liftPredicate(value, String.isNonEmpty) })),
        ],
        [
          h.option([h.Value(""), h.Selected(Option.isNone(font))], [fallback]),
          ...Array.map(names, (name) => h.option([h.Value(name), h.Selected(Option.contains(font, name))], [name])),
        ],
      ),
      h.span([h.Class("size-label")], ["Size"]),
      h.div(
        [h.Class("size")],
        [
          h.button(
            [h.Type("button"), h.Class("chip"), h.AriaLabel(`smaller ${surface} text`), h.Disabled(size <= MIN_SIZE), h.OnClick(Message.SteppedSize({ surface, step: -1 }))],
            ["−"],
          ),
          h.span([], [`${size}px`]),
          h.button(
            [h.Type("button"), h.Class("chip"), h.AriaLabel(`larger ${surface} text`), h.Disabled(size >= MAX_SIZE), h.OnClick(Message.SteppedSize({ surface, step: 1 }))],
            ["+"],
          ),
        ],
      ),
      h.p(
        [h.Class("sample"), h.Style({ "font-family": fontStack(surface, font), "font-size": `${size}px` })],
        [sample],
      ),
    ],
  )
}

/** Push alerts on this device: whether it can have them, the switch, a test, and the events it is told of. */
const alertsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const button = (label: string, message: Message) => h.button([h.Type("button"), h.Class("chip"), h.OnClick(message)], [label])
  return h.fieldset(
    [h.Class("setting alerts")],
    [
      h.legend([], ["Alerts on this device"]),
      ...Alerts.match(model.alerts, {
        Checking: () => [h.p([h.Class("note")], ["Asking the browser…"])],
        Unavailable: ({ reason }) => [h.p([h.Class("note")], [`No alerts here: ${reason}.`])],
        Off: () => [h.div([h.Class("alert-actions")], [button("Turn on alerts", Message.ClickedAlertsOn())])],
        Blocked: () => [h.p([h.Class("note")], ["This browser blocks alerts from the page. Allow them in its settings for this site, then reload."])],
        On: () => [h.div([h.Class("alert-actions")], [button("Send a test alert", Message.ClickedTestAlert()), button("Turn off", Message.ClickedAlertsOff())])],
      }),
      ...Option.toArray(Option.map(model.alertNote, (note) => h.p([h.Class("note")], [note]))),
      // The events on by default first, then the busy baseline.
      ...Array.map([...DEFAULT_ALERT_EVENTS, ...Array.difference(AlertEvent.literals, DEFAULT_ALERT_EVENTS)], (event) =>
        h.label(
          [],
          [h.input([h.Type("checkbox"), h.Checked(Array.contains(model.settings.alerts, event)), h.OnClick(Message.ToggledAlertEvent({ event }))]), ALERT_EVENT_TEXT[event]],
        ),
      ),
      h.p([h.Class("note")], ["An alert waits 10 seconds, and none comes while a herdr page is in front and focused somewhere."]),
    ],
  )
}

const ALERT_EVENT_TEXT = {
  blocked: "An agent waits for you",
  done: "An agent finished",
  error: "An agent failed",
  ended: "An agent's terminal ended",
  working: "An agent started working",
  idle: "An agent went idle",
} satisfies Record<AlertEvent, string>
