// The calls a page makes to the bridge, over Effect RPC on a WebSocket.
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Answer, ChatUpdate, InputBox, Question } from "./Chat.ts"
import { Fleet } from "./Fleet.ts"
import { ModelChoices } from "./Harness.ts"
import { FontFamily } from "./Fonts.ts"
import { ProviderId, Usage } from "./Usage.ts"
import { SlashCommand } from "./SlashCommand.ts"
import { RepoCheckouts } from "./Worktree.ts"

/**
 * A call that failed. `kind` is hc's error kind, `lost` or `protocol` for hc
 * itself, `transcript` when the agent's conversation cannot be read, `herdr-app`
 * when herdr-app's layout refuses the change, or `git` when git refuses.
 */
export class BridgeError extends Schema.TaggedError<BridgeError, { readonly brand: unique symbol }>()("BridgeError", {
  kind: Schema.String,
  message: Schema.String,
}) {}

/** The session that the live terminal's input and resize calls name. */
export const Attached = Schema.TaggedStruct("Attached", { session: Schema.Int })
/** Bytes the terminal wrote, escape sequences and all; the first are its screen. */
export const Output = Schema.TaggedStruct("Output", { bytes: Schema.Uint8ArrayFromBase64 })
/** A watched terminal's size, first and after each change; the screen is painted anew after it. */
export const Sized = Schema.TaggedStruct("Sized", { cols: Schema.Int, rows: Schema.Int })
export const TerminalUpdate = Schema.Union([Attached, Sized, Output])
export type TerminalUpdate = typeof TerminalUpdate.Type

/**
 * How a page views a live terminal. Watching never types or sets the size, so
 * the program keeps its viewers' size. Typing takes the terminal: hc gives it
 * the size of whichever viewer typed or resized last.
 */
export const Viewer = Schema.Union([Schema.TaggedStruct("Watching", {}), Schema.TaggedStruct("Typing", { cols: Schema.Int, rows: Schema.Int })])
export type Viewer = typeof Viewer.Type

export const Direction = Schema.Literals(["right", "down"])
export type Direction = typeof Direction.Type

export const Api = RpcGroup.make(
  /** The fleet now, then after every change. */
  Rpc.make("watch", { success: Fleet, stream: true }),
  /** The conversation of the agent in the terminal: its recent entries, then each batch of new ones. */
  Rpc.make("chat", { payload: { terminal: Schema.String }, success: ChatUpdate, error: BridgeError, stream: true }),
  /**
   * The model the agent in the terminal answers with, then after each change.
   * For Claude Code, the id of its newest reply, such as `claude-opus-5-5`, or
   * the name `/model` switched to; none before its first reply. For OpenCode,
   * the session's own choice, as `<provider>/<model>`.
   */
  Rpc.make("model", { payload: { terminal: Schema.String }, success: Schema.OptionFromNullOr(Schema.String), error: BridgeError, stream: true }),
  /**
   * The models the agent in the terminal may switch to, and the one it uses
   * now. An agent that lists them from its own server fails with kind
   * `unpaired` until the bridge is paired with that server (see `pair`).
   */
  Rpc.make("modelChoices", { payload: { terminal: Schema.String }, success: ModelChoices, error: BridgeError }),
  /** Switches the agent in the terminal to one of its model choices, by alias. Claude Code refuses it, with kind `working`, while it works. */
  Rpc.make("pickModel", { payload: { terminal: Schema.String, alias: Schema.String }, error: BridgeError }),
  /**
   * Types text and presses Enter. It is refused, with kind `draft`, while the
   * agent's input box holds text typed in the terminal, which the paste would
   * join; and with kind `working` while the agent works, unless `whileWorking`.
   * An agent whose input box the page cannot read is never refused. When the
   * box still holds `replaces`, the text the page itself wrote there, the box
   * is emptied first and the message goes.
   */
  Rpc.make("send", {
    payload: { terminal: Schema.String, text: Schema.String, whileWorking: Schema.Boolean, replaces: Schema.OptionFromNullOr(Schema.String) },
    error: BridgeError,
  }),
  /** What the agent's input box holds now, then after each change, for as long as the page reads. */
  Rpc.make("inputBox", { payload: { terminal: Schema.String }, success: InputBox, error: BridgeError, stream: true }),
  /**
   * Replaces the text in the agent's input box with `text`, without sending
   * it, and answers with the box as it reads after. It is refused, with kind
   * `changed`, when the box no longer holds `expected` (compared as
   * `sameTyped` does), and with kind `draft` when the box is taller than the
   * screen.
   */
  Rpc.make("writeInputBox", { payload: { terminal: Schema.String, expected: Schema.String, text: Schema.String }, success: InputBox, error: BridgeError }),
  /** The question the agent waits on, read from its screen; none while it shows no menu. */
  Rpc.make("question", { payload: { terminal: Schema.String }, success: Schema.OptionFromNullOr(Question), error: BridgeError }),
  /**
   * Answers `question`, if the agent still asks it: picks a choice, or types
   * an answer of the user's own. When it has moved on, nothing is pressed and
   * the call fails with kind `moved-on`.
   */
  Rpc.make("answer", { payload: { terminal: Schema.String, question: Question, answer: Answer }, error: BridgeError }),
  /** Presses named keys, such as `1`, `y`, `esc` or `ctrl+c`. */
  Rpc.make("keys", {
    payload: { terminal: Schema.String, keys: Schema.Array(Schema.String) },
    error: BridgeError,
  }),
  /**
   * The terminal live, for as long as the page reads. Typing, a session first,
   * which the input and resize calls name; watching, its size first. Then the
   * terminal's output.
   */
  Rpc.make("attach", {
    payload: { terminal: Schema.String, as: Viewer },
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
  /** Opens a tab with a shell in a space; the new tab's id. */
  Rpc.make("newTab", { payload: { space: Schema.String }, success: Schema.Struct({ tab: Schema.String }), error: BridgeError }),
  /** Closes a tab of herdr-app's layout and ends its terminals. */
  Rpc.make("closeTab", { payload: { tab: Schema.String }, error: BridgeError }),
  /** Moves a space to where another space of its machine is now, as herdr-app's sidebar drag does. */
  Rpc.make("moveSpace", { payload: { space: Schema.String, onto: Schema.String }, error: BridgeError }),
  /**
   * Opens a space with one tab, here or on another machine. Its pane runs the
   * program, then the shell, or the shell alone. A relative folder is taken
   * from the machine's home. The new space's first tab.
   */
  Rpc.make("newSpace", {
    payload: { machine: Schema.OptionFromOptionalKey(Schema.String), folder: Schema.String, name: Schema.String, program: Schema.OptionFromOptionalKey(Schema.String) },
    success: Schema.Struct({ tab: Schema.String }),
    error: BridgeError,
  }),
  /** Names a space; an empty name shows it by its folder. */
  Rpc.make("renameSpace", { payload: { space: Schema.String, name: Schema.String }, error: BridgeError }),
  /** Closes a space and ends the terminals of all its tabs. */
  Rpc.make("closeSpace", { payload: { space: Schema.String }, error: BridgeError }),
  /**
   * The slash commands of the agent in a terminal: a few built-ins, and for
   * Claude Code the skills and command files on its machine for its folder,
   * for OpenCode the commands its server lists. OpenCode's fail with kind
   * `unpaired` until the bridge is paired with its server.
   */
  Rpc.make("commands", { payload: { terminal: Schema.String }, success: Schema.Array(SlashCommand), error: BridgeError }),
  /**
   * Pairs the bridge with the server of the agent in a terminal, so that the
   * calls above that need it work: the agent issues a one-time code, and the
   * bridge trades it for a sign-in that it keeps. It fails with kind `remote`
   * for an agent on another machine, whose server the bridge cannot reach.
   */
  Rpc.make("pair", { payload: { terminal: Schema.String }, error: BridgeError }),
  /** The checkouts of the repository a space is in, and the space that shows each. */
  Rpc.make("worktrees", { payload: { space: Schema.String }, success: RepoCheckouts, error: BridgeError }),
  /**
   * Checks out a branch of the space's repository, a new one from its HEAD
   * when it does not exist, and opens it as a space whose pane runs the
   * program. The new space's first tab.
   */
  Rpc.make("newWorktree", {
    payload: { space: Schema.String, branch: Schema.String, program: Schema.OptionFromOptionalKey(Schema.String) },
    success: Schema.Struct({ tab: Schema.String }),
    error: BridgeError,
  }),
  /** Opens a checkout of the space's repository as a new space; its first tab. */
  Rpc.make("openWorktree", { payload: { space: Schema.String, path: Schema.String }, success: Schema.Struct({ tab: Schema.String }), error: BridgeError }),
  /** Removes a clean checkout, never by force, and closes the spaces that showed it. The branch stays. */
  Rpc.make("removeWorktree", { payload: { space: Schema.String, path: Schema.String }, error: BridgeError }),
  /** The font families the bridge serves at /fonts.css. */
  Rpc.make("fonts", { success: Schema.Array(FontFamily) }),
  /** Each coding plan's usage now, then after every read; the bridge reads only while a page watches. */
  Rpc.make("usage", { success: Usage, stream: true }),
  /** Reads one provider's usage, or every one's (none), now. */
  Rpc.make("refreshUsage", { payload: { provider: Schema.OptionFromNullOr(ProviderId) } }),
)
