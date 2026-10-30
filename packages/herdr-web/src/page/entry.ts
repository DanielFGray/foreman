import "./styles.css"
import { Runtime } from "foldkit"
import { init, Model, subscriptions, update, view } from "./main.ts"
import { BridgeClient } from "./rpc.ts"
import { loadSettings, Settings } from "./settings.ts"

const container = document.getElementById("root")

if (container) {
  Runtime.run(
    Runtime.makeApplication({ Model, Flags: Settings, init, update, view, subscriptions, resources: BridgeClient.layer, container }),
    { flags: loadSettings },
  )
}
