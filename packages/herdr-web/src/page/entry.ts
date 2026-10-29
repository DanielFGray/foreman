import "./styles.css"
import { Runtime } from "foldkit"
import { init, Model, subscriptions, update, view } from "./main.ts"
import { BridgeClient } from "./rpc.ts"

const container = document.getElementById("root")

if (container) {
  Runtime.run(
    Runtime.makeApplication({ Model, init, update, view, subscriptions, resources: BridgeClient.layer, container }),
  )
}
