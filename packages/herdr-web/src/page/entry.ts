import "./styles.css"
import { Effect } from "effect"
import { Runtime } from "foldkit"
import { init, subscriptions, update, view } from "./main.ts"
import { Flags, loadFlags, Model } from "./model.ts"
import { fitPaneTools } from "./paneFit.ts"
import { BridgeClient } from "./rpc.ts"

const container = document.getElementById("root")

if (container) {
  Effect.runFork(Effect.scoped(Effect.andThen(fitPaneTools(document.body), Effect.never)))
  Runtime.run(
    Runtime.makeApplication({ Model, Flags, init, update, view, subscriptions, resources: BridgeClient.layer, container }),
    { flags: loadFlags },
  )
}
