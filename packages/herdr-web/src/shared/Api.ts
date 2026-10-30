// The calls a page makes to the bridge, over Effect RPC on a WebSocket.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ChatUpdate } from "./Chat.ts"
import { Fleet } from "./Fleet.ts"
import { FontFamily } from "./Fonts.ts"
import { ProviderId, Usage } from "./Usage.ts"

/**
 * A call that failed. `kind` is hc's error kind, `lost` or `protocol` for hc
 * itself, or `transcript` when the agent's conversation cannot be read.
 */
export class BridgeError extends Schema.TaggedError<BridgeError, { readonly brand: unique symbol }>()("BridgeError", {
  kind: Schema.String,
  message: Schema.String,
}) {}

/** The session that the live terminal's input and resize calls name. */
export const Attached = Schema.TaggedStruct("Attached", { session: Schema.Int })
/** Bytes the terminal wrote, escape sequences and all; the first are its screen. */
export const Output = Schema.TaggedStruct("Output", { bytes: Schema.Uint8ArrayFromBase64 })
export const TerminalUpdate = Schema.Union([Attached, Output])
export type TerminalUpdate = typeof TerminalUpdate.Type

export const Direction = Schema.Literals(["right", "down"])
export type Direction = typeof Direction.Type

export const Api = RpcGroup.make(
  /** The fleet now, then after every change. */
  Rpc.make("watch", { success: Fleet, stream: true }),
  /** The conversation of the Claude Code agent in the terminal: its recent entries, then each batch of new ones. */
  Rpc.make("chat", { payload: { terminal: Schema.String }, success: ChatUpdate, error: BridgeError, stream: true }),
  /** Types text and presses Enter. */
  Rpc.make("send", { payload: { terminal: Schema.String, text: Schema.String }, error: BridgeError }),
  /** Presses named keys, such as `1`, `y`, `esc` or `ctrl+c`. */
  Rpc.make("keys", {
    payload: { terminal: Schema.String, keys: Schema.Array(Schema.String) },
    error: BridgeError,
  }),
  /**
   * The terminal live, at the page's size: a session, then its output for as
   * long as the page reads. The terminal takes the size of whichever viewer
   * typed last, so a page that only watches leaves it as it is.
   */
  Rpc.make("attach", {
    payload: { terminal: Schema.String, cols: Schema.Int, rows: Schema.Int },
    success: TerminalUpdate,
    error: BridgeError,
    stream: true,
  }),
  /** Keys typed into a live terminal, as the terminal reads them. */
  Rpc.make("input", { payload: { session: Schema.Int, data: Schema.String }, error: BridgeError }),
  Rpc.make("resize", { payload: { session: Schema.Int, cols: Schema.Int, rows: Schema.Int }, error: BridgeError }),
  /** Opens a shell beside a pane of herdr-app's layout; the new shell's terminal. */
  Rpc.make("split", {
    payload: { pane: Schema.String, direction: Direction },
    success: Schema.Struct({ terminal: Schema.String }),
    error: BridgeError,
  }),
  /** Closes a pane of herdr-app's layout and ends its terminal. */
  Rpc.make("closePane", { payload: { pane: Schema.String }, error: BridgeError }),
  /** Moves a space to where another space of its machine is now, as herdr-app's sidebar drag does. */
  Rpc.make("moveSpace", { payload: { space: Schema.String, onto: Schema.String }, error: BridgeError }),
  /** The font families the bridge serves at /fonts.css. */
  Rpc.make("fonts", { success: Schema.Array(FontFamily) }),
  /** Each coding plan's usage now, then after every read; the bridge reads only while a page watches. */
  Rpc.make("usage", { success: Usage, stream: true }),
  /** Reads one provider's usage, or every one's (none), now. */
  Rpc.make("refreshUsage", { payload: { provider: Schema.OptionFromNullOr(ProviderId) } }),
)
