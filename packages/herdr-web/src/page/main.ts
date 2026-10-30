import { Array, Clock, Effect, Match, Option, Record, Result, Schedule, Schema, Stream, String } from "effect"
import { Command, Subscription, type Update } from "foldkit"
import * as Dom from "foldkit/dom"
import * as Mount from "foldkit/mount"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { Direction } from "../shared/Api.ts"
import { ChatUpdate, Entry } from "../shared/Chat.ts"
import { FontFamily } from "../shared/Fonts.ts"
import { ProviderId, Usage } from "../shared/Usage.ts"
import { Fleet, type Layout, type Size, type Space, type StatusState, type Tab, type Terminal } from "../shared/Fleet.ts"
import { chatView } from "./chatView.ts"
import { agentsIn, dropSide, type DropSide, locate, type MachineRow, sidebarOf, spaceRowOf, spacesOf, type SpaceRow, terminalLabel, terminalNote, terminalsIn } from "./group.ts"
import { Bot, Columns2, Folder, icon, type IconNode, MessageSquare, Monitor, PanelLeft, Rows2, Server, Settings as SettingsIcon, SquareTerminal, X } from "./icons.ts"
import { BridgeClient, failureReason, reportFailure } from "./rpc.ts"
import { AgentList, fontStack, loadSettings, MAX_SIZE, MIN_SIZE, restyle, saveSettings, Settings, stepSize, Surface, type TextStyle } from "./settings.ts"
import { loadStored, saveStored } from "./stored.ts"
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, keyedSidebarWidth, loadSidebarWidth, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, saveSidebarWidth } from "./sidebarWidth.ts"
import { KeepTypingFocus, Modifier, Modifiers, modifiersAttribute, NO_MODIFIERS, SOFT_KEYS, withModifiers } from "./keys.ts"
import { Link, LiveTerminal, MODIFIERS_ATTRIBUTE } from "./terminal.ts"
import { usageBarView } from "./usage.ts"

// CONSTANT

const RECONNECT_DELAY = "2 seconds"
/** Reset countdowns count in minutes. */
const CLOCK_TICK = "30 seconds"
/** The app name hc's status gives a Claude Code agent. */
const CLAUDE_CODE = "claude-code"
const SELECTION_KEY = "herdr-web.selection"

// MODEL

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

const ViewName = Schema.Literals(["Chat", "Terminal"])
type ViewName = typeof ViewName.Type

export const Delivery = defineTaggedUnion({
  Ready: {},
  Sending: {},
  Refused: { reason: Schema.String },
})
export type Delivery = typeof Delivery.Type

/** A split or close of a herdr-app pane: none under way, a close waiting for a second click, or herdr-app's refusal. */
export const PaneAction = defineTaggedUnion({
  Idle: {},
  Confirming: { pane: Schema.String },
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

export const Model = Schema.Struct({
  bridge: Bridge,
  /** On a phone the sidebar folds away once a tab or agent is picked, to give the panes the screen. */
  isFleetFolded: Schema.Boolean,
  selection: Selection,
  /** The view of each shown terminal; a terminal not in it shows its default view. */
  views: Schema.Record(Schema.String, View),
  prompt: Schema.String,
  delivery: Delivery,
  paneAction: PaneAction,
  spaceDrag: SpaceDrag,
  settings: Settings,
  /** Soft ctrl and alt, armed until the next key. */
  modifiers: Modifiers,
  /** Settings take the workspace's place while open. */
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
export const Flags = Schema.Struct({ settings: Settings, selection: Selection, sidebarWidth: Schema.Option(Schema.Int) })
export type Flags = typeof Flags.Type

export const loadFlags = Effect.all({
  settings: loadSettings,
  selection: loadStored(SELECTION_KEY, Selection, Selection.Nothing()),
  sidebarWidth: loadSidebarWidth,
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
})
export type Message = typeof Message.Type

// INIT

export const init = ({ settings, selection, sidebarWidth }: Flags): UpdateReturn => ({
  model: {
    bridge: Bridge.Waiting(),
    // A page that opens on a remembered tab shows it at once, on a phone too.
    isFleetFolded: selection._tag !== "Nothing",
    selection,
    views: {},
    prompt: "",
    delivery: Delivery.Ready(),
    paneAction: PaneAction.Idle(),
    spaceDrag: SpaceDrag.Idle(),
    settings,
    modifiers: NO_MODIFIERS,
    fontCatalog: FontCatalog.Loading(),
    usage: Option.none(),
    usageDetail: Option.none(),
    now: 0,
    sidebarWidth,
    sidebarGrip: Option.none(),
  },
  commands: selection._tag === "Settings" ? [FetchFonts()] : [],
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ReceivedFleet: ({ fleet }) => ({ model: modifyFields(model, { bridge: () => Bridge.Watching({ fleet }) }) }),

    LostBridge: () => ({
      model: modifyFields(model, { bridge: () => Bridge.Lost({ maybeFleet: lastFleet(model.bridge) }) }),
    }),

    ClickedFleetToggle: () => ({ model: modifyFields(model, { isFleetFolded: (isFolded) => !isFolded }) }),

    ClickedTerminal: ({ address }) =>
      remembered(
        selected(
          modifyFields(model, { isFleetFolded: () => true }),
          Option.match(Option.flatMap(lastFleet(model.bridge), (fleet) => locate(fleet, address)), {
            onNone: () => Selection.Loose({ address }),
            onSome: ({ tab }) => Selection.Tab({ tabId: tab.id, maybeFocus: Option.some(address) }),
          }),
        ),
      ),

    ClickedTab: ({ tabId }) =>
      remembered(selected(modifyFields(model, { isFleetFolded: () => true }), Selection.Tab({ tabId, maybeFocus: Option.none() }))),

    // The pane head carries the close button, so a focus keeps a close waiting for its second click.
    FocusedPane: ({ address }) =>
      Selection.match<UpdateReturn>(model.selection, {
        Nothing: () => ({ model }),
        // The tab and its views stay; only the prompt's last reply was for the old focus.
        Tab: ({ tabId, maybeFocus }) =>
          Option.contains(maybeFocus, address)
            ? { model }
            : remembered(
                modifyFields(model, {
                  selection: () => Selection.Tab({ tabId, maybeFocus: Option.some(address) }),
                  delivery: () => Delivery.Ready(),
                }),
              ),
        Loose: () => ({ model }),
        Settings: () => ({ model }),
      }),

    // A terminal view attaches when its pane appears, and lets go when it leaves.
    SelectedView: ({ address, view }) => ({ model: withView(model, address, () => newView(view)) }),

    ReceivedChat: ({ address, update }) => ({
      model: withView(model, address, (view) =>
        withConversation(view, (conversation) =>
          Conversation.Shown({
            entries: Match.valueTags(update, {
              Reset: ({ entries }) => entries,
              Appended: ({ entries }) => Array.appendAll(shownEntries(conversation), entries),
            }),
          }),
        ),
      ),
    }),

    FailedChat: ({ address, reason }) => ({
      model: withView(model, address, (view) => withConversation(view, () => Conversation.Unreadable({ reason }))),
    }),

    ChangedLink: ({ address, link }) => ({
      model: withView(model, address, (view) => View.match(view, { Chat: () => view, Terminal: () => View.Terminal({ link }) })),
    }),

    ClickedSplit: ({ pane, direction }) => ({
      model: modifyFields(model, { paneAction: () => PaneAction.Idle() }),
      commands: [SplitPane({ pane, direction })],
    }),

    // The new shell takes the focus once the fleet shows it in the tab.
    SucceededSplit: ({ terminal }) =>
      Selection.match<UpdateReturn>(model.selection, {
        Nothing: () => ({ model }),
        Tab: ({ tabId }) => remembered(modifyFields(model, { selection: () => Selection.Tab({ tabId, maybeFocus: Option.some(terminal) }) })),
        Loose: () => ({ model }),
        Settings: () => ({ model }),
      }),

    // Closing a pane ends its program, so it takes a second click.
    ClickedClose: ({ pane }) => ({ model: modifyFields(model, { paneAction: () => PaneAction.Confirming({ pane }) }) }),

    ClickedKeepPane: () => ({ model: modifyFields(model, { paneAction: () => PaneAction.Idle() }) }),

    ConfirmedClose: ({ pane }) => ({
      model: modifyFields(model, { paneAction: () => PaneAction.Idle() }),
      commands: [ClosePane({ pane })],
    }),

    SucceededClose: () => ({ model }),

    FailedPaneAction: ({ reason }) => ({ model: modifyFields(model, { paneAction: () => PaneAction.Refused({ reason }) }) }),

    // A press while a move is under way waits for the fleet's new order.
    PressedSpace: ({ space }) =>
      model.spaceDrag._tag === "Moving"
        ? { model }
        : { model: modifyFields(model, { spaceDrag: () => SpaceDrag.Pressed({ space, over: Option.none() }) }) },

    EnteredSpace: ({ space: over }) =>
      SpaceDrag.match<UpdateReturn>(model.spaceDrag, {
        Idle: () => ({ model }),
        Pressed: ({ space }) => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Pressed({ space, over: Option.some(over) }) }) }),
        Moving: () => ({ model }),
        Refused: () => ({ model }),
      }),

    // A release on the pressed row is a click, which opens the space.
    ReleasedSpace: ({ space: onto }) =>
      SpaceDrag.match<UpdateReturn>(model.spaceDrag, {
        Idle: () => ({ model }),
        Pressed: ({ space }) =>
          Option.match(Option.flatMap(lastFleet(model.bridge), (fleet) => dropSide(fleet, space, onto)), {
            onNone: () => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Idle() }) }),
            onSome: () => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Moving() }), commands: [MoveSpace({ space, onto })] }),
          }),
        Moving: () => ({ model }),
        Refused: () => ({ model }),
      }),

    DroppedSpaceDrag: () =>
      model.spaceDrag._tag === "Pressed" ? { model: modifyFields(model, { spaceDrag: () => SpaceDrag.Idle() }) } : { model },

    SucceededMoveSpace: () => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Idle() }) }),

    FailedMoveSpace: ({ reason }) => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Refused({ reason }) }) }),

    // On a phone the settings open behind the sidebar drawer, so it closes as a picked tab closes it.
    ClickedSettings: () =>
      model.selection._tag === "Settings"
        ? { model: modifyFields(model, { isFleetFolded: () => true }) }
        : openSettings(model),

    PickedFont: ({ surface, font }) => settingsChanged(model, restyle(model.settings, surface, (style) => ({ ...style, font }))),

    SteppedSize: ({ surface, step }) => settingsChanged(model, restyle(model.settings, surface, (style) => stepSize(style, step))),

    PickedAgentList: ({ agents }) => settingsChanged(model, { ...model.settings, agents }),
    CompletedSaveSettings: () => ({ model }),

    CompletedSaveSelection: () => ({ model }),

    ReceivedFonts: ({ families }) => ({ model: modifyFields(model, { fontCatalog: () => FontCatalog.Loaded({ families }) }) }),

    FailedFonts: ({ reason }) => ({ model: modifyFields(model, { fontCatalog: () => FontCatalog.Failed({ reason }) }) }),

    UpdatedPrompt: ({ text }) => ({ model: modifyFields(model, { prompt: () => text }) }),

    SubmittedPrompt: () =>
      Option.match(maybeFocus(model), {
        onNone: () => ({ model }),
        onSome: (address) =>
          String.isEmpty(String.trim(model.prompt))
            ? { model }
            : {
                model: modifyFields(model, { delivery: () => Delivery.Sending() }),
                commands: [SendPrompt({ address, text: model.prompt })],
              },
      }),

    SucceededSendPrompt: ({ address }) =>
      whenFocused(model, address, () => ({
        model: modifyFields(model, { prompt: () => "", delivery: () => Delivery.Ready() }),
      })),

    FailedSendPrompt: ({ address, reason }) =>
      whenFocused(model, address, () => ({ model: modifyFields(model, { delivery: () => Delivery.Refused({ reason }) }) })),

    ClickedKey: ({ key }) =>
      Option.match(maybeFocus(model), {
        onNone: () => ({ model }),
        onSome: (address) => ({
          model: modifyFields(model, { modifiers: () => NO_MODIFIERS }),
          commands: [PressKeys({ address, keys: [withModifiers(key, model.modifiers)] })],
        }),
      }),

    ToggledModifier: ({ modifier }) =>
      ({ model: modifyFields(model, { modifiers: (armed) => ({ ...armed, [modifier]: !armed[modifier] }) }) }),

    UsedModifiers: () => ({ model: modifyFields(model, { modifiers: () => NO_MODIFIERS }) }),

    CompletedKeepTypingFocus: () => ({ model }),

    SucceededPressKeys: ({ address }) =>
      whenFocused(model, address, () => ({ model: modifyFields(model, { delivery: () => Delivery.Ready() }) })),

    FailedPressKeys: ({ address, reason }) =>
      whenFocused(model, address, () => ({ model: modifyFields(model, { delivery: () => Delivery.Refused({ reason }) }) })),

    ReceivedUsage: ({ usage }) => ({ model: modifyFields(model, { usage: () => Option.some(usage) }) }),

    ToggledUsageDetail: ({ provider }) => ({
      model: modifyFields(model, {
        usageDetail: (open) => (Option.contains(open, provider) ? Option.none() : Option.some(provider)),
      }),
    }),

    ClickedRefreshUsage: ({ provider }) => ({ model, commands: [RefreshUsage({ provider })] }),

    CompletedRefreshUsage: () => ({ model }),

    TickedClock: ({ now }) => ({ model: modifyFields(model, { now: () => now }) }),

    // The sidebar starts at the page's left edge, so its width is where the pointer is, less its grip.
    PressedSidebarEdge: ({ x }) => ({ model: modifyFields(model, { sidebarGrip: () => Option.some(x - shownSidebarWidth(model)) }) }),

    MovedSidebarEdge: ({ x }) =>
      Option.match(model.sidebarGrip, {
        onNone: () => ({ model }),
        onSome: (grip) => ({ model: modifyFields(model, { sidebarWidth: () => Option.some(clampSidebarWidth(x - grip)) }) }),
      }),

    // The width is kept once, when the edge is let go.
    ReleasedSidebarEdge: () => ({
      model: modifyFields(model, { sidebarGrip: () => Option.none() }),
      commands: [SaveSidebarWidth({ width: model.sidebarWidth })],
    }),

    KeyedSidebarEdge: ({ key }) =>
      Option.match(keyedSidebarWidth(shownSidebarWidth(model), key), {
        onNone: () => ({ model }),
        onSome: (width) => ({
          model: modifyFields(model, { sidebarWidth: () => Option.some(width) }),
          commands: [SaveSidebarWidth({ width: Option.some(width) })],
        }),
      }),

    ResetSidebarWidth: () => ({
      model: modifyFields(model, { sidebarWidth: () => Option.none() }),
      commands: [SaveSidebarWidth({ width: Option.none() })],
    }),

    CompletedSaveSidebarWidth: () => ({ model }),
  })

type UpdateReturn = Update.Return<Model, Message, BridgeClient>

const lastFleet = (bridge: Bridge) =>
  Bridge.match(bridge, {
    Waiting: () => Option.none<Fleet>(),
    Watching: ({ fleet }) => Option.some(fleet),
    Lost: ({ maybeFleet }) => maybeFleet,
  })

/** The selected tab and the space that holds it, while the fleet still has them. */
const selectedTab = (model: Model): Option.Option<Readonly<{ space: Space; tab: Tab }>> =>
  Selection.match(model.selection, {
    Nothing: () => Option.none(),
    Tab: ({ tabId }) =>
      Option.flatMap(lastFleet(model.bridge), (fleet) =>
        Array.findFirst(spacesOf(fleet), (space) =>
          Option.map(
            Array.findFirst(space.tabs, (tab) => tab.id === tabId),
            (tab) => ({ space, tab }),
          ),
        ),
      ),
    Loose: () => Option.none(),
    Settings: () => Option.none(),
  })

/** The terminals on show, in the layout's reading order. */
const shownTerminals = (model: Model): ReadonlyArray<string> =>
  Selection.match(model.selection, {
    Nothing: () => [],
    Tab: () => Option.match(selectedTab(model), { onNone: () => [], onSome: ({ tab }) => terminalsIn(tab.root) }),
    Loose: ({ address }) => [address],
    Settings: () => [],
  })

/** The terminal the prompt and keys go to: the chosen pane while it is on show, else the first one. */
const maybeFocus = (model: Model) => {
  const shown = shownTerminals(model)
  return Selection.match(model.selection, {
    Nothing: () => Option.none<string>(),
    Tab: ({ maybeFocus }) =>
      Option.orElse(
        Option.filter(maybeFocus, (address) => Array.contains(shown, address)),
        () => Array.head(shown),
      ),
    Loose: ({ address }) => Option.some(address),
    Settings: () => Option.none<string>(),
  })
}

// A new selection forgets the views it no longer shows, and any reply to the
// last prompt.
const selected = (model: Model, selection: Selection) => {
  const next = modifyFields(model, { selection: () => selection, delivery: () => Delivery.Ready(), paneAction: () => PaneAction.Idle() })
  const shown = shownTerminals(next)
  return modifyFields(next, { views: (views) => Record.filter(views, (_, address) => Array.contains(shown, address)) })
}

/** The terminal's view: the one picked for it, else the terminal itself. */
const viewOf = (model: Model, address: string) => Option.getOrElse(Record.get(model.views, address), () => newView("Terminal"))

/** The shown terminals whose view is `name`. */
const openAs = (model: Model, name: ViewName) =>
  Array.filter(shownTerminals(model), (address) => viewOf(model, address)._tag === name)

// A reply names the terminal it is for. One for a terminal no longer on show
// is dropped, so a late reply cannot bring back a view the page forgot.
const withView = (model: Model, address: string, change: (view: View) => View) =>
  Array.contains(shownTerminals(model), address)
    ? modifyFields(model, { views: (views) => Record.set(views, address, change(viewOf(model, address))) })
    : model

/** Applies a reply to the prompt or keys only while their terminal is still the focus. */
const whenFocused = (model: Model, address: string, apply: () => UpdateReturn): UpdateReturn =>
  Option.contains(maybeFocus(model), address) ? apply() : { model }

const newView = (name: ViewName) =>
  Match.value(name).pipe(
    Match.when("Chat", () => View.Chat({ conversation: Conversation.Loading() })),
    Match.when("Terminal", () => View.Terminal({ link: { _tag: "Connecting" } })),
    Match.exhaustive,
  )

const withConversation = (view: View, change: (conversation: Conversation) => Conversation) =>
  View.match(view, { Chat: ({ conversation }) => View.Chat({ conversation: change(conversation) }), Terminal: () => view })

const shownEntries = (conversation: Conversation) =>
  Conversation.match(conversation, { Loading: () => [], Shown: ({ entries }) => entries, Unreadable: () => [] })

/** Whether hc reports a Claude Code agent in the terminal; only those have a chat to read. */
const isClaudeCode = (model: Model, address: string) =>
  Option.exists(findTerminal(model, address), ({ status }) =>
    Option.exists(status, ({ app }) => Option.contains(app, CLAUDE_CODE)),
  )

// A pane can outlive its terminal until herdr-app's layout catches up.
const labelAt = (model: Model, address: string) => Option.match(findTerminal(model, address), { onNone: () => "closed terminal", onSome: terminalLabel })

const findTerminal = (model: Model, address: string) =>
  Option.flatMap(lastFleet(model.bridge), ({ terminals }) => Array.findFirst(terminals, (terminal) => terminal.address === address))

// COMMAND

export const SplitPane = Command.define("SplitPane", {
  args: { pane: Schema.String, direction: Direction },
  messages: [Message.SucceededSplit, Message.FailedPaneAction],
  execute: ({ pane, direction }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      const { terminal } = yield* client.split({ pane, direction })
      return Message.SucceededSplit({ terminal })
    }).pipe(reportFailure((reason) => Message.FailedPaneAction({ reason }))),
})

// The settings in use are already in the model, so a save that fails costs
// only the next visit's settings; it is logged, not shown.
const settingsChanged = (model: Model, settings: Settings) => ({
  model: modifyFields(model, { settings: () => settings }),
  commands: [SaveSettings({ settings })],
})

export const SaveSettings = Command.define("SaveSettings", {
  args: { settings: Settings },
  messages: [Message.CompletedSaveSettings],
  execute: ({ settings }) => saveSettings(settings).pipe(Effect.as(Message.CompletedSaveSettings())),
})

/** Keeps the tab and pane on show, so a reload opens on them. */
/** Shows the settings in place of the tab, and asks the bridge for its fonts again. */
const openSettings = (model: Model): UpdateReturn => {
  const next = selected(modifyFields(model, { isFleetFolded: () => true, fontCatalog: () => FontCatalog.Loading() }), Selection.Settings())
  return { model: next, commands: [SaveSelection({ selection: next.selection }), FetchFonts()] }
}

const remembered = (model: Model) => ({ model, commands: [SaveSelection({ selection: model.selection })] })

const shownSidebarWidth = (model: Model) => Option.getOrElse(model.sidebarWidth, () => DEFAULT_SIDEBAR_WIDTH)

export const SaveSidebarWidth = Command.define("SaveSidebarWidth", {
  args: { width: Schema.Option(Schema.Int) },
  messages: [Message.CompletedSaveSidebarWidth],
  execute: ({ width }) => saveSidebarWidth(width).pipe(Effect.as(Message.CompletedSaveSidebarWidth())),
})

export const SaveSelection = Command.define("SaveSelection", {
  args: { selection: Selection },
  messages: [Message.CompletedSaveSelection],
  execute: ({ selection }) => saveStored(SELECTION_KEY, Selection, selection).pipe(Effect.as(Message.CompletedSaveSelection())),
})

export const FetchFonts = Command.define("FetchFonts", {
  messages: [Message.ReceivedFonts, Message.FailedFonts],
  execute: Effect.gen(function* () {
    const client = yield* BridgeClient
    return Message.ReceivedFonts({ families: yield* client.fonts() })
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedFonts({ reason: failureReason(error) })))),
})

export const ClosePane = Command.define("ClosePane", {
  args: { pane: Schema.String },
  messages: [Message.SucceededClose, Message.FailedPaneAction],
  execute: ({ pane }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.closePane({ pane })
      return Message.SucceededClose()
    }).pipe(reportFailure((reason) => Message.FailedPaneAction({ reason }))),
})

export const MoveSpace = Command.define("MoveSpace", {
  args: { space: Schema.String, onto: Schema.String },
  messages: [Message.SucceededMoveSpace, Message.FailedMoveSpace],
  execute: ({ space, onto }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.moveSpace({ space, onto })
      return Message.SucceededMoveSpace()
    }).pipe(reportFailure((reason) => Message.FailedMoveSpace({ reason }))),
})

export const SendPrompt = Command.define("SendPrompt", {
  args: { address: Schema.String, text: Schema.String },
  messages: [Message.SucceededSendPrompt, Message.FailedSendPrompt],
  execute: ({ address, text }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.send({ terminal: address, text })
      return Message.SucceededSendPrompt({ address })
    }).pipe(reportFailure((reason) => Message.FailedSendPrompt({ address, reason }))),
})

// The reading that follows arrives on the usage subscription; a refresh the
// bridge did not take costs only a stale number, so it is logged.
export const RefreshUsage = Command.define("RefreshUsage", {
  args: { provider: Schema.Option(ProviderId) },
  messages: [Message.CompletedRefreshUsage],
  execute: ({ provider }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.refreshUsage({ provider })
    }).pipe(
      Effect.catch((error) => Effect.logWarning("the bridge did not refresh the usage", failureReason(error))),
      Effect.as(Message.CompletedRefreshUsage()),
    ),
})

export const PressKeys = Command.define("PressKeys", {
  args: { address: Schema.String, keys: Schema.Array(Schema.String) },
  messages: [Message.SucceededPressKeys, Message.FailedPressKeys],
  execute: ({ address, keys }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      yield* client.keys({ terminal: address, keys })
      return Message.SucceededPressKeys({ address })
    }).pipe(reportFailure((reason) => Message.FailedPressKeys({ address, reason }))),
})

// SUBSCRIPTION

// Foldkit restarts an entry's stream whenever its dependencies change. The
// chat entry depends on which shown terminals show their chat, not on the
// focus, so moving the focus leaves every chat running. A live terminal is
// not a subscription: its pane holds it (see LiveTerminal).
export const subscriptions = Subscription.make<Model, Message, BridgeClient>()((entry) => ({
  // The fleet for the whole life of the page. When the watch ends or fails,
  // the page says so and watches again after a pause.
  fleet: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Effect.gen(function* () {
          const client = yield* BridgeClient
          return client.watch().pipe(
            Stream.map((fleet) => Message.ReceivedFleet({ fleet })),
            Stream.tapCause((cause) => Effect.logWarning("the bridge's fleet watch failed", cause)),
            Stream.catchCause(() => Stream.empty),
            Stream.concat(Stream.make(Message.LostBridge())),
          )
        }).pipe(Stream.unwrap, Stream.repeat(Schedule.spaced(RECONNECT_DELAY))),
    },
  ),

  // The usage of each coding plan, for the life of the page, as the fleet.
  usage: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Effect.gen(function* () {
          const client = yield* BridgeClient
          return client.usage().pipe(
            Stream.map((usage) => Message.ReceivedUsage({ usage })),
            Stream.tapCause((cause) => Effect.logWarning("the bridge's usage watch failed", cause)),
            Stream.catchCause(() => Stream.empty),
          )
        }).pipe(Stream.unwrap, Stream.repeat(Schedule.spaced(RECONNECT_DELAY))),
    },
  ),

  // The pointer anywhere on the page while the sidebar's edge is held, since
  // a drag soon leaves the thin edge behind.
  sidebarDrag: entry(
    { isHeld: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isHeld: Option.isSome(model.sidebarGrip) }),
      dependenciesToStream: ({ isHeld }) =>
        isHeld
          ? Stream.merge(
              Dom.streamFromEvent({ target: () => window, type: "pointermove", mapEvent: ({ clientX }) => Message.MovedSidebarEdge({ x: clientX }) }),
              Dom.streamFromEvent({ target: () => window, type: "pointerup", mapEvent: () => Message.ReleasedSidebarEdge() }),
            )
          : Stream.empty,
    },
  ),

  clock: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.fromEffectSchedule(Clock.currentTimeMillis, Schedule.spaced(CLOCK_TICK)).pipe(Stream.map((now) => Message.TickedClock({ now }))),
    },
  ),

  // Each shown chat, live. When a call fails the page shows why and calls
  // again after a pause; the bridge then sends the whole recent chat again.
  chat: entry(
    { addresses: Schema.Array(Schema.String) },
    {
      modelToDependencies: (model) => ({ addresses: openAs(model, "Chat") }),
      dependenciesToStream: ({ addresses }) => Stream.mergeAll(Array.map(addresses, chatStream), { concurrency: "unbounded" }),
    },
  ),
}))

const chatStream = (address: string) =>
  Effect.gen(function* () {
    const client = yield* BridgeClient
    return client.chat({ terminal: address }).pipe(
      Stream.map((update) => Message.ReceivedChat({ address, update })),
      Stream.catch((error) => Stream.make(Message.FailedChat({ address, reason: failureReason(error) }))),
    )
  }).pipe(Stream.unwrap, Stream.repeat(Schedule.spaced(RECONNECT_DELAY)))

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "herdr-web",
  body: h.div(
    [
      h.Class(Option.isSome(model.sidebarGrip) ? "app resizing" : "app"),
      h.Style({
        "--chat-font": fontStack("chat", model.settings.chat.font),
        "--chat-size": `${model.settings.chat.size}px`,
        "--sidebar-width": `${shownSidebarWidth(model)}px`,
      }),
    ],
    [
      h.nav(
        [
          h.Class(`fleet${model.isFleetFolded ? " folded" : ""}${model.spaceDrag._tag === "Pressed" ? " dragging" : ""}`),
          // A row's own release comes first; this one ends a press let go anywhere else.
          h.OnPointerUp(() => whilePressed(model, Message.DroppedSpaceDrag())),
          h.OnPointerLeave(() => whilePressed(model, Message.DroppedSpaceDrag())),
        ],
        [
          h.div([h.Class("fleet-top")], [h.h1([], ["herdr-web"])]),
          h.div([h.Class("fleet-list")], fleetView(model, h)),
          h.div([h.Class("fleet-foot")], [settingsButton(model, h)]),
        ],
      ),
      sidebarEdgeView(model, h),
      // On a phone the sidebar is a drawer over the page; a tap beside it closes it.
      ...(model.isFleetFolded ? [] : [h.div([h.Class("fleet-backdrop"), h.OnClick(Message.ClickedFleetToggle())], [])]),
      h.main(
        [h.Class("main")],
        [
          topBarView(model, h),
          workspaceView(model, h),
          ...usageBarView(
            model.usage,
            model.usageDetail,
            model.now,
            {
              toggled: (provider) => Message.ToggledUsageDetail({ provider }),
              refreshed: (provider) => Message.ClickedRefreshUsage({ provider }),
            },
            h,
          ),
        ],
      ),
    ],
  ),
})

/**
 * The row over the workspace: why the fleet may be out of date, then the shown
 * space's tabs. A phone puts the button that opens the sidebar drawer first,
 * and a desk hides the row when it has nothing else to show.
 */
const topBarView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const tabs = Option.toArray(
    Option.flatMap(selectedTab(model), ({ space, tab }) =>
      Option.map(lastFleet(model.bridge), (fleet) => tabsView(spaceRowOf(fleet)(space), tab.id, h)),
    ),
  )
  const problem = Option.toArray(Option.map(linkProblem(model.bridge), (text) => h.span([h.Class("link-problem")], [text])))
  return h.div(
    [h.Class(Array.isReadonlyArrayEmpty(tabs) && Array.isReadonlyArrayEmpty(problem) ? "top-bar bare" : "top-bar")],
    [
      h.button(
        [
          h.Type("button"),
          h.Class(model.isFleetFolded ? "chip icon-button fleet-toggle" : "chip icon-button fleet-toggle on"),
          h.AriaLabel("spaces"),
          h.AriaPressed(model.isFleetFolded ? "false" : "true"),
          h.OnClick(Message.ClickedFleetToggle()),
        ],
        [icon(PanelLeft, h)],
      ),
      ...problem,
      ...tabs,
    ],
  )
}

const settingsButton = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class(model.selection._tag === "Settings" ? "row settings-row on" : "row settings-row"),
      h.AriaCurrent(model.selection._tag === "Settings" ? "page" : "false"),
      h.OnClick(Message.ClickedSettings()),
    ],
    [icon(SettingsIcon, h), h.span([h.Class("name")], ["Settings"])],
  )

/** The sidebar's right edge on a desk: drag it or use the arrow keys to resize, double-click for the default width. */
const sidebarEdgeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(Option.isSome(model.sidebarGrip) ? "fleet-edge held" : "fleet-edge"),
      h.Role("separator"),
      h.Tabindex(0),
      h.AriaOrientation("vertical"),
      h.AriaLabel("resize the sidebar"),
      h.AriaValuemin(MIN_SIDEBAR_WIDTH),
      h.AriaValuemax(MAX_SIDEBAR_WIDTH),
      h.AriaValuenow(shownSidebarWidth(model)),
      h.Title("drag to resize, double-click for the default width"),
      h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, clientX) =>
        pointerType !== "touch" && button === 0 ? Option.some(Message.PressedSidebarEdge({ x: clientX })) : Option.none(),
      ),
      h.OnDoubleClick(Message.ResetSidebarWidth()),
      // The arrow keys would otherwise scroll the page as well.
      h.OnKeyDownPreventDefault((key) => Option.as(keyedSidebarWidth(shownSidebarWidth(model), key), Message.KeyedSidebarEdge({ key }))),
    ],
    [],
  )

/** Why the fleet may be out of date; nothing while it is live. */
const linkProblem = (bridge: Bridge) =>
  Bridge.match(bridge, {
    Waiting: () => Option.some("connecting…"),
    Watching: ({ fleet }) => (fleet.connected ? Option.none() : Option.some("herdr-core is not reachable")),
    Lost: () => Option.some("the bridge is not reachable"),
  })

const fleetView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(lastFleet(model.bridge), {
    onNone: () => [h.p([h.Class("note")], ["Waiting for the bridge."])],
    onSome: (fleet) => {
      const { machines, loose } = sidebarOf(fleet)
      const openTab = Option.map(selectedTab(model), ({ tab }) => tab.id)
      // With one machine, a heading would only repeat its name.
      const isHeaded = machines.length > 1
      const isNested = model.settings.agents === "nested"
      // Nested, a space lists its own agents, and this list keeps the ones no space holds.
      const [listTitle, listed] = isNested
        ? ["Other agents", loose]
        : ["Agents", [...Array.flatMap(machines, ({ spaces }) => Array.flatMap(spaces, agentsIn)), ...loose]]
      return !isHeaded && Array.every(machines, ({ spaces }) => Array.isReadonlyArrayEmpty(spaces)) && Array.isReadonlyArrayEmpty(listed)
        ? [h.p([h.Class("note")], ["No spaces."])]
        : [
            ...(model.spaceDrag._tag === "Refused" ? [h.p([h.Class("note error")], [`The space did not move: ${model.spaceDrag.reason}`])] : []),
            ...Array.map(machines, (row) => machineView(row, isHeaded, isNested, openTab, fleet, model, h)),
            ...(Array.isReadonlyArrayNonEmpty(listed)
              ? [
                  h.keyed("section")(
                    "agents",
                    [h.Class("agent-list"), h.AriaLabel(listTitle)],
                    [
                      h.h2([h.Class("list-head")], [h.span([h.Class("name")], [listTitle])]),
                      h.ul([], Array.map(listed, (terminal) => agentRowView(terminal, model, h))),
                    ],
                  ),
                ]
              : []),
          ]
    },
  })

const machineView = (
  { machine, spaces }: MachineRow,
  isHeaded: boolean,
  isNested: boolean,
  openTab: Option.Option<string>,
  fleet: Fleet,
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("div")(
    machine.name,
    [h.Class("machine")],
    [
      ...(isHeaded
        ? [
            h.h2(
              [h.Class(`machine-head ${machine.state}`)],
              [
                icon(machine.isLocal ? Monitor : Server, h),
                h.span([h.Class("name")], [machine.name]),
                ...(machine.state === "connected" ? [] : [h.span([h.Class("msg")], [String.replaceAll("_", " ")(machine.state)])]),
              ],
            ),
          ]
        : []),
      ...Array.flatMap(spaces, (row) => [
        spaceView(row, openTab, dragMark(model.spaceDrag, fleet, row.space.id), h),
        ...(isNested && Array.isReadonlyArrayNonEmpty(agentsIn(row))
          ? [h.keyed("ul")(`${row.space.id}/agents`, [h.Class("space-agents")], Array.map(agentsIn(row), (terminal) => agentRowView(terminal, model, h)))]
          : []),
      ]),
    ],
  )

/** How a space row shows the drag: the pressed row, the row it would land beside, or neither. */
type DragMark = "pressed" | `drop-${DropSide}` | "none"

const dragMark = (drag: SpaceDrag, fleet: Fleet, row: string): DragMark =>
  SpaceDrag.match<DragMark>(drag, {
    Idle: () => "none",
    Pressed: ({ space, over }) =>
      space === row
        ? "pressed"
        : Option.contains(over, row)
          ? Option.match(dropSide(fleet, space, row), { onNone: () => "none", onSome: (side): DragMark => `drop-${side}` })
          : "none",
    Moving: () => "none",
    Refused: () => "none",
  })

const whilePressed = (model: Model, message: Message) => (model.spaceDrag._tag === "Pressed" ? Option.some(message) : Option.none())

// A space opens on its first tab; the tab bar then moves between its tabs. A
// mouse drags it to another place among its machine's spaces; a touch
// scrolls the sidebar instead.
const spaceView = ({ space, label, status, tabs }: SpaceRow, openTab: Option.Option<string>, mark: DragMark, h: HtmlBuilder<Message>): Html => {
  const isOpen = Array.some(tabs, ({ tab }) => Option.contains(openTab, tab.id))
  return h.keyed("button")(
    space.id,
    [
      h.Type("button"),
      h.Class(`row space-row${isOpen ? " on" : ""}${mark === "none" ? "" : ` ${mark}`}`),
      h.AriaCurrent(isOpen ? "page" : "false"),
      h.Disabled(Array.isReadonlyArrayEmpty(tabs)),
      ...Option.toArray(Option.map(Array.head(tabs), ({ tab }) => h.OnClick(Message.ClickedTab({ tabId: tab.id })))),
      h.OnPointerDown((pointerType, button) =>
        pointerType === "mouse" && button === 0 ? Option.some(Message.PressedSpace({ space: space.id })) : Option.none(),
      ),
      h.OnMouseEnter(Message.EnteredSpace({ space: space.id })),
      h.OnPointerUp(() => Option.some(Message.ReleasedSpace({ space: space.id }))),
    ],
    [icon(Folder, h), h.span([h.Class("name")], [label]), ...statusMark(status, h)],
  )
}

const agentRowView = (terminal: Terminal, model: Model, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    terminal.address,
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.Class(Option.contains(maybeFocus(model), terminal.address) ? "row agent-row on" : "row agent-row"),
          h.OnClick(Message.ClickedTerminal({ address: terminal.address })),
        ],
        [
          icon(Bot, h),
          h.span([h.Class("name")], [terminalLabel(terminal)]),
          h.span([h.Class("msg")], [terminalNote(terminal)]),
          statusDot(stateOf(terminal), h),
        ],
      ),
    ],
  )

const statusDot = (maybeState: Option.Option<StatusState>, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(`dot ${Option.getOrElse(maybeState, () => "shell")}`),
      h.Title(Option.getOrElse(maybeState, () => "no status")),
    ],
    [],
  )

/** A space's or tab's mark: its most urgent agent's dot, or nothing without agents. */
const statusMark = (maybeState: Option.Option<StatusState>, h: HtmlBuilder<Message>) =>
  Option.toArray(Option.map(maybeState, (state) => statusDot(Option.some(state), h)))

const stateOf = ({ status }: Terminal) => Option.map(status, ({ state }) => state)


const workspaceView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Selection.match(model.selection, {
    Settings: () => settingsView(model, h),
    Nothing: () => h.section([h.Class("workspace empty")], ["Pick a tab or an agent."]),
    Tab: () =>
      Option.match(selectedTab(model), {
        // A remembered tab waits for the fleet before it can say it is gone.
        onNone: () =>
          h.section([h.Class("workspace empty")], [Option.isSome(lastFleet(model.bridge)) ? "This tab is closed." : "Waiting for the bridge."]),
        onSome: ({ tab }) =>
          h.section(
            [h.Class("workspace")],
            [
              focusChipsView(model, h),
              ...paneActionView(model, h),
              h.div([h.Class("layout")], [layoutView(tab.root, model, h)]),
              ...keysView(model, h),
            ],
          ),
      }),
    Loose: ({ address }) =>
      h.section(
        [h.Class("workspace")],
        [h.div([h.Class("layout")], [paneView(address, Option.none(), Option.none(), model, h)]), ...keysView(model, h)],
      ),
  })

/** The space's tabs, each with its most urgent agent's dot. */
const tabsView = ({ label, tabs }: SpaceRow, tabId: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("tabs")],
    [
      h.span([h.Class("space-name")], [label]),
      ...Array.map(tabs, ({ tab, label, status }) =>
        h.keyed("button")(
          tab.id,
          [h.Type("button"), h.Class(tab.id === tabId ? "tab on" : "tab"), h.OnClick(Message.ClickedTab({ tabId: tab.id }))],
          [label, ...statusMark(status, h)],
        ),
      ),
    ],
  )

/** On a phone the page shows only the focused pane; these chips move the focus. */
const focusChipsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const shown = shownTerminals(model)
  return h.div(
    [h.Class("focus-chips")],
    shown.length > 1
      ? Array.map(shown, (address) =>
          h.button(
            [
              h.Type("button"),
              h.Class(Option.contains(maybeFocus(model), address) ? "chip on" : "chip"),
              h.OnClick(Message.FocusedPane({ address })),
            ],
            [labelAt(model, address)],
          ),
        )
      : [],
  )
}

// A stack shows one child at a time in herdr-app; the page has no way to know
// which, so it lays a stack's children out as a column.
const layoutView = (node: Layout, model: Model, h: HtmlBuilder<Message>): Html =>
  Match.valueTags(node, {
    Block: ({ id, size, content }) =>
      Match.valueTags(content, {
        Terminal: ({ terminal }) => paneView(terminal, Option.some(id), size, model, h),
        Mod: ({ mod }) => h.keyed("div")(id, [h.Class("pane placeholder"), h.Style(flexOf(size))], [`${mod} (a herdr-app mod)`]),
        Unknown: () => h.keyed("div")(id, [h.Class("pane placeholder"), h.Style(flexOf(size))], ["a pane this page cannot show"]),
      }),
    Split: ({ id, type, size, children }) =>
      h.keyed("div")(
        id,
        [h.Class(type === "row" ? "split across" : "split down"), h.Style(flexOf(size))],
        Array.map(children, (child) => layoutView(child, model, h)),
      ),
    Unknown: ({ type }) => h.div([h.Class("pane placeholder")], [`a ${type} this page cannot show`]),
  })

/** A node's flex share: its weight, or an even share when herdr-app gives none. */
const flexOf = (size: Option.Option<Size>) => ({ flex: `${Option.getOrElse(Option.flatMap(size, ({ weight }) => weight), () => 1)} 1 0` })

/** A terminal's pane; `maybePane` is its herdr-app pane, which the split and close buttons act on. */
const paneView = (
  address: string,
  maybePane: Option.Option<string>,
  size: Option.Option<Size>,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeTerminal = findTerminal(model, address)
  const shown = viewOf(model, address)
  const isFocused = Option.contains(maybeFocus(model), address)
  return h.keyed("section")(
    address,
    [h.Class(Option.contains(maybeFocus(model), address) ? "pane focused" : "pane"), h.Style(flexOf(size))],
    [
      h.div(
        [h.Class("pane-head"), h.OnClick(Message.FocusedPane({ address }))],
        [
          ...Option.match(maybeTerminal, { onNone: () => [], onSome: (terminal) => [statusDot(stateOf(terminal), h)] }),
          h.span([h.Class("name")], [labelAt(model, address)]),
          ...Option.toArray(Option.map(maybeTerminal, (terminal) => h.span([h.Class("msg")], [terminalNote(terminal)]))),
          // Before the view chips, so they stay in place as these show and hide.
          ...Option.toArray(Option.map(maybePane, (pane) => paneButtons(pane, model, h))),
          // A permission dialog shows only in the terminal, so a chat can switch to it.
          ...(isClaudeCode(model, address)
            ? Array.map(ViewName.literals, (name) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Class(shown._tag === name ? "chip icon-chip view-chip on" : "chip icon-chip view-chip"),
                    h.AriaLabel(name === "Chat" ? "chat" : "terminal"),
                    h.AriaPressed(shown._tag === name ? "true" : "false"),
                    h.OnClick(Message.SelectedView({ address, view: name })),
                  ],
                  [icon(name === "Chat" ? MessageSquare : SquareTerminal, h), h.span([h.Class("label")], [name === "Chat" ? "chat" : "terminal"])],
                ),
              )
            : []),
        ],
      ),
      View.match(shown, {
        // The prompt sits under the focused pane's chat; a click on another chat moves it there.
        Chat: ({ conversation }) =>
          h.div(
            [h.Class("chat-view"), h.OnClick(Message.FocusedPane({ address }))],
            [
              Conversation.match(conversation, {
                Loading: () => h.p([h.Class("chat note")], ["reading the conversation…"]),
                Shown: ({ entries }) => chatView(entries, h),
                Unreadable: ({ reason }) => h.p([h.Class("chat note error")], [reason]),
              }),
              ...(isFocused ? [promptView(model, h)] : []),
            ],
          ),
        Terminal: ({ link }) =>
          h.div(
            [h.Class("live")],
            [
              ...Match.valueTags(link, {
                Connecting: () => [h.p([h.Class("note link-note")], ["connecting…"])],
                Live: () => [],
                Lost: ({ reason }) => [h.p([h.Class("note error link-note")], [`${reason}; trying again`])],
              }),
              // The emulator owns this element's children, so it has none here.
              // Keyed by its font, so a new font or size starts the terminal afresh.
              h.keyed("div")(
                `${address} ${fontStack("terminal", model.settings.terminal.font)} ${model.settings.terminal.size}`,
                [
                  h.Class("terminal"),
                  h.Attribute(
                    MODIFIERS_ATTRIBUTE,
                    Option.contains(maybeFocus(model), address) ? modifiersAttribute(model.modifiers) : "",
                  ),
                  h.OnMount(
                    Mount.mapMessage(
                      LiveTerminal({ address, font: model.settings.terminal.font, size: model.settings.terminal.size }),
                      (message) =>
                        Match.valueTags(message, {
                          ChangedLink: ({ link }) => Message.ChangedLink({ address, link }),
                          UsedModifiers: () => Message.UsedModifiers(),
                        }),
                    ),
                  ),
                  h.OnClick(Message.FocusedPane({ address })),
                ],
                [],
              ),
            ],
          ),
      }),
      // A refused prompt or key press, said in the pane it was for.
      ...(isFocused
        ? Delivery.match(model.delivery, {
            Ready: () => [],
            Sending: () => [],
            Refused: ({ reason }) => [h.p([h.Class("note error")], [reason])],
          })
        : []),
    ],
  )
}

/** The head shows these under the pointer or keyboard focus; a close waiting for its answer keeps them shown. */
const paneButtons = (pane: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const button = (label: string, title: string, message: Message) =>
    h.button([h.Type("button"), h.Class("chip"), h.Title(title), h.AriaLabel(title), h.OnClick(message)], [label])
  const iconButton = (node: IconNode, title: string, message: Message) =>
    h.button([h.Type("button"), h.Class("chip icon-button"), h.Title(title), h.AriaLabel(title), h.OnClick(message)], [icon(node, h)])
  const isClosing = PaneAction.match(model.paneAction, {
    Idle: () => false,
    Confirming: ({ pane: closing }) => closing === pane,
    Refused: () => false,
  })
  return h.span(
    [h.Class(isClosing ? "pane-actions confirming" : "pane-actions")],
    isClosing
      ? [button("end it", "close the pane and end its program", Message.ConfirmedClose({ pane })), button("keep", "keep the pane", Message.ClickedKeepPane())]
      : [
          iconButton(Columns2, "split right", Message.ClickedSplit({ pane, direction: "right" })),
          iconButton(Rows2, "split down", Message.ClickedSplit({ pane, direction: "down" })),
          iconButton(X, "close the pane", Message.ClickedClose({ pane })),
        ],
  )
}

/** Why herdr-app refused the last split or close. */
const paneActionView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  PaneAction.match(model.paneAction, {
    Idle: () => [],
    Confirming: () => [],
    Refused: ({ reason }) => [h.p([h.Class("note error")], [reason])],
  })

/** The soft keys for the focused pane, a terminal's or a chat's; none when no terminal is on show. */
const keysView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(maybeFocus(model), {
    onNone: () => [],
    onSome: () => [
        h.div(
          [h.Class("keys"), h.OnMount(Mount.mapMessage(KeepTypingFocus(), () => Message.CompletedKeepTypingFocus()))],
          Array.map(SOFT_KEYS, (softKey) =>
            Match.valueTags(softKey, {
              Press: ({ key, label }) =>
                h.button([h.Type("button"), h.Class("chip"), h.AriaLabel(key), h.OnClick(Message.ClickedKey({ key }))], [label]),
              Hold: ({ modifier }) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Class(model.modifiers[modifier] ? "chip on" : "chip"),
                    h.AriaPressed(model.modifiers[modifier] ? "true" : "false"),
                    h.OnClick(Message.ToggledModifier({ modifier })),
                  ],
                  [modifier],
                ),
            }),
          ),
        ),
      ],
  })

/** The focused chat's prompt: its text goes to the agent, and Enter after it. */
const promptView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isSending = Delivery.match(model.delivery, { Ready: () => false, Sending: () => true, Refused: () => false })
  return h.form(
    [h.Class("prompt"), h.OnSubmit(Message.SubmittedPrompt())],
    [
      h.textarea([
        h.Value(model.prompt),
        h.AriaLabel("Prompt"),
        h.OnInput((text) => Message.UpdatedPrompt({ text })),
      ]),
      h.button([h.Type("submit"), h.Disabled(isSending)], [isSending ? "sending…" : "send"]),
    ],
  )
}

const settingsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("workspace settings")],
    [
      h.h2([], ["Settings"]),
      h.p([h.Class("note")], ["This browser keeps its own settings, so a phone and a desk can differ."]),
      textStyleView("chat", model.settings.chat, model, h),
      textStyleView("terminal", model.settings.terminal, model, h),
      agentListView(model.settings.agents, h),
      ...FontCatalog.match(model.fontCatalog, {
        Loading: () => [h.p([h.Class("note")], ["Asking the bridge for its fonts…"])],
        Loaded: () => [],
        Failed: ({ reason }) => [h.p([h.Class("note error")], [`The bridge's fonts are not available: ${reason}`])],
      }),
    ],
  )

const AGENT_LIST_TEXT = { below: "Below the spaces", nested: "Under each space" } satisfies Record<AgentList, string>

const agentListView = (agents: AgentList, h: HtmlBuilder<Message>): Html =>
  h.fieldset(
    [h.Class("setting choices")],
    [
      h.legend([], ["Sidebar agents"]),
      ...Array.map(AgentList.literals, (choice) =>
        h.label(
          [],
          [
            h.input([
              h.Type("radio"),
              h.Name("agents"),
              h.Value(choice),
              h.Checked(choice === agents),
              // A browser fires click on a radio for a key press too.
              h.OnClick(Message.PickedAgentList({ agents: choice })),
            ]),
            AGENT_LIST_TEXT[choice],
          ],
        ),
      ),
    ],
  )

const SURFACE_TEXT = {
  chat: { title: "Chat", sample: "Fixed the login bug — 3 files changed, tests pass.", fallback: "the page's font" },
  terminal: { title: "Terminal", sample: "$ ls -la ~/build  {} [] => 0O 1lI", fallback: "the browser's monospace" },
} satisfies Record<Surface, Readonly<{ title: string; sample: string; fallback: string }>>

/** A surface's font and size; a terminal offers only monospaced fonts. */
const textStyleView = (surface: Surface, { font, size }: TextStyle, model: Model, h: HtmlBuilder<Message>): Html => {
  const { title, sample, fallback } = SURFACE_TEXT[surface]
  const offered = FontCatalog.match(model.fontCatalog, {
    Loading: () => [],
    Loaded: ({ families }) =>
      Array.filterMap(families, ({ name, isMono }) => (surface === "terminal" && !isMono ? Result.failVoid : Result.succeed(name))),
    Failed: () => [],
  })
  // The chosen font stays in the list while the catalog loads, or if the bridge stops serving it.
  const names = Array.dedupe([...Option.toArray(font), ...offered])
  return h.fieldset(
    [h.Class("setting")],
    [
      h.legend([], [title]),
      h.label([h.For(`${surface}-font`)], ["Font"]),
      h.select(
        [
          h.Id(`${surface}-font`),
          h.OnChange((value) => Message.PickedFont({ surface, font: Option.liftPredicate(value, String.isNonEmpty) })),
        ],
        [
          h.option([h.Value(""), h.Selected(Option.isNone(font))], [fallback]),
          ...Array.map(names, (name) => h.option([h.Value(name), h.Selected(Option.contains(font, name))], [name])),
        ],
      ),
      h.span([h.Class("size-label")], ["Size"]),
      h.div(
        [h.Class("size")],
        [
          h.button(
            [h.Type("button"), h.Class("chip"), h.AriaLabel(`smaller ${surface} text`), h.Disabled(size <= MIN_SIZE), h.OnClick(Message.SteppedSize({ surface, step: -1 }))],
            ["−"],
          ),
          h.span([], [`${size}px`]),
          h.button(
            [h.Type("button"), h.Class("chip"), h.AriaLabel(`larger ${surface} text`), h.Disabled(size >= MAX_SIZE), h.OnClick(Message.SteppedSize({ surface, step: 1 }))],
            ["+"],
          ),
        ],
      ),
      h.p(
        [h.Class("sample"), h.Style({ "font-family": fontStack(surface, font), "font-size": `${size}px` })],
        [sample],
      ),
    ],
  )
}
