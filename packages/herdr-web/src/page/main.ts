import { Array, Clock, Effect, Match, Option, Record, Result, Schedule, Schema, Stream, String } from "effect"
import { Command, Subscription, type Update } from "foldkit"
import * as Mount from "foldkit/mount"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { Direction } from "../shared/Api.ts"
import { ChatUpdate, Entry } from "../shared/Chat.ts"
import { FontFamily } from "../shared/Fonts.ts"
import { ProviderId, Usage } from "../shared/Usage.ts"
import { Fleet, type Layout, type Size, type Space, type Status, type Tab, type Terminal } from "../shared/Fleet.ts"
import { chatView } from "./chatView.ts"
import { groupFleet, locate, type SpaceGroup, spaceLabel, tabLabel, terminalLabel, terminalsIn } from "./group.ts"
import { BridgeClient, failureReason, reportFailure } from "./rpc.ts"
import { fontStack, MAX_SIZE, MIN_SIZE, restyle, saveSettings, Settings, stepSize, Surface, type TextStyle } from "./settings.ts"
import { KeepTypingFocus, Modifier, Modifiers, modifiersAttribute, NO_MODIFIERS, SOFT_KEYS, withModifiers } from "./keys.ts"
import { Link, LiveTerminal, MODIFIERS_ATTRIBUTE } from "./terminal.ts"
import { usageBarView } from "./usage.ts"

// CONSTANT

const RECONNECT_DELAY = "2 seconds"
/** Reset countdowns count in minutes. */
const CLOCK_TICK = "30 seconds"
/** The app name hc's status gives a Claude Code agent. */
const CLAUDE_CODE = "claude-code"

// MODEL

const Filter = Schema.Literals(["Agents", "All"])

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

// The page keeps its own selection: following herdr-app's window would move
// the page whenever the user works at the desk.
export const Selection = defineTaggedUnion({
  Nothing: {},
  /** A herdr-app tab, and the pane the prompt and keys go to; none means its first terminal. */
  Tab: { tabId: Schema.String, maybeFocus: Schema.Option(Schema.String) },
  /** A terminal that no herdr-app layout shows, alone. */
  Loose: { address: Schema.String },
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
  filter: Filter,
  /** On a phone the agent list folds away once an agent is picked, to give the panes the screen. */
  isFleetFolded: Schema.Boolean,
  selection: Selection,
  /** The view of each shown terminal; a terminal not in it shows its default view. */
  views: Schema.Record(Schema.String, View),
  prompt: Schema.String,
  delivery: Delivery,
  paneAction: PaneAction,
  settings: Settings,
  /** Soft ctrl and alt, armed until the next key. */
  modifiers: Modifiers,
  /** Settings take the workspace's place while open. */
  isSettingsOpen: Schema.Boolean,
  fontCatalog: FontCatalog,
  /** Each coding plan's usage, from the bridge; none before its first reading. */
  usage: Schema.Option(Usage),
  /** The plan whose usage panel is open. */
  usageDetail: Schema.Option(ProviderId),
  /** The time, for countdowns to a reset. */
  now: Schema.Finite,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ReceivedFleet: { fleet: Fleet },
  LostBridge: {},
  SelectedFilter: { filter: Filter },
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
  ClickedSettings: {},
  PickedFont: { surface: Surface, font: Schema.Option(Schema.String) },
  SteppedSize: { surface: Surface, step: Schema.Int },
  CompletedSaveSettings: {},
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
})
export type Message = typeof Message.Type

// INIT

export const init = (settings: Settings) => ({
  model: {
    bridge: Bridge.Waiting(),
    filter: Filter.make("Agents"),
    isFleetFolded: false,
    selection: Selection.Nothing(),
    views: {},
    prompt: "",
    delivery: Delivery.Ready(),
    paneAction: PaneAction.Idle(),
    settings,
    modifiers: NO_MODIFIERS,
    isSettingsOpen: false,
    fontCatalog: FontCatalog.Loading(),
    usage: Option.none(),
    usageDetail: Option.none(),
    now: 0,
  },
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ReceivedFleet: ({ fleet }) => ({ model: modifyFields(model, { bridge: () => Bridge.Watching({ fleet }) }) }),

    LostBridge: () => ({
      model: modifyFields(model, { bridge: () => Bridge.Lost({ maybeFleet: lastFleet(model.bridge) }) }),
    }),

    SelectedFilter: ({ filter }) => ({ model: modifyFields(model, { filter: () => filter }) }),

    ClickedFleetToggle: () => ({ model: modifyFields(model, { isFleetFolded: (isFolded) => !isFolded }) }),

    ClickedTerminal: ({ address }) => ({
      model: selected(
        modifyFields(model, { isFleetFolded: () => true }),
        Option.match(Option.flatMap(lastFleet(model.bridge), (fleet) => locate(fleet, address)), {
          onNone: () => Selection.Loose({ address }),
          onSome: ({ tab }) => Selection.Tab({ tabId: tab.id, maybeFocus: Option.some(address) }),
        }),
      ),
    }),

    ClickedTab: ({ tabId }) => ({ model: selected(model, Selection.Tab({ tabId, maybeFocus: Option.none() })) }),

    FocusedPane: ({ address }) =>
      Selection.match<UpdateReturn>(model.selection, {
        Nothing: () => ({ model }),
        // The tab and its views stay; only the prompt's last reply was for the old focus.
        Tab: ({ tabId }) => ({
          model: modifyFields(model, {
            selection: () => Selection.Tab({ tabId, maybeFocus: Option.some(address) }),
            delivery: () => Delivery.Ready(),
          }),
        }),
        Loose: () => ({ model }),
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
        Tab: ({ tabId }) => ({ model: modifyFields(model, { selection: () => Selection.Tab({ tabId, maybeFocus: Option.some(terminal) }) }) }),
        Loose: () => ({ model }),
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

    ClickedSettings: () =>
      model.isSettingsOpen
        ? { model: modifyFields(model, { isSettingsOpen: () => false }) }
        : { model: modifyFields(model, { isSettingsOpen: () => true, fontCatalog: () => FontCatalog.Loading() }), commands: [FetchFonts()] },

    PickedFont: ({ surface, font }) => settingsChanged(model, restyle(model.settings, surface, (style) => ({ ...style, font }))),

    SteppedSize: ({ surface, step }) => settingsChanged(model, restyle(model.settings, surface, (style) => stepSize(style, step))),

    CompletedSaveSettings: () => ({ model }),

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
      Option.flatMap(lastFleet(model.bridge), ({ spaces }) =>
        Array.findFirst(spaces, (space) =>
          Option.map(
            Array.findFirst(space.tabs, (tab) => tab.id === tabId),
            (tab) => ({ space, tab }),
          ),
        ),
      ),
    Loose: () => Option.none(),
  })

/** The terminals on show, in the layout's reading order. */
const shownTerminals = (model: Model): ReadonlyArray<string> =>
  Selection.match(model.selection, {
    Nothing: () => [],
    Tab: () => Option.match(selectedTab(model), { onNone: () => [], onSome: ({ tab }) => terminalsIn(tab.root) }),
    Loose: ({ address }) => [address],
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
  })
}

// A new selection forgets the views it no longer shows, and any reply to the
// last prompt.
const selected = (model: Model, selection: Selection) => {
  const next = modifyFields(model, { selection: () => selection, delivery: () => Delivery.Ready(), paneAction: () => PaneAction.Idle() })
  const shown = shownTerminals(next)
  return modifyFields(next, { views: (views) => Record.filter(views, (_, address) => Array.contains(shown, address)) })
}

/** The terminal's view: the one picked for it, else its chat when it has one, else the terminal. */
const viewOf = (model: Model, address: string) =>
  Option.getOrElse(Record.get(model.views, address), () => newView(isClaudeCode(model, address) ? "Chat" : "Terminal"))

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
  execute: ({ settings }) =>
    saveSettings(settings).pipe(
      Effect.catchTags({
        KeyValueStoreError: (error) => Effect.logWarning("the settings were not saved", error),
        SchemaError: (error) => Effect.logWarning("the settings were not saved", error),
      }),
      Effect.as(Message.CompletedSaveSettings()),
    ),
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
  title: "herdr",
  body: h.div(
    [
      h.Class("app"),
      h.Style({ "--chat-font": fontStack("chat", model.settings.chat.font), "--chat-size": `${model.settings.chat.size}px` }),
    ],
    [
      headerView(model, h),
      h.div(
        [h.Class("panes")],
        [
          h.nav([h.Class(model.isFleetFolded ? "fleet folded" : "fleet")], fleetView(model, h)),
          model.isSettingsOpen ? settingsView(model, h) : workspaceView(model, h),
        ],
      ),
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
})

const headerView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class("header")],
    [
      h.h1([], ["herdr"]),
      h.button(
        [h.Type("button"), h.Class(model.isFleetFolded ? "chip fleet-toggle" : "chip fleet-toggle on"), h.OnClick(Message.ClickedFleetToggle())],
        [model.isFleetFolded ? "agents ▾" : "agents ▴"],
      ),
      h.span([h.Class(`link ${linkState(model.bridge)}`)], [linkText(model.bridge)]),
      h.button(
        [h.Type("button"), h.Class(model.isSettingsOpen ? "chip on" : "chip"), h.OnClick(Message.ClickedSettings())],
        ["settings"],
      ),
      h.div(
        [h.Class("filter")],
        Array.map(Filter.literals, (filter) =>
          h.button(
            [
              h.Type("button"),
              h.Class(filter === model.filter ? "chip on" : "chip"),
              h.OnClick(Message.SelectedFilter({ filter })),
            ],
            [filter],
          ),
        ),
      ),
    ],
  )

const linkState = (bridge: Bridge) =>
  Bridge.match(bridge, {
    Waiting: () => "waiting",
    Watching: ({ fleet }) => (fleet.connected ? "live" : "stale"),
    Lost: () => "stale",
  })

const linkText = (bridge: Bridge) =>
  Bridge.match(bridge, {
    Waiting: () => "connecting",
    Watching: ({ fleet }) => (fleet.connected ? "live" : "herdr-core is not reachable"),
    Lost: () => "the bridge is not reachable",
  })

const fleetView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(lastFleet(model.bridge), {
    onNone: () => [h.p([h.Class("note")], ["Waiting for the bridge."])],
    onSome: (fleet) =>
      Array.match(groupFleet(fleet, model.filter), {
        onEmpty: () => [h.p([h.Class("note")], ["No terminals."])],
        onNonEmpty: (groups) => Array.map(groups, (group) => spaceView(group, model, h)),
      }),
  })

const spaceView = ({ id, label, terminals }: SpaceGroup, model: Model, h: HtmlBuilder<Message>): Html =>
  h.keyed("section")(
    id,
    [h.Class("space")],
    [h.h2([], [label]), h.ul([], Array.map(terminals, (terminal) => terminalRowView(terminal, model, h)))],
  )

const terminalRowView = (terminal: Terminal, model: Model, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    terminal.address,
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.Class(
            Option.contains(maybeFocus(model), terminal.address)
              ? "row on"
              : Array.contains(shownTerminals(model), terminal.address)
                ? "row shown"
                : "row",
          ),
          h.OnClick(Message.ClickedTerminal({ address: terminal.address })),
        ],
        [
          statusDot(terminal.status, h),
          h.span([h.Class("name")], [terminalLabel(terminal)]),
          h.span([h.Class("msg")], [statusText(terminal)]),
        ],
      ),
    ],
  )

const statusDot = (maybeStatus: Option.Option<Status>, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(`dot ${Option.match(maybeStatus, { onNone: () => "shell", onSome: ({ state }) => state })}`),
      h.Title(Option.match(maybeStatus, { onNone: () => "no status", onSome: ({ state }) => state })),
    ],
    [],
  )

const statusText = (terminal: Terminal) =>
  Option.match(terminal.status, {
    onNone: () => terminal.cwd,
    onSome: ({ state, msg, kind }) => Option.getOrElse(Option.orElse(msg, () => kind), () => state),
  })

const workspaceView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Selection.match(model.selection, {
    Nothing: () => h.section([h.Class("workspace empty")], ["Pick an agent."]),
    Tab: () =>
      Option.match(selectedTab(model), {
        onNone: () => h.section([h.Class("workspace empty")], ["This tab is closed."]),
        onSome: ({ space, tab }) =>
          h.section(
            [h.Class("workspace")],
            [
              tabsView(space, tab.id, h),
              focusChipsView(model, h),
              ...paneActionView(model, h),
              h.div([h.Class("layout")], [layoutView(tab.root, model, h)]),
              ...composerView(model, h),
            ],
          ),
      }),
    Loose: ({ address }) =>
      h.section(
        [h.Class("workspace")],
        [h.div([h.Class("layout")], [paneView(address, Option.none(), Option.none(), model, h)]), ...composerView(model, h)],
      ),
  })

const tabsView = (space: Space, tabId: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("tabs")],
    [
      h.span([h.Class("space-name")], [spaceLabel(space)]),
      ...Array.map(space.tabs, (tab, index) =>
        h.keyed("button")(
          tab.id,
          [h.Type("button"), h.Class(tab.id === tabId ? "tab on" : "tab"), h.OnClick(Message.ClickedTab({ tabId: tab.id }))],
          [tabLabel(tab, index)],
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
            [Option.match(findTerminal(model, address), { onNone: () => address, onSome: terminalLabel })],
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
  return h.keyed("section")(
    address,
    [h.Class(Option.contains(maybeFocus(model), address) ? "pane focused" : "pane"), h.Style(flexOf(size))],
    [
      h.div(
        [h.Class("pane-head"), h.OnClick(Message.FocusedPane({ address }))],
        [
          ...Option.match(maybeTerminal, { onNone: () => [], onSome: ({ status }) => [statusDot(status, h)] }),
          h.span([h.Class("name")], [Option.match(maybeTerminal, { onNone: () => address, onSome: terminalLabel })]),
          h.span([h.Class("msg")], [Option.match(maybeTerminal, { onNone: () => "gone", onSome: statusText })]),
          // A permission dialog shows only in the terminal, so a chat can switch to it.
          ...(isClaudeCode(model, address)
            ? Array.map(ViewName.literals, (name) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Class(shown._tag === name ? "chip on" : "chip"),
                    h.OnClick(Message.SelectedView({ address, view: name })),
                  ],
                  [name === "Chat" ? "chat" : "terminal"],
                ),
              )
            : []),
          ...Option.match(maybePane, { onNone: () => [], onSome: (pane) => paneButtons(pane, model, h) }),
        ],
      ),
      View.match(shown, {
        Chat: ({ conversation }) =>
          Conversation.match(conversation, {
            Loading: () => h.p([h.Class("chat note")], ["reading the conversation…"]),
            Shown: ({ entries }) => chatView(entries, h),
            Unreadable: ({ reason }) => h.p([h.Class("chat note error")], [reason]),
          }),
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
    ],
  )
}

const paneButtons = (pane: string, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const button = (label: string, title: string, message: Message) =>
    h.button([h.Type("button"), h.Class("chip"), h.Title(title), h.AriaLabel(title), h.OnClick(message)], [label])
  const isClosing = PaneAction.match(model.paneAction, {
    Idle: () => false,
    Confirming: ({ pane: closing }) => closing === pane,
    Refused: () => false,
  })
  return isClosing
    ? [button("end it", "close the pane and end its program", Message.ConfirmedClose({ pane })), button("keep", "keep the pane", Message.ClickedKeepPane())]
    : [
        button("⇥", "split right", Message.ClickedSplit({ pane, direction: "right" })),
        button("⤓", "split down", Message.ClickedSplit({ pane, direction: "down" })),
        button("✕", "close the pane", Message.ClickedClose({ pane })),
      ]
}

/** Why herdr-app refused the last split or close. */
const paneActionView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  PaneAction.match(model.paneAction, {
    Idle: () => [],
    Confirming: () => [],
    Refused: ({ reason }) => [h.p([h.Class("note error")], [reason])],
  })

/** The keys and prompt for the focused pane; none when no terminal is on show. */
const composerView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(maybeFocus(model), {
    onNone: () => [],
    onSome: (address) => {
      const target = Option.match(findTerminal(model, address), { onNone: () => address, onSome: terminalLabel })
      const isSending = Delivery.match(model.delivery, { Ready: () => false, Sending: () => true, Refused: () => false })
      return [
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
        h.form(
          [h.Class("prompt"), h.OnSubmit(Message.SubmittedPrompt())],
          [
            h.textarea([
              h.Value(model.prompt),
              h.Placeholder(`Type to ${target}; Enter is pressed for you`),
              h.AriaLabel("Prompt"),
              h.OnInput((text) => Message.UpdatedPrompt({ text })),
            ]),
            h.button([h.Type("submit"), h.Disabled(isSending)], [isSending ? "sending…" : "send"]),
          ],
        ),
        ...Delivery.match(model.delivery, {
          Ready: () => [],
          Sending: () => [],
          Refused: ({ reason }) => [h.p([h.Class("note error")], [reason])],
        }),
      ]
    },
  })

const settingsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("workspace settings")],
    [
      h.h2([], ["Settings"]),
      h.p([h.Class("note")], ["This browser keeps its own settings, so a phone and a desk can differ."]),
      textStyleView("chat", model.settings.chat, model, h),
      textStyleView("terminal", model.settings.terminal, model, h),
      ...FontCatalog.match(model.fontCatalog, {
        Loading: () => [h.p([h.Class("note")], ["Asking the bridge for its fonts…"])],
        Loaded: () => [],
        Failed: ({ reason }) => [h.p([h.Class("note error")], [`The bridge's fonts are not available: ${reason}`])],
      }),
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
