// The page's state and the messages that change it: one Model and one
// Message for the whole page, since the sidebar, tabs and panes all read and
// change the same selection.
import { Effect, Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { Direction } from "../shared/Api.ts"
import { Answer, ChatUpdate, Entry, InputBox, Question } from "../shared/Chat.ts"
import { Fleet } from "../shared/Fleet.ts"
import { FontFamily } from "../shared/Fonts.ts"
import { ProviderId, Usage } from "../shared/Usage.ts"
import { Checkout, RepoCheckouts } from "../shared/Worktree.ts"
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

/** The last soft key press: taken, or refused with the bridge's reason. */
export const Delivery = defineTaggedUnion({
  Ready: {},
  Refused: { reason: Schema.String },
})
export type Delivery = typeof Delivery.Type

/**
 * A change to a herdr-app pane, tab or space: none under way, a close waiting
 * for a second click, a space's new name being typed, or herdr-app's refusal.
 */
export const PaneAction = defineTaggedUnion({
  Idle: {},
  Confirming: { pane: Schema.String },
  ConfirmingTab: { tab: Schema.String },
  ConfirmingSpace: { space: Schema.String },
  RenamingSpace: { space: Schema.String, name: Schema.String },
  /** The model menu of the agent at `address` is open. */
  PickingModel: { address: Schema.String },
  Refused: { reason: Schema.String },
})
export type PaneAction = typeof PaneAction.Type

/** The checkouts on the Worktrees page: being read, read, or not readable. */
export const CheckoutList = defineTaggedUnion({
  Loading: {},
  Listed: { list: RepoCheckouts },
  Unlisted: { reason: Schema.String },
})
export type CheckoutList = typeof CheckoutList.Type

/** What the Worktrees page is doing: nothing, a removal waiting for a second click, a call under way, or git's refusal. */
export const CheckoutAction = defineTaggedUnion({
  Idle: {},
  Confirming: { path: Schema.String },
  Busy: {},
  Refused: { reason: Schema.String },
})
export type CheckoutAction = typeof CheckoutAction.Type

export const WorktreeField = Schema.Literals(["branch", "program"])
export type WorktreeField = typeof WorktreeField.Type

/** The Worktrees page: its checkouts, the branch and program typed for a new one, and what it is doing. */
export const WorktreePage = Schema.Struct({ list: CheckoutList, branch: Schema.String, program: Schema.String, action: CheckoutAction })
export type WorktreePage = typeof WorktreePage.Type

/** Where the new-space form's last try stands. */
export const SpaceFormState = defineTaggedUnion({
  Editing: {},
  Opening: {},
  Refused: { reason: Schema.String },
})
export type SpaceFormState = typeof SpaceFormState.Type

export const SpaceFormField = Schema.Literals(["machine", "folder", "name", "program"])
export type SpaceFormField = typeof SpaceFormField.Type

/**
 * The new-space form. `machine` is the name hc gives it; this machine's own
 * name opens the space here. An empty program opens the shell alone.
 */
export const SpaceForm = Schema.Struct({
  machine: Schema.String,
  folder: Schema.String,
  name: Schema.String,
  program: Schema.String,
  state: SpaceFormState,
})
export type SpaceForm = typeof SpaceForm.Type

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
  /** The form that opens a space, in place of a tab. */
  NewSpace: {},
  /** The checkouts of the repository a space is in, in place of a tab. */
  Worktrees: { space: Schema.String },
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

/** A queued message: waiting for its agent, on its way, or refused by the bridge and held until the agent changes. */
export const QueueState = defineTaggedUnion({
  Waits: {},
  Sending: {},
  Held: { reason: Schema.String },
})
export type QueueState = typeof QueueState.Type

/** A message for the agent at `address`, in the order the user sent it. `id` tells apart two messages with the same text. */
export const Queued = Schema.Struct({ address: Schema.String, id: Schema.Int, text: Schema.String, state: QueueState })
export type Queued = typeof Queued.Type

/** What the page knows of the question an agent waits on. */
export const Asking = defineTaggedUnion({
  Reading: {},
  /** `sending` is the answer on its way to the agent. */
  Shown: { question: Question, sending: Schema.Option(Answer) },
  /** The agent waits, but its screen shows no menu the page can answer. */
  Unshown: { reason: Schema.Option(Schema.String) },
})
export type Asking = typeof Asking.Type

/**
 * The question of one blocked agent. `statusMs` names the status it was read
 * under, and `reads` counts the reads under that status: an answer, taken or
 * refused, reads the screen again, since a series of questions keeps one status.
 */
export const Asked = Schema.Struct({ statusMs: Schema.Int, reads: Schema.Int, notice: Schema.Option(Schema.String), asking: Asking })
export type Asked = typeof Asked.Type

export const Model = Schema.Struct({
  bridge: Bridge,
  /** On a phone the sidebar folds away once a tab or agent is picked, to give the panes the screen. */
  isFleetFolded: Schema.Boolean,
  selection: Selection,
  /** The view of each shown terminal; a terminal not in it shows its default view. */
  views: Schema.Record(Schema.String, View),
  prompt: Schema.String,
  delivery: Delivery,
  /** The messages not yet handed to their agents (see queue.ts). */
  queued: Schema.Array(Queued),
  /** What each watched agent's input box in the terminal holds, by address; none before the first reading. */
  boxes: Schema.Record(Schema.String, InputBox),
  /** The model each shown Claude Code agent answers with, by address: the id of its newest reply, or the name `/model` switched to; none before either. */
  models: Schema.Record(Schema.String, Schema.String),
  /** The prompts the chats show as faded bubbles until the agent records them. */
  waiting: Schema.Array(Waiting),
  /** The question each blocked agent in a chat waits on, by address. */
  questions: Schema.Record(Schema.String, Asked),
  paneAction: PaneAction,
  spaceDrag: SpaceDrag,
  spaceForm: SpaceForm,
  worktreePage: WorktreePage,
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
  ReceivedQuestion: { address: Schema.String, statusMs: Schema.Int, question: Schema.Option(Question) },
  FailedQuestion: { address: Schema.String, statusMs: Schema.Int, reason: Schema.String },
  ClickedChoice: { address: Schema.String, choice: Schema.Int },
  SucceededAnswer: { address: Schema.String },
  FailedAnswer: { address: Schema.String, reason: Schema.String },
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
  ClickedCloseSpace: { space: Schema.String },
  ConfirmedCloseSpace: { space: Schema.String },
  ClickedRenameSpace: { space: Schema.String },
  UpdatedSpaceName: { name: Schema.String },
  SubmittedSpaceName: {},
  SucceededSpaceChange: {},
  ClickedNewSpace: {},
  UpdatedSpaceForm: { field: SpaceFormField, value: Schema.String },
  SubmittedSpaceForm: {},
  SucceededNewSpace: { tab: Schema.String },
  FailedNewSpace: { reason: Schema.String },
  ClickedWorktrees: { space: Schema.String },
  ReceivedWorktrees: { list: RepoCheckouts },
  FailedWorktrees: { reason: Schema.String },
  UpdatedWorktreeField: { field: WorktreeField, value: Schema.String },
  SubmittedWorktree: {},
  ClickedOpenCheckout: { checkout: Checkout },
  ClickedRemoveCheckout: { path: Schema.String },
  ClickedKeepCheckout: {},
  ConfirmedRemoveCheckout: { path: Schema.String },
  SucceededRemoveCheckout: {},
  SucceededCheckoutSpace: { tab: Schema.String },
  FailedCheckoutAction: { reason: Schema.String },
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
  SucceededSendPrompt: { address: Schema.String, id: Schema.Int },
  FailedSendPrompt: { address: Schema.String, id: Schema.Int, reason: Schema.String },
  ClickedSendNow: { address: Schema.String, id: Schema.Int },
  ClickedDropQueued: { address: Schema.String, id: Schema.Int },
  ReceivedInputBox: { address: Schema.String, box: InputBox },
  FailedInputBox: { address: Schema.String },
  ReceivedModel: { address: Schema.String, model: Schema.Option(Schema.String) },
  ClickedModelTag: { address: Schema.String },
  PickedModel: { address: Schema.String, alias: Schema.String },
  SucceededPickModel: {},
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
  CompletedFocusField: {},
  CompletedSaveRecent: {},
})
export type Message = typeof Message.Type

export type UpdateReturn = Update.Return<Model, Message, BridgeClient>
