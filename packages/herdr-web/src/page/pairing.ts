// Pairing the bridge with an agent's own server, from the page. A call that
// needs the server fails with kind `unpaired` until then; the note that shows
// that failure offers the Pair button, and a pairing that succeeds reads
// again what failed. The page keeps no word of whether the bridge is paired:
// the failure is that word, so a sign-in the server later refuses shows the
// button again.
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import type { BridgeError } from "../shared/Api.ts"
import { ListCommands, ListModelChoices, Pair } from "./commands.ts"
import { ChoiceList, CommandList, Message, type Model, Pairing, PaneAction, type UpdateReturn } from "./model.ts"
import { supportsAt } from "./selection.ts"

export const clickedPair = (model: Model, address: string): UpdateReturn =>
  model.pairing._tag === "Pairing" ? { model } : { model: modifyFields(model, { pairing: () => Pairing.Pairing({ address }) }), commands: [Pair({ address })] }

/** The bridge paired: the commands and the model choices of the agent, when they failed for want of it, are read again. */
export const succeededPair = (model: Model, address: string): UpdateReturn => {
  const isCommands = model.commandList._tag === "Unlisted" && model.commandList.address === address
  const isChoices = model.paneAction._tag === "PickingModel" && model.paneAction.address === address && model.paneAction.choices._tag === "Unlisted"
  return {
    model: modifyFields(model, {
      pairing: () => Pairing.Idle(),
      commandList: (list) => (isCommands ? CommandList.Loading({ address }) : list),
      paneAction: (action) => (isChoices ? PaneAction.PickingModel({ address, choices: ChoiceList.Loading() }) : action),
    }),
    commands: [...(isCommands ? [ListCommands({ address })] : []), ...(isChoices ? [ListModelChoices({ address })] : [])],
  }
}

export const failedPair = (model: Model, address: string, reason: string): Model => modifyFields(model, { pairing: () => Pairing.Failed({ address, reason }) })

/** Under a note of `failure`: the Pair button, when the agent at `address` waits on a pairing, and why the last one failed. */
export const pairView = (model: Model, address: string, failure: BridgeError, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  failure.kind !== "unpaired" || !supportsAt(model, address, "pairing")
    ? []
    : [
        h.button(
          [h.Type("button"), h.Class("chip pair"), h.Disabled(model.pairing._tag === "Pairing"), h.OnClick(Message.ClickedPair({ address }))],
          [model.pairing._tag === "Pairing" && model.pairing.address === address ? "Pairing…" : "Pair"],
        ),
        ...(model.pairing._tag === "Failed" && model.pairing.address === address ? [h.p([h.Class("note pair-problem")], [`The pairing failed: ${model.pairing.reason}`])] : []),
      ]
