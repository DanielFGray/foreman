import "./styles.css"
import { Runtime } from "foldkit"
import { init, subscriptions, update, view } from "./main.ts"
import { Flags, loadFlags, Model } from "./model.ts"
import { BridgeClient } from "./rpc.ts"

const container = document.getElementById("root")

if (container) {
  Runtime.run(
    Runtime.makeApplication({ Model, Flags, init, update, view, subscriptions, resources: BridgeClient.layer, container }),
    { flags: loadFlags },
  )
}
