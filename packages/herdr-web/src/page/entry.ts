import "./styles.css"
import { Runtime } from "foldkit"
import { Flags, init, loadFlags, Model, subscriptions, update, view } from "./main.ts"
import { BridgeClient } from "./rpc.ts"

const container = document.getElementById("root")

if (container) {
  Runtime.run(
    Runtime.makeApplication({ Model, Flags, init, update, view, subscriptions, resources: BridgeClient.layer, container }),
    { flags: loadFlags },
  )
}
