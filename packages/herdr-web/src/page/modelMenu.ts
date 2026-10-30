// The model tag over an agent's prompt, and its menu of the models the agent
// may switch to. The menu reads the choices from the bridge each time it
// opens, since an agent's choices can change: OpenCode's follow the user's
// providers.
import { Array, Option, Record } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import type { BridgeError } from "../shared/Api.ts"
import { modelName } from "../shared/Chat.ts"
import type { ModelChoices } from "../shared/Harness.ts"
import { ListModelChoices } from "./commands.ts"
import { ChoiceList, Message, type Model, PaneAction, type UpdateReturn } from "./model.ts"
import { pairView } from "./pairing.ts"

/** A click on the tag opens its menu and reads the choices; a second click closes it. */
export const clickedModelTag = (model: Model, address: string): UpdateReturn =>
  isPickingModel(model, address)
    ? { model: modifyFields(model, { paneAction: () => PaneAction.Idle() }) }
    : { model: modifyFields(model, { paneAction: () => PaneAction.PickingModel({ address, choices: ChoiceList.Loading() }) }), commands: [ListModelChoices({ address })] }

/** The choices read for the agent at `address`; ones read for a menu since closed are dropped. */
export const listedChoices = (model: Model, address: string, choices: ChoiceList): Model =>
  modifyFields(model, { paneAction: (action) => (action._tag === "PickingModel" && action.address === address ? PaneAction.PickingModel({ address, choices }) : action) })

/** The model the agent answers with, as a button that opens the menu. Its exact id shows on hover. */
export const modelTagView = (address: string, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.toArray(
    Option.map(Record.get(model.models, address), (id) =>
      h.button(
        [
          h.Type("button"),
          h.Class(isPickingModel(model, address) ? "model-tag on" : "model-tag"),
          h.Title(id),
          h.AriaLabel(`model: ${modelName(id)}; pick another`),
          h.AriaExpanded(isPickingModel(model, address)),
          h.OnClick(Message.ClickedModelTag({ address })),
        ],
        [modelName(id)],
      ),
    ),
  )

export const modelMenuView = (address: string, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  model.paneAction._tag !== "PickingModel" || model.paneAction.address !== address
    ? []
    : [
        h.div(
          [h.Class("model-menu"), h.Role("menu"), h.AriaLabel("models")],
          ChoiceList.match(model.paneAction.choices, {
            Loading: () => [h.span([h.Class("note")], ["Reading the models…"])],
            Listed: ({ choices }) => listView(address, choices, h),
            Unlisted: ({ failure }) => unlistedView(model, address, failure, h),
          }),
        ),
      ]

const listView = (address: string, { choices, current, note }: ModelChoices, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  ...Array.map(choices, ({ alias, name }) => {
    const isCurrent = Option.contains(current, alias)
    return h.button(
      [h.Type("button"), h.Class(isCurrent ? "chip on" : "chip"), h.Role("menuitem"), h.AriaCurrent(isCurrent ? "true" : "false"), h.OnClick(Message.PickedModel({ address, alias }))],
      [name],
    )
  }),
  h.span([h.Class("note")], [note]),
]

const unlistedView = (model: Model, address: string, failure: BridgeError, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.span([h.Class("note")], [`The models cannot be read: ${failure.message}`]),
  ...pairView(model, address, failure, h),
]

const isPickingModel = (model: Model, address: string) => model.paneAction._tag === "PickingModel" && model.paneAction.address === address
