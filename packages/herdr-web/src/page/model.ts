// The page's state and the messages that change it: one Model and one
// Message for the whole page, since the sidebar, tabs and panes all read and
// change the same selection.
import { Effect, Schema as S } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { BridgeError, Direction } from "../shared/Api.ts"
import { Answer, ChatUpdate, Entry, InputBox, Question } from "../shared/Chat.ts"
import { Fleet } from "../shared/Fleet.ts"
import { ModelChoices } from "../shared/Harness.ts"
import { FontFamily } from "../shared/Fonts.ts"
import { ProviderId, Usage } from "../shared/Usage.ts"
import { Checkout, RepoCheckouts } from "../shared/Worktree.ts"
import { SlashCommand } from "../shared/SlashCommand.ts"
import { TodoItem } from "../shared/Todo.ts"
import { Modifier, Modifiers, SheetModifier, SheetModifiers, SoftKey } from "./keys.ts"
import { PaletteTarget } from "./palette.ts"
import type { BridgeClient } from "./rpc.ts"
import { AgentList, AgentView, loadSettings, Settings, Surface } from "./settings.ts"
import { loadSidebarWidth } from "./sidebarWidth.ts"
import { loadKept, loadStored } from "./stored.ts"
import { Link } from "./terminal.ts"

export const SELECTION_KEY = "herdr-web.selection"
export const RECENT_KEY = "herdr-web.recent"
export const SOFT_KEYS_KEY = "herdr-web.soft-keys"
export const ZOOM_KEY = "herdr-web.zoom"
export const VIEW_PICKS_KEY = "herdr-web.view-picks"

export const Bridge = defineTaggedUnion({
  Waiting: {},
  Watching: { fleet: Fleet },
  Lost: { maybeFleet: S.Option(Fleet) },
})
export type Bridge = typeof Bridge.Type

export const Conversation = defineTaggedUnion({
  Loading: {},
  Shown: { entries: S.Array(Entry) },
  Unreadable: { reason: S.String },
})
export type Conversation = typeof Conversation.Type

/** What a pane shows of its terminal: a Claude Code agent's chat, or the terminal itself, live. */
export const View = defineTaggedUnion({
  Chat: { conversation: Conversation },
  Terminal: { link: Link },
})
export type View = typeof View.Type

export const ViewName = S.Literals(["Chat", "Terminal"])
export type ViewName = typeof ViewName.Type

/**
 * A view picked for an agent's pane, and where it holds: `run:<address>:<pid>`
 * for one run of an agent, or `space:<machine>:<space id>` for a space.
 */
export const ViewPick = S.Struct({ scope: S.String, view: ViewName })
export type ViewPick = typeof ViewPick.Type

/** The last soft key press: taken, or refused with the bridge's reason. */
export const Delivery = defineTaggedUnion({
  Ready: {},
  Refused: { reason: S.String },
})
export type Delivery = typeof Delivery.Type

/** The models an agent may switch to: being read, read, or not readable, and why. */
export const ChoiceList = defineTaggedUnion({
  Loading: {},
  Listed: { choices: ModelChoices },
  Unlisted: { failure: BridgeError },
})
export type ChoiceList = typeof ChoiceList.Type

/**
 * The bridge's pairing with an agent's server, started from the page: none
 * under way, under way for the agent at `address`, or refused, and why.
 */
export const Pairing = defineTaggedUnion({
  Idle: {},
  Pairing: { address: S.String },
  Failed: { address: S.String, reason: S.String },
})
export type Pairing = typeof Pairing.Type

/**
 * A change to a herdr-app pane, tab or space: none under way, a close waiting
 * for a second click, a space's new name being typed, or herdr-app's refusal.
 */
export const PaneAction = defineTaggedUnion({
  Idle: {},
  Confirming: { pane: S.String },
  ConfirmingTab: { tab: S.String },
  ConfirmingSpace: { space: S.String },
  RenamingSpace: { space: S.String, name: S.String },
  /** The model menu of the agent at `address` is open, with the models it may switch to as far as they are read. */
  PickingModel: { address: S.String, choices: ChoiceList },
  Refused: { reason: S.String },
})
export type PaneAction = typeof PaneAction.Type

/** The groups of keys the Send keys sheet offers. */
export const KeyGroup = S.Literals(["Common", "F keys", "Character"])
export type KeyGroup = typeof KeyGroup.Type

/**
 * The Send keys sheet: closed, choosing a key to send or pin, or editing the
 * soft-key row. `named` is the key picked in the Common or F keys group;
 * `typed` is the text in the Character group.
 */
export const KeySheet = defineTaggedUnion({
  Closed: {},
  Choosing: { group: KeyGroup, named: S.String, typed: S.String, modifiers: SheetModifiers },
  Editing: {},
})
export type KeySheet = typeof KeySheet.Type

/**
 * The sheet that shows a terminal link's whole address before it opens, with
 * a note on the last copy: done, or why not.
 */
export const LinkSheet = defineTaggedUnion({
  Closed: {},
  Showing: { uri: S.String, note: S.Option(S.String) },
})
export type LinkSheet = typeof LinkSheet.Type

/** The checkouts on the Worktrees page: being read, read, or not readable. */
export const CheckoutList = defineTaggedUnion({
  Loading: {},
  Listed: { list: RepoCheckouts },
  Unlisted: { reason: S.String },
})
export type CheckoutList = typeof CheckoutList.Type

/**
 * The slash commands of the agent the prompt writes to, read again each time
 * the prompt starts a command, since skills change on disk.
 */
export const CommandList = defineTaggedUnion({
  Unread: {},
  Loading: { address: S.String },
  Listed: { address: S.String, commands: S.Array(SlashCommand) },
  Unlisted: { address: S.String, failure: BridgeError },
})
export type CommandList = typeof CommandList.Type

/** What the Worktrees page is doing: nothing, a removal waiting for a second click, a call under way, or git's refusal. */
export const CheckoutAction = defineTaggedUnion({
  Idle: {},
  Confirming: { path: S.String },
  Busy: {},
  Refused: { reason: S.String },
})
export type CheckoutAction = typeof CheckoutAction.Type

export const WorktreeField = S.Literals(["branch", "program"])
export type WorktreeField = typeof WorktreeField.Type

/** The Worktrees page: its checkouts, the branch and program typed for a new one, and what it is doing. */
export const WorktreePage = S.Struct({ list: CheckoutList, branch: S.String, program: S.String, action: CheckoutAction })
export type WorktreePage = typeof WorktreePage.Type

/** Where the new-space form's last try stands. */
export const SpaceFormState = defineTaggedUnion({
  Editing: {},
  Opening: {},
  Refused: { reason: S.String },
})
export type SpaceFormState = typeof SpaceFormState.Type

export const SpaceFormField = S.Literals(["machine", "folder", "name", "program"])
export type SpaceFormField = typeof SpaceFormField.Type

/**
 * The new-space form. `machine` is the name hc gives it; this machine's own
 * name opens the space here. An empty program opens the shell alone.
 */
export const SpaceForm = S.Struct({
  machine: S.String,
  folder: S.String,
  name: S.String,
  program: S.String,
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
  Pressed: { space: S.String, over: S.Option(S.String) },
  Moving: {},
  Refused: { reason: S.String },
})
export type SpaceDrag = typeof SpaceDrag.Type

/** The command palette: shut, or open on what is typed and the result the arrow keys reached. */
export const Palette = defineTaggedUnion({
  Closed: {},
  Open: { query: S.String, highlighted: S.Int },
})
export type Palette = typeof Palette.Type

// The page keeps its own selection: following herdr-app's window would move
// the page whenever the user works at the desk.
export const Selection = defineTaggedUnion({
  Nothing: {},
  /** A herdr-app tab, and the pane the prompt and keys go to; none means its first terminal. */
  Tab: { tabId: S.String, maybeFocus: S.Option(S.String) },
  /** A terminal that no herdr-app layout shows, alone. */
  Loose: { address: S.String },
  /** This browser's settings, in place of a tab. */
  Settings: {},
  /** The form that opens a space, in place of a tab. */
  NewSpace: {},
  /** The checkouts of the repository a space is in, in place of a tab. */
  Worktrees: { space: S.String },
})
export type Selection = typeof Selection.Type

/** The fonts the bridge serves, asked for when settings open. */
export const FontCatalog = defineTaggedUnion({
  Loading: {},
  Loaded: { families: S.Array(FontFamily) },
  Failed: { reason: S.String },
})
export type FontCatalog = typeof FontCatalog.Type

/**
 * A prompt sent to the agent and not yet in its transcript. `seen` is how many
 * prompts with this text the chat held when it was sent. `sentAt` is the
 * clock's first reading after the send: the page learns the time only from
 * the clock, which reads it at once when a wait starts.
 */
export const Waiting = S.Struct({ address: S.String, text: S.String, seen: S.Int, sentAt: S.Option(S.Finite) })
export type Waiting = typeof Waiting.Type

/** A queued message: waiting for its agent, on its way, or refused by the bridge and held until the agent changes. */
export const QueueState = defineTaggedUnion({
  Waits: {},
  Sending: {},
  Held: { reason: S.String },
})
export type QueueState = typeof QueueState.Type

/** A message for the agent at `address`, in the order the user sent it. `id` tells apart two messages with the same text. */
export const Queued = S.Struct({ address: S.String, id: S.Int, text: S.String, state: QueueState })
export type Queued = typeof Queued.Type

/**
 * What the user writes to one agent, in its chat's prompt. For an agent whose
 * input box the page reads, the prompt and the box mirror each other (see
 * mirror.ts): `agreed` is the text both last held, with the box's text as the
 * page read it then. `problem` is why the page last failed to write the box.
 */
export const Prompt = S.Struct({
  text: S.String,
  agreed: S.Struct({ text: S.String, typed: S.String }),
  isWriting: S.Boolean,
  problem: S.Option(S.String),
})
export type Prompt = typeof Prompt.Type

/** What the page knows of the question an agent waits on. */
export const Asking = defineTaggedUnion({
  Reading: {},
  /** `sending` is the answer on its way to the agent. */
  Shown: { question: Question, sending: S.Option(Answer) },
  /** The agent waits, but its screen shows no menu the page can answer. */
  Unshown: { reason: S.Option(S.String) },
})
export type Asking = typeof Asking.Type

/**
 * The question of one blocked agent. `statusMs` names the status it was read
 * under, and `reads` counts the reads under that status: an answer, taken or
 * refused, reads the screen again, since a series of questions keeps one status.
 */
export const Asked = S.Struct({ statusMs: S.Int, reads: S.Int, notice: S.Option(S.String), asking: Asking })
export type Asked = typeof Asked.Type

export const Model = S.Struct({
  bridge: Bridge,
  /** On a phone the sidebar folds away once a tab or agent is picked, to give the panes the screen. */
  isFleetFolded: S.Boolean,
  /** The focused pane fills the window: the sidebar, the bars over and under the panes, and the other panes hide. */
  isZoomed: S.Boolean,
  /** The views picked for agents' panes, newest first; see openingView.ts. */
  viewPicks: S.Array(ViewPick),
  selection: Selection,
  /** The view of each shown terminal; a terminal not in it shows its default view. */
  views: S.Record(S.String, View),
  /** Each agent's prompt, by address; an agent not in it has an empty one. */
  prompts: S.Record(S.String, Prompt),
  delivery: Delivery,
  /** The messages not yet handed to their agents (see queue.ts). */
  queued: S.Array(Queued),
  /** What each watched agent's input box in the terminal holds, by address; none before the first reading. */
  boxes: S.Record(S.String, InputBox),
  /** The model each shown agent answers with, by address, as the bridge's `model` call names it. */
  models: S.Record(S.String, S.String),
  /** The todo list of each watched agent that has one, by address (see todos.ts). */
  todos: S.Record(S.String, S.Array(TodoItem)),
  /** The prompts the chats show as faded bubbles until the agent records them. */
  waiting: S.Array(Waiting),
  /** The question each blocked agent in a chat waits on, by address. */
  questions: S.Record(S.String, Asked),
  paneAction: PaneAction,
  spaceDrag: SpaceDrag,
  spaceForm: SpaceForm,
  worktreePage: WorktreePage,
  palette: Palette,
  /** The panes opened last, newest first, for the palette's Recent group. */
  recent: S.Array(S.String),
  settings: Settings,
  /** Soft ctrl and alt, armed until the next key. */
  modifiers: Modifiers,
  /** The soft-key row this browser keeps; none for the default row, so a browser that never changed it gets later defaults. */
  softKeys: S.Option(S.Array(SoftKey)),
  keySheet: KeySheet,
  linkSheet: LinkSheet,
  commandList: CommandList,
  pairing: Pairing,
  fontCatalog: FontCatalog,
  /** Each coding plan's usage, from the bridge; none before its first reading. */
  usage: S.Option(Usage),
  /** The plan whose usage panel is open. */
  usageDetail: S.Option(ProviderId),
  /** The time, for countdowns to a reset. */
  now: S.Finite,
  /** The sidebar's width on a desk once its edge was dragged; none is the stylesheet's own. */
  sidebarWidth: S.Option(S.Int),
  /** While the edge is dragged: how far right of the edge the pointer took hold of it. */
  sidebarGrip: S.Option(S.Finite),
  /**
   * The part of the window a person sees, in CSS pixels from the top of the
   * layout: smaller than the window while a phone's keyboard is open. None
   * where the browser does not report it, or while the page is zoomed.
   */
  viewport: S.Option(S.Struct({ top: S.Finite, height: S.Finite })),
})
export type Model = typeof Model.Type

/** What the page starts from: this browser's settings, the tab and pane it showed last, and its sidebar's width. */
export const Flags = S.Struct({
  settings: Settings,
  selection: Selection,
  sidebarWidth: S.Option(S.Int),
  /** The panes opened last, newest first. */
  recent: S.Array(S.String),
  /** The soft-key row this browser keeps; none for the default row. */
  softKeys: S.Option(S.Array(SoftKey)),
  isZoomed: S.Boolean,
  viewPicks: S.Array(ViewPick),
})
export type Flags = typeof Flags.Type

export const loadFlags = Effect.all({
  settings: loadSettings,
  selection: loadStored(SELECTION_KEY, Selection, Selection.Nothing()),
  sidebarWidth: loadSidebarWidth,
  recent: loadStored(RECENT_KEY, S.Array(S.String), []),
  softKeys: loadKept(SOFT_KEYS_KEY, S.Array(SoftKey)),
  isZoomed: loadStored(ZOOM_KEY, S.Boolean, false),
  viewPicks: loadStored(VIEW_PICKS_KEY, S.Array(ViewPick), []),
})

// MESSAGE

export const Message = defineMessageUnion({
  ReceivedFleet: { fleet: Fleet },
  LostBridge: {},
  ClickedFleetToggle: {},
  ClickedTerminal: { address: S.String },
  ClickedTab: { tabId: S.String },
  FocusedPane: { address: S.String },
  SelectedView: { address: S.String, view: ViewName },
  ReceivedChat: { address: S.String, update: ChatUpdate },
  ReceivedQuestion: { address: S.String, statusMs: S.Int, question: S.Option(Question) },
  FailedQuestion: { address: S.String, statusMs: S.Int, reason: S.String },
  ClickedChoice: { address: S.String, choice: S.Int },
  SucceededAnswer: { address: S.String },
  FailedAnswer: { address: S.String, reason: S.String },
  FailedChat: { address: S.String, reason: S.String },
  ChangedLink: { address: S.String, link: Link },
  ClickedSplit: { pane: S.String, direction: Direction },
  SucceededSplit: { terminal: S.String },
  ClickedClose: { pane: S.String },
  ClickedKeepPane: {},
  ConfirmedClose: { pane: S.String },
  SucceededClose: {},
  ClickedNewTab: { space: S.String },
  SucceededNewTab: { tab: S.String },
  ClickedCloseTab: { tab: S.String },
  ConfirmedCloseTab: { tab: S.String },
  SucceededCloseTab: {},
  ClickedCloseSpace: { space: S.String },
  ConfirmedCloseSpace: { space: S.String },
  ClickedRenameSpace: { space: S.String },
  UpdatedSpaceName: { name: S.String },
  SubmittedSpaceName: {},
  SucceededSpaceChange: {},
  ClickedNewSpace: {},
  UpdatedSpaceForm: { field: SpaceFormField, value: S.String },
  SubmittedSpaceForm: {},
  SucceededNewSpace: { tab: S.String },
  FailedNewSpace: { reason: S.String },
  ClickedWorktrees: { space: S.String },
  ReceivedWorktrees: { list: RepoCheckouts },
  FailedWorktrees: { reason: S.String },
  UpdatedWorktreeField: { field: WorktreeField, value: S.String },
  SubmittedWorktree: {},
  ClickedOpenCheckout: { checkout: Checkout },
  ClickedRemoveCheckout: { path: S.String },
  ClickedKeepCheckout: {},
  ConfirmedRemoveCheckout: { path: S.String },
  SucceededRemoveCheckout: {},
  SucceededCheckoutSpace: { tab: S.String },
  FailedCheckoutAction: { reason: S.String },
  FailedPaneAction: { reason: S.String },
  PressedSpace: { space: S.String },
  EnteredSpace: { space: S.String },
  ReleasedSpace: { space: S.String },
  /** The press ended away from a space row, or the pointer left the sidebar. */
  DroppedSpaceDrag: {},
  SucceededMoveSpace: {},
  FailedMoveSpace: { reason: S.String },
  ClickedSettings: {},
  PickedFont: { surface: Surface, font: S.Option(S.String) },
  SteppedSize: { surface: Surface, step: S.Int },
  PickedAgentList: { agents: AgentList },
  PickedAgentView: { agentView: AgentView },
  CompletedSaveSettings: {},
  CompletedSaveSelection: {},
  ReceivedFonts: { families: S.Array(FontFamily) },
  FailedFonts: { reason: S.String },
  UpdatedPrompt: { text: S.String },
  ReceivedCommands: { address: S.String, commands: S.Array(SlashCommand) },
  FailedCommands: { address: S.String, failure: BridgeError },
  PickedCommand: { name: S.String },
  SubmittedPrompt: {},
  SucceededSendPrompt: { address: S.String, id: S.Int },
  FailedSendPrompt: { address: S.String, id: S.Int, reason: S.String },
  ClickedSendNow: { address: S.String, id: S.Int },
  ClickedDropQueued: { address: S.String, id: S.Int },
  ReceivedInputBox: { address: S.String, box: InputBox },
  PausedTyping: { address: S.String, text: S.String },
  WroteInputBox: { address: S.String, text: S.String, box: InputBox },
  FailedWriteInputBox: { address: S.String, reason: S.String },
  FailedInputBox: { address: S.String },
  ReceivedModel: { address: S.String, model: S.Option(S.String) },
  ReceivedTodos: { address: S.String, todos: S.Array(TodoItem) },
  ClickedModelTag: { address: S.String },
  ReceivedModelChoices: { address: S.String, choices: ModelChoices },
  FailedModelChoices: { address: S.String, failure: BridgeError },
  PickedModel: { address: S.String, alias: S.String },
  ClickedPair: { address: S.String },
  SucceededPair: { address: S.String },
  FailedPair: { address: S.String, reason: S.String },
  SucceededPickModel: {},
  ClickedKey: { key: S.String },
  ToggledModifier: { modifier: Modifier },
  ClickedSendKeys: {},
  ClosedKeySheet: {},
  PickedKeyGroup: { group: KeyGroup },
  PickedSheetKey: { key: S.String },
  TypedSheetCharacter: { text: S.String },
  ToggledSheetModifier: { modifier: SheetModifier },
  ClickedSendSheetKey: {},
  ClickedPinSheetKey: {},
  ClickedEditSoftKeys: {},
  MovedSoftKey: { index: S.Int, by: S.Literals([-1, 1]) },
  RemovedSoftKey: { index: S.Int },
  ClickedRestoreSoftKeys: {},
  CompletedSaveSoftKeys: {},
  PointedAtLink: { uri: S.String },
  ClosedLinkSheet: {},
  ClickedCopyLink: {},
  CopiedLink: {},
  FailedCopyLink: { reason: S.String },
  UsedModifiers: {},
  CompletedKeepTypingFocus: {},
  SucceededPressKeys: { address: S.String },
  FailedPressKeys: { address: S.String, reason: S.String },
  ReceivedUsage: { usage: Usage },
  ToggledUsageDetail: { provider: ProviderId },
  ClickedRefreshUsage: { provider: S.Option(ProviderId) },
  CompletedRefreshUsage: {},
  TickedClock: { now: S.Finite },
  PressedSidebarEdge: { x: S.Finite },
  MovedSidebarEdge: { x: S.Finite },
  ReleasedSidebarEdge: {},
  ChangedViewport: { viewport: S.Option(S.Struct({ top: S.Finite, height: S.Finite })) },
  KeyedSidebarEdge: { key: S.String },
  ResetSidebarWidth: {},
  CompletedSaveSidebarWidth: {},
  ClickedZoom: {},
  CompletedSaveZoom: {},
  CompletedSaveViewPicks: {},
  PressedPaletteKey: {},
  ClosedPalette: {},
  UpdatedPaletteQuery: { text: S.String },
  MovedPaletteHighlight: { step: S.Int },
  OpenedPaletteResult: { target: PaletteTarget },
  SubmittedPalette: {},
  CompletedFocusField: {},
  CompletedSaveRecent: {},
})
export type Message = typeof Message.Type

export type UpdateReturn = Update.Return<Model, Message, BridgeClient>
