// The page's state and the messages that change it: one Model and one
// Message for the whole page, since the sidebar, tabs and panes all read and
// change the same selection.
import { Effect, Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { Direction } from "../shared/Api.ts"
import { ChatUpdate, Entry } from "../shared/Chat.ts"
import { Fleet } from "../shared/Fleet.ts"
import { FontFamily } from "../shared/Fonts.ts"
import { ProviderId, Usage } from "../shared/Usage.ts"
import { Modifier, Modifiers } from "./keys.ts"
import { PaletteTarget } from "./palette.ts"
import type { BridgeClient } from "./rpc.ts"
import { AgentList, loadSettings, Settings, Surface } from "./settings.ts"
import { loadSidebarWidth } from "./sidebarWidth.ts"
import { loadStored } from "./stored.ts"
import { Link } from "./terminal.ts"

export const SELECTION_KEY = "herdr-web.selection"
export const RECENT_KEY = "herdr-web.recent"

export const Bridge = defineTaggedUnion({
  Waiting: {},
  Watching: { fleet: Fleet },
  Lost: { maybeFleet: Schema.Option(Fleet) },
})
export type Bridge = typeof Bridge.Type

export const Conversation = defineTaggedUnion({
  Loading: {},
  Shown: { entries: Schema.Array(Entry) },
  Unreadable: { reason: Schema.String },
})
export type Conversation = typeof Conversation.Type

/** What a pane shows of its terminal: a Claude Code agent's chat, or the terminal itself, live. */
export const View = defineTaggedUnion({
  Chat: { conversation: Conversation },
  Terminal: { link: Link },
})
export type View = typeof View.Type

export const ViewName = Schema.Literals(["Chat", "Terminal"])
export type ViewName = typeof ViewName.Type

export const Delivery = defineTaggedUnion({
  Ready: {},
  Sending: {},
  Refused: { reason: Schema.String },
})
export type Delivery = typeof Delivery.Type

/** A split, new tab or close of a herdr-app pane or tab: none under way, a close waiting for a second click, or herdr-app's refusal. */
export const PaneAction = defineTaggedUnion({
  Idle: {},
  Confirming: { pane: Schema.String },
  ConfirmingTab: { tab: Schema.String },
  Refused: { reason: Schema.String },
})
export type PaneAction = typeof PaneAction.Type

/**
 * A space dragged to a new place in the sidebar, as in herdr-app's: pressed
 * on one row and released on another, the row under the pointer marked as
 * the target. Only one move is under way at a time, and the fleet then shows
 * the new order.
 */
export const SpaceDrag = defineTaggedUnion({
  Idle: {},
  Pressed: { space: Schema.String, over: Schema.Option(Schema.String) },
  Moving: {},
  Refused: { reason: Schema.String },
})
export type SpaceDrag = typeof SpaceDrag.Type

/** The command palette: shut, or open on what is typed and the result the arrow keys reached. */
export const Palette = defineTaggedUnion({
  Closed: {},
  Open: { query: Schema.String, highlighted: Schema.Int },
})
export type Palette = typeof Palette.Type

// The page keeps its own selection: following herdr-app's window would move
// the page whenever the user works at the desk.
export const Selection = defineTaggedUnion({
  Nothing: {},
  /** A herdr-app tab, and the pane the prompt and keys go to; none means its first terminal. */
  Tab: { tabId: Schema.String, maybeFocus: Schema.Option(Schema.String) },
  /** A terminal that no herdr-app layout shows, alone. */
  Loose: { address: Schema.String },
  /** This browser's settings, in place of a tab. */
  Settings: {},
})
export type Selection = typeof Selection.Type

/** The fonts the bridge serves, asked for when settings open. */
export const FontCatalog = defineTaggedUnion({
  Loading: {},
  Loaded: { families: Schema.Array(FontFamily) },
  Failed: { reason: Schema.String },
})
export type FontCatalog = typeof FontCatalog.Type

/**
 * A prompt sent to the agent and not yet in its transcript. `seen` is how many
 * prompts with this text the chat held when it was sent. `sentAt` is the
 * clock's first reading after the send: the page learns the time only from
 * the clock, which reads it at once when a wait starts.
 */
export const Waiting = Schema.Struct({ address: Schema.String, text: Schema.String, seen: Schema.Int, sentAt: Schema.Option(Schema.Finite) })
export type Waiting = typeof Waiting.Type

export const Model = Schema.Struct({
  bridge: Bridge,
  /** On a phone the sidebar folds away once a tab or agent is picked, to give the panes the screen. */
  isFleetFolded: Schema.Boolean,
  selection: Selection,
  /** The view of each shown terminal; a terminal not in it shows its default view. */
  views: Schema.Record(Schema.String, View),
  prompt: Schema.String,
  delivery: Delivery,
  /** The prompts the chats show as faded bubbles until the agent records them. */
  waiting: Schema.Array(Waiting),
  paneAction: PaneAction,
  spaceDrag: SpaceDrag,
  palette: Palette,
  /** The panes opened last, newest first, for the palette's Recent group. */
  recent: Schema.Array(Schema.String),
  settings: Settings,
  /** Soft ctrl and alt, armed until the next key. */
  modifiers: Modifiers,
  fontCatalog: FontCatalog,
  /** Each coding plan's usage, from the bridge; none before its first reading. */
  usage: Schema.Option(Usage),
  /** The plan whose usage panel is open. */
  usageDetail: Schema.Option(ProviderId),
  /** The time, for countdowns to a reset. */
  now: Schema.Finite,
  /** The sidebar's width on a desk once its edge was dragged; none is the stylesheet's own. */
  sidebarWidth: Schema.Option(Schema.Int),
  /** While the edge is dragged: how far right of the edge the pointer took hold of it. */
  sidebarGrip: Schema.Option(Schema.Finite),
})
export type Model = typeof Model.Type

/** What the page starts from: this browser's settings, the tab and pane it showed last, and its sidebar's width. */
export const Flags = Schema.Struct({
  settings: Settings,
  selection: Selection,
  sidebarWidth: Schema.Option(Schema.Int),
  /** The panes opened last, newest first. */
  recent: Schema.Array(Schema.String),
})
export type Flags = typeof Flags.Type

export const loadFlags = Effect.all({
  settings: loadSettings,
  selection: loadStored(SELECTION_KEY, Selection, Selection.Nothing()),
  sidebarWidth: loadSidebarWidth,
  recent: loadStored(RECENT_KEY, Schema.Array(Schema.String), []),
})

// MESSAGE

export const Message = defineMessageUnion({
  ReceivedFleet: { fleet: Fleet },
  LostBridge: {},
  ClickedFleetToggle: {},
  ClickedTerminal: { address: Schema.String },
  ClickedTab: { tabId: Schema.String },
  FocusedPane: { address: Schema.String },
  SelectedView: { address: Schema.String, view: ViewName },
  ReceivedChat: { address: Schema.String, update: ChatUpdate },
  FailedChat: { address: Schema.String, reason: Schema.String },
  ChangedLink: { address: Schema.String, link: Link },
  ClickedSplit: { pane: Schema.String, direction: Direction },
  SucceededSplit: { terminal: Schema.String },
  ClickedClose: { pane: Schema.String },
  ClickedKeepPane: {},
  ConfirmedClose: { pane: Schema.String },
  SucceededClose: {},
  ClickedNewTab: { space: Schema.String },
  SucceededNewTab: { tab: Schema.String },
  ClickedCloseTab: { tab: Schema.String },
  ConfirmedCloseTab: { tab: Schema.String },
  SucceededCloseTab: {},
  FailedPaneAction: { reason: Schema.String },
  PressedSpace: { space: Schema.String },
  EnteredSpace: { space: Schema.String },
  ReleasedSpace: { space: Schema.String },
  /** The press ended away from a space row, or the pointer left the sidebar. */
  DroppedSpaceDrag: {},
  SucceededMoveSpace: {},
  FailedMoveSpace: { reason: Schema.String },
  ClickedSettings: {},
  PickedFont: { surface: Surface, font: Schema.Option(Schema.String) },
  SteppedSize: { surface: Surface, step: Schema.Int },
  PickedAgentList: { agents: AgentList },
  CompletedSaveSettings: {},
  CompletedSaveSelection: {},
  ReceivedFonts: { families: Schema.Array(FontFamily) },
  FailedFonts: { reason: Schema.String },
  UpdatedPrompt: { text: Schema.String },
  SubmittedPrompt: {},
  SucceededSendPrompt: { address: Schema.String },
  FailedSendPrompt: { address: Schema.String, reason: Schema.String },
  ClickedKey: { key: Schema.String },
  ToggledModifier: { modifier: Modifier },
  UsedModifiers: {},
  CompletedKeepTypingFocus: {},
  SucceededPressKeys: { address: Schema.String },
  FailedPressKeys: { address: Schema.String, reason: Schema.String },
  ReceivedUsage: { usage: Usage },
  ToggledUsageDetail: { provider: ProviderId },
  ClickedRefreshUsage: { provider: Schema.Option(ProviderId) },
  CompletedRefreshUsage: {},
  TickedClock: { now: Schema.Finite },
  PressedSidebarEdge: { x: Schema.Finite },
  MovedSidebarEdge: { x: Schema.Finite },
  ReleasedSidebarEdge: {},
  KeyedSidebarEdge: { key: Schema.String },
  ResetSidebarWidth: {},
  CompletedSaveSidebarWidth: {},
  PressedPaletteKey: {},
  ClosedPalette: {},
  UpdatedPaletteQuery: { text: Schema.String },
  MovedPaletteHighlight: { step: Schema.Int },
  OpenedPaletteResult: { target: PaletteTarget },
  SubmittedPalette: {},
  CompletedFocusPalette: {},
  CompletedSaveRecent: {},
})
export type Message = typeof Message.Type

export type UpdateReturn = Update.Return<Model, Message, BridgeClient>
