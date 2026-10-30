// The settings page: this browser's fonts, text sizes and agent list.
import { Array, Option, Result, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { FontCatalog, Message, type Model } from "./model.ts"
import { AgentList, fontStack, MAX_SIZE, MIN_SIZE, Surface, type TextStyle } from "./settings.ts"

export const settingsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("workspace settings")],
    [
      h.h2([], ["Settings"]),
      h.p([h.Class("note")], ["This browser keeps its own settings, so a phone and a desk can differ."]),
      textStyleView("chat", model.settings.chat, model, h),
      textStyleView("terminal", model.settings.terminal, model, h),
      agentListView(model.settings.agents, h),
      ...FontCatalog.match(model.fontCatalog, {
        Loading: () => [h.p([h.Class("note")], ["Asking the bridge for its fonts…"])],
        Loaded: () => [],
        Failed: ({ reason }) => [h.p([h.Class("note error")], [`The bridge's fonts are not available: ${reason}`])],
      }),
    ],
  )

const AGENT_LIST_TEXT = { below: "Below the spaces", nested: "Under each space" } satisfies Record<AgentList, string>

const agentListView = (agents: AgentList, h: HtmlBuilder<Message>): Html =>
  h.fieldset(
    [h.Class("setting choices")],
    [
      h.legend([], ["Sidebar agents"]),
      ...Array.map(AgentList.literals, (choice) =>
        h.label(
          [],
          [
            h.input([
              h.Type("radio"),
              h.Name("agents"),
              h.Value(choice),
              h.Checked(choice === agents),
              // A browser fires click on a radio for a key press too.
              h.OnClick(Message.PickedAgentList({ agents: choice })),
            ]),
            AGENT_LIST_TEXT[choice],
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
