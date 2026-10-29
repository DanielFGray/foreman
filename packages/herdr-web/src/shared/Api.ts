// The calls a page makes to the bridge, over Effect RPC on a WebSocket.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Fleet } from "./Fleet.ts"

/** A call that hc refused or could not take; `kind` is hc's error kind, or `lost` / `protocol`. */
export class BridgeError extends Schema.TaggedError<BridgeError, { readonly brand: unique symbol }>()("BridgeError", {
  kind: Schema.String,
  message: Schema.String,
}) {}

export const Api = RpcGroup.make(
  /** The fleet now, then after every change. */
  Rpc.make("watch", { success: Fleet, stream: true }),
  /** The terminal's screen plus `lines` of history, as text. */
  Rpc.make("read", {
    payload: { terminal: Schema.String, lines: Schema.Int },
    success: Schema.Struct({ text: Schema.String }),
    error: BridgeError,
  }),
  /** Types text and presses Enter. */
  Rpc.make("send", { payload: { terminal: Schema.String, text: Schema.String }, error: BridgeError }),
  /** Presses named keys, such as `1`, `y`, `esc` or `ctrl+c`. */
  Rpc.make("keys", {
    payload: { terminal: Schema.String, keys: Schema.Array(Schema.String) },
    error: BridgeError,
  }),
)
