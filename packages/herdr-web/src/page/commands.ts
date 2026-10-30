// The page's commands: each one call to the bridge or to this browser's storage.
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { Direction } from "../shared/Api.ts"
import { ProviderId } from "../shared/Usage.ts"
import { Message, SELECTION_KEY, Selection } from "./model.ts"
import { BridgeClient, failureReason, reportFailure } from "./rpc.ts"
import { saveSettings, Settings } from "./settings.ts"
import { saveSidebarWidth } from "./sidebarWidth.ts"
import { saveStored } from "./stored.ts"

export const SplitPane = Command.define("SplitPane", {
  args: { pane: Schema.String, direction: Direction },
  messages: [Message.SucceededSplit, Message.FailedPaneAction],
  execute: ({ pane, direction }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      const { terminal } = yield* client.split({ pane, direction })
      return Message.SucceededSplit({ terminal })
    }).pipe(reportFailure((reason) => Message.FailedPaneAction({ reason }))),
})

export const SaveSettings = Command.define("SaveSettings", {
  args: { settings: Settings },
  messages: [Message.CompletedSaveSettings],
  execute: ({ settings }) => saveSettings(settings).pipe(Effect.as(Message.CompletedSaveSettings())),
})

export const SaveSidebarWidth = Command.define("SaveSidebarWidth", {
  args: { width: Schema.Option(Schema.Int) },
  messages: [Message.CompletedSaveSidebarWidth],
  execute: ({ width }) => saveSidebarWidth(width).pipe(Effect.as(Message.CompletedSaveSidebarWidth())),
})

export const SaveSelection = Command.define("SaveSelection", {
  args: { selection: Selection },
  messages: [Message.CompletedSaveSelection],
  execute: ({ selection }) => saveStored(SELECTION_KEY, Selection, selection).pipe(Effect.as(Message.CompletedSaveSelection())),
})

export const FetchFonts = Command.define("FetchFonts", {
  messages: [Message.ReceivedFonts, Message.FailedFonts],
  execute: Effect.gen(function* () {
    const client = yield* BridgeClient
    return Message.ReceivedFonts({ families: yield* client.fonts() })
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedFonts({ reason: failureReason(error) })))),
})

export const ClosePane = Command.define("ClosePane", {
  args: { pane: Schema.String },
  messages: [Message.SucceededClose, Message.FailedPaneAction],
  execute: ({ pane }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.closePane({ pane })
      return Message.SucceededClose()
    }).pipe(reportFailure((reason) => Message.FailedPaneAction({ reason }))),
})

export const MoveSpace = Command.define("MoveSpace", {
  args: { space: Schema.String, onto: Schema.String },
  messages: [Message.SucceededMoveSpace, Message.FailedMoveSpace],
  execute: ({ space, onto }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.moveSpace({ space, onto })
      return Message.SucceededMoveSpace()
    }).pipe(reportFailure((reason) => Message.FailedMoveSpace({ reason }))),
})

export const SendPrompt = Command.define("SendPrompt", {
  args: { address: Schema.String, text: Schema.String },
  messages: [Message.SucceededSendPrompt, Message.FailedSendPrompt],
  execute: ({ address, text }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.send({ terminal: address, text })
      return Message.SucceededSendPrompt({ address })
    }).pipe(reportFailure((reason) => Message.FailedSendPrompt({ address, reason }))),
})

// The reading that follows arrives on the usage subscription; a refresh the
// bridge did not take costs only a stale number, so it is logged.
export const RefreshUsage = Command.define("RefreshUsage", {
  args: { provider: Schema.Option(ProviderId) },
  messages: [Message.CompletedRefreshUsage],
  execute: ({ provider }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.refreshUsage({ provider })
    }).pipe(
      Effect.catch((error) => Effect.logWarning("the bridge did not refresh the usage", failureReason(error))),
      Effect.as(Message.CompletedRefreshUsage()),
    ),
})

export const PressKeys = Command.define("PressKeys", {
  args: { address: Schema.String, keys: Schema.Array(Schema.String) },
  messages: [Message.SucceededPressKeys, Message.FailedPressKeys],
  execute: ({ address, keys }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.keys({ terminal: address, keys })
      return Message.SucceededPressKeys({ address })
    }).pipe(reportFailure((reason) => Message.FailedPressKeys({ address, reason }))),
})
