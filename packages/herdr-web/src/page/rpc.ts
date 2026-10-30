import { BrowserSocket } from "@effect/platform-browser"
import { Context, Effect, Layer, Match } from "effect"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc"
import { Api, type BridgeError } from "../shared/Api.ts"

// The bridge serves this page, so its Api is on the same host, at /rpc. The
// address is read when the client starts, so the page's modules load outside
// a browser too, as its tests do.
const BridgeSocket = Layer.unwrap(
  Effect.sync(() =>
    BrowserSocket.layerWebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc`),
  ),
)

const Protocol = RpcClient.layerProtocolSocket().pipe(Layer.provide([BridgeSocket, RpcSerialization.layerJson]))

/** The bridge's Api, over one WebSocket for the life of the page. */
export class BridgeClient extends Context.Service<BridgeClient>()("herdr-web/page/BridgeClient", {
  make: RpcClient.make(Api),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Protocol))
}

/** Why a call failed: hc's own message, or that the bridge is gone. */
export const failureReason = (error: BridgeError | RpcClientError.RpcClientError) =>
  Match.valueTags(error, {
    BridgeError: ({ message }) => message,
    RpcClientError: () => "the bridge is not reachable",
  })

/** Turns a failed call into a Message that says why. */
export const reportFailure =
  <Message>(toMessage: (reason: string) => Message) =>
  <A, R>(call: Effect.Effect<A, BridgeError | RpcClientError.RpcClientError, R>) =>
    call.pipe(Effect.catch((error) => Effect.succeed(toMessage(failureReason(error)))))
