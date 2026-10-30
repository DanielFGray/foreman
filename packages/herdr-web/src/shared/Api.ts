// The calls a page makes to the bridge, over Effect RPC on a WebSocket.
import { Schema as S } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Answer, ChatUpdate, InputBox, Question } from "./Chat.ts"
import { Fleet } from "./Fleet.ts"
import { ModelChoices } from "./Harness.ts"
import { FontFamily } from "./Fonts.ts"
import { ProviderId, Usage } from "./Usage.ts"
import { SlashCommand } from "./SlashCommand.ts"
import { TodoItem } from "./Todo.ts"
import { RepoCheckouts } from "./Worktree.ts"

/**
 * A call that failed. `kind` is hc's error kind, `lost` or `protocol` for hc
 * itself, `transcript` when the agent's conversation cannot be read, `herdr-app`
 * when herdr-app's layout refuses the change, or `git` when git refuses.
 */
export class BridgeError extends S.TaggedError<BridgeError, { readonly brand: unique symbol }>()("BridgeError", {
  kind: S.String,
  message: S.String,
}) {}

/** The session that the live terminal's input and resize calls name. */
export const Attached = S.TaggedStruct("Attached", { session: S.Int })
/** Bytes the terminal wrote, escape sequences and all; the first are its screen. */
export const Output = S.TaggedStruct("Output", { bytes: S.Uint8ArrayFromBase64 })
/** A watched terminal's size, first and after each change; the screen is painted anew after it. */
export const Sized = S.TaggedStruct("Sized", { cols: S.Int, rows: S.Int })
export const TerminalUpdate = S.Union([Attached, Sized, Output])
export type TerminalUpdate = typeof TerminalUpdate.Type

/**
 * How a page views a live terminal. Watching never types or sets the size, so
 * the program keeps its viewers' size. Typing takes the terminal: hc gives it
 * the size of whichever viewer typed or resized last.
 */
export const Viewer = S.Union([S.TaggedStruct("Watching", {}), S.TaggedStruct("Typing", { cols: S.Int, rows: S.Int })])
export type Viewer = typeof Viewer.Type

export const Direction = S.Literals(["right", "down"])
export type Direction = typeof Direction.Type

export const Api = RpcGroup.make(
  /** The fleet now, then after every change. */
  Rpc.make("watch", { success: Fleet, stream: true }),
  /** The conversation of the agent in the terminal: its recent entries, then each batch of new ones. */
  Rpc.make("chat", { payload: { terminal: S.String }, success: ChatUpdate, error: BridgeError, stream: true }),
  /**
   * The model the agent in the terminal answers with, then after each change.
   * For Claude Code, the id of its newest reply, such as `claude-opus-5-5`, or
   * the name `/model` switched to; none before its first reply. For OpenCode,
   * the session's own choice, as `<provider>/<model>`.
   */
  Rpc.make("model", { payload: { terminal: S.String }, success: S.OptionFromNullOr(S.String), error: BridgeError, stream: true }),
  /** The agent's todo list, then after each change; empty while it has none. */
  Rpc.make("todos", { payload: { terminal: S.String }, success: S.Array(TodoItem), error: BridgeError, stream: true }),
  /**
   * The models the agent in the terminal may switch to, and the one it uses
   * now. An agent that lists them from its own server fails with kind
   * `unpaired` until the bridge is paired with that server (see `pair`).
   */
  Rpc.make("modelChoices", { payload: { terminal: S.String }, success: ModelChoices, error: BridgeError }),
  /** Switches the agent in the terminal to one of its model choices, by alias. Claude Code refuses it, with kind `working`, while it works. */
  Rpc.make("pickModel", { payload: { terminal: S.String, alias: S.String }, error: BridgeError }),
  /**
   * Types text and presses Enter. It is refused, with kind `draft`, while the
   * agent's input box holds text typed in the terminal, which the paste would
   * join; and with kind `working` while the agent works, unless `whileWorking`.
   * An agent whose input box the page cannot read is never refused. When the
   * box still holds `replaces`, the text the page itself wrote there, the box
   * is emptied first and the message goes.
   */
  Rpc.make("send", {
    payload: { terminal: S.String, text: S.String, whileWorking: S.Boolean, replaces: S.OptionFromNullOr(S.String) },
    error: BridgeError,
  }),
  /** What the agent's input box holds now, then after each change, for as long as the page reads. */
  Rpc.make("inputBox", { payload: { terminal: S.String }, success: InputBox, error: BridgeError, stream: true }),
  /**
   * Replaces the text in the agent's input box with `text`, without sending
   * it, and answers with the box as it reads after. It is refused, with kind
   * `changed`, when the box no longer holds `expected` (compared as
   * `sameTyped` does), and with kind `draft` when the box is taller than the
   * screen.
   */
  Rpc.make("writeInputBox", { payload: { terminal: S.String, expected: S.String, text: S.String }, success: InputBox, error: BridgeError }),
  /** The question the agent waits on, read from its screen; none while it shows no menu. */
  Rpc.make("question", { payload: { terminal: S.String }, success: S.OptionFromNullOr(Question), error: BridgeError }),
  /**
   * Answers `question`, if the agent still asks it: picks a choice, or types
   * an answer of the user's own. When it has moved on, nothing is pressed and
   * the call fails with kind `moved-on`.
   */
  Rpc.make("answer", { payload: { terminal: S.String, question: Question, answer: Answer }, error: BridgeError }),
  /** Presses named keys, such as `1`, `y`, `esc` or `ctrl+c`. */
  Rpc.make("keys", {
    payload: { terminal: S.String, keys: S.Array(S.String) },
    error: BridgeError,
  }),
  /**
   * The terminal live, for as long as the page reads. Typing, a session first,
   * which the input and resize calls name; watching, its size first. Then the
   * terminal's output.
   */
  Rpc.make("attach", {
    payload: { terminal: S.String, as: Viewer },
    success: TerminalUpdate,
    error: BridgeError,
    stream: true,
  }),
  /** Keys typed into a live terminal, as the terminal reads them. */
  Rpc.make("input", { payload: { session: S.Int, data: S.String }, error: BridgeError }),
  Rpc.make("resize", { payload: { session: S.Int, cols: S.Int, rows: S.Int }, error: BridgeError }),
  /** Opens a shell beside a pane of herdr-app's layout; the new shell's terminal. */
  Rpc.make("split", {
    payload: { pane: S.String, direction: Direction },
    success: S.Struct({ terminal: S.String }),
    error: BridgeError,
  }),
  /** Closes a pane of herdr-app's layout and ends its terminal. */
  Rpc.make("closePane", { payload: { pane: S.String }, error: BridgeError }),
  /** Opens a tab with a shell in a space; the new tab's id. */
  Rpc.make("newTab", { payload: { space: S.String }, success: S.Struct({ tab: S.String }), error: BridgeError }),
  /** Closes a tab of herdr-app's layout and ends its terminals. */
  Rpc.make("closeTab", { payload: { tab: S.String }, error: BridgeError }),
  /** Moves a space to where another space of its machine is now, as herdr-app's sidebar drag does. */
  Rpc.make("moveSpace", { payload: { space: S.String, onto: S.String }, error: BridgeError }),
  /**
   * Opens a space with one tab, here or on another machine. Its pane runs the
   * program, then the shell, or the shell alone. A relative folder is taken
   * from the machine's home. The new space's first tab.
   */
  Rpc.make("newSpace", {
    payload: { machine: S.OptionFromOptionalKey(S.String), folder: S.String, name: S.String, program: S.OptionFromOptionalKey(S.String) },
    success: S.Struct({ tab: S.String }),
    error: BridgeError,
  }),
  /** Names a space; an empty name shows it by its folder. */
  Rpc.make("renameSpace", { payload: { space: S.String, name: S.String }, error: BridgeError }),
  /** Closes a space and ends the terminals of all its tabs. */
  Rpc.make("closeSpace", { payload: { space: S.String }, error: BridgeError }),
  /**
   * The slash commands of the agent in a terminal: a few built-ins, and for
   * Claude Code the skills and command files on its machine for its folder,
   * for OpenCode the commands its server lists. OpenCode's fail with kind
   * `unpaired` until the bridge is paired with its server.
   */
  Rpc.make("commands", { payload: { terminal: S.String }, success: S.Array(SlashCommand), error: BridgeError }),
  /**
   * Pairs the bridge with the server of the agent in a terminal, so that the
   * calls above that need it work: the agent issues a one-time code, and the
   * bridge trades it for a sign-in that it keeps. It fails with kind `remote`
   * for an agent on another machine, whose server the bridge cannot reach.
   */
  Rpc.make("pair", { payload: { terminal: S.String }, error: BridgeError }),
  /** The checkouts of the repository a space is in, and the space that shows each. */
  Rpc.make("worktrees", { payload: { space: S.String }, success: RepoCheckouts, error: BridgeError }),
  /**
   * Checks out a branch of the space's repository, a new one from its HEAD
   * when it does not exist, and opens it as a space whose pane runs the
   * program. The new space's first tab.
   */
  Rpc.make("newWorktree", {
    payload: { space: S.String, branch: S.String, program: S.OptionFromOptionalKey(S.String) },
    success: S.Struct({ tab: S.String }),
    error: BridgeError,
  }),
  /** Opens a checkout of the space's repository as a new space; its first tab. */
  Rpc.make("openWorktree", { payload: { space: S.String, path: S.String }, success: S.Struct({ tab: S.String }), error: BridgeError }),
  /** Removes a clean checkout, never by force, and closes the spaces that showed it. The branch stays. */
  Rpc.make("removeWorktree", { payload: { space: S.String, path: S.String }, error: BridgeError }),
  /** The font families the bridge serves at /fonts.css. */
  Rpc.make("fonts", { success: S.Array(FontFamily) }),
  /** Each coding plan's usage now, then after every read; the bridge reads only while a page watches. */
  Rpc.make("usage", { success: Usage, stream: true }),
  /** Reads one provider's usage, or every one's (none), now. */
  Rpc.make("refreshUsage", { payload: { provider: S.OptionFromNullOr(ProviderId) } }),
)
