// The command palette: a dialog over the page with a search box and the
// results listed under their groups.
import { Array, Match, Option, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icons.ts"
import { Message, type Model, Palette } from "./model.ts"
import { PALETTE_INPUT_ID, type PaletteResult } from "./palette.ts"
import { lastFleet } from "./selection.ts"
import { searchPalette } from "./palette.ts"

const LIST_ID = "palette-list"
const optionId = (key: string) => `palette-option-${key}`

/** The results the open palette lists; none while it is shut. */
export const paletteResults = (model: Model): ReadonlyArray<PaletteResult> =>
  Palette.match(model.palette, {
    Closed: () => [],
    Open: ({ query }) => searchPalette(lastFleet(model.bridge), model.recent, query),
  })

/** The palette over the page while it is open, else nothing. */
export const paletteView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Palette.match<ReadonlyArray<Html>>(model.palette, {
    Closed: () => [],
    Open: ({ query, highlighted }) => {
      const results = paletteResults(model)
      const active = Array.get(results, highlighted)
      return [
        h.div([h.Class("palette-backdrop"), h.OnClick(Message.ClosedPalette())], []),
        h.div(
          [h.Class("palette"), h.Role("dialog"), h.AriaModal(true), h.AriaLabel("Command palette")],
          [
            h.input([
              h.Id(PALETTE_INPUT_ID),
              h.Class("palette-input"),
              h.Type("text"),
              h.Role("combobox"),
              h.AriaLabel("Search spaces, tabs, panes, agents and settings"),
              h.AriaExpanded(true),
              h.AriaControls(LIST_ID),
              h.AriaAutocomplete("list"),
              h.AriaActiveDescendant(Option.match(active, { onNone: () => "", onSome: ({ key }) => optionId(key) })),
              h.Autocomplete("off"),
              h.Spellcheck(false),
              h.Placeholder("Search spaces, tabs, panes, agents, settings"),
              h.Value(query),
              h.OnInput((text) => Message.UpdatedPaletteQuery({ text })),
              h.OnKeyDownPreventDefault(keyed),
            ]),
            h.ul(
              [h.Id(LIST_ID), h.Class("palette-list"), h.Role("listbox"), h.AriaLabel("Results")],
              Array.isReadonlyArrayEmpty(results)
                ? [h.li([h.Class("palette-empty"), h.Role("presentation")], ["Nothing matches."])]
                : Array.flatMap(results, (result, index) => resultView(result, index === highlighted, Array.get(results, index - 1), h)),
            ),
          ],
        ),
      ]
    },
  })

const keyed = (key: string) =>
  Match.value(key).pipe(
    Match.when("ArrowDown", () => Option.some(Message.MovedPaletteHighlight({ step: 1 }))),
    Match.when("ArrowUp", () => Option.some(Message.MovedPaletteHighlight({ step: -1 }))),
    Match.when("Enter", () => Option.some(Message.SubmittedPalette())),
    Match.when("Escape", () => Option.some(Message.ClosedPalette())),
    Match.orElse(() => Option.none()),
  )

// A heading starts each group; the listbox holds only options, so the heading is presentational text.
const resultView = (result: PaletteResult, isHighlighted: boolean, before: Option.Option<PaletteResult>, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  ...(Option.exists(before, (previous) => previous.group === result.group)
    ? []
    : [h.keyed("li")(`head/${result.group}`, [h.Class("palette-group"), h.Role("presentation")], [result.group])]),
  h.keyed("li")(
    result.key,
    [
      h.Id(optionId(result.key)),
      h.Class(isHighlighted ? "palette-option on" : "palette-option"),
      h.Role("option"),
      h.AriaSelected(isHighlighted),
      h.OnClick(Message.OpenedPaletteResult({ target: result.target })),
    ],
    [
      icon(result.icon, h),
      h.span([h.Class("name")], [result.title]),
      ...(String.isEmpty(result.detail) ? [] : [h.span([h.Class("msg")], [result.detail])]),
    ],
  ),
]
