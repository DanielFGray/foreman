import { BrowserSocket } from "@effect/platform-browser"
import { Context, Effect, Layer } from "effect"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc"
import { Api, type BridgeError } from "../shared/Api.ts"

// The bridge serves this page, so its Api is on the same host, at /rpc.
const bridgeUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc`

const Protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide([BrowserSocket.layerWebSocket(bridgeUrl), RpcSerialization.layerJson]),
)

/** The bridge's Api, over one WebSocket for the life of the page. */
export class BridgeClient extends Context.Service<BridgeClient>()("herdr-web/page/BridgeClient", {
  make: RpcClient.make(Api),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Protocol))
}

/** Turns a failed call into a Message that says why: hc's own message, or that the bridge is gone. */
export const reportFailure =
  <Message>(toMessage: (reason: string) => Message) =>
  <A, R>(call: Effect.Effect<A, BridgeError | RpcClientError.RpcClientError, R>) =>
    call.pipe(
      Effect.catchTags({
        BridgeError: ({ message }) => Effect.succeed(toMessage(message)),
        RpcClientError: () => Effect.succeed(toMessage("the bridge is not reachable")),
      }),
    )
