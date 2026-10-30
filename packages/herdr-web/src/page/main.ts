// The page: its start, how each message changes the model, what it watches,
// and the layout of sidebar, edge and workspace.
import { Array, Clock, Effect, Match, Option, Schedule, Schema, Stream, String } from "effect"
import { Subscription } from "foldkit"
import * as Dom from "foldkit/dom"
import type { Document, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import { dropSide, locate } from "./group.ts"
import { BridgeClient, failureReason } from "./rpc.ts"
import { fontStack, restyle, type Settings, stepSize } from "./settings.ts"
import { clampSidebarWidth, keyedSidebarWidth } from "./sidebarWidth.ts"
import { NO_MODIFIERS, withModifiers } from "./keys.ts"
import { usageBarView } from "./usage.ts"
import { FetchFonts, MoveSpace, PressKeys, RefreshUsage, SaveSelection, SaveSettings, SaveSidebarWidth, SendPrompt, SplitPane, ClosePane, NewTab, CloseTab } from "./commands.ts"
import { Bridge, Conversation, Delivery, FontCatalog, Message, type Flags, type Model, PaneAction, Selection, SpaceDrag, type UpdateReturn, View } from "./model.ts"
import { lastFleet, maybeFocus, newView, openAs, selected, tabAfterClosing, whenFocused, withView } from "./selection.ts"
import { shownSidebarWidth, sidebarEdgeView, sidebarView } from "./sidebar.ts"
import { clocked, refusedPrompt, sentPrompt, settled } from "./waiting.ts"
import { topBarView, workspaceView } from "./workspace.ts"

// CONSTANT

const RECONNECT_DELAY = "2 seconds"
/** Reset countdowns count in minutes. */
const CLOCK_TICK = "30 seconds"
/** While a prompt waits, so its clock shows on time. */
const WAITING_CLOCK_TICK = "1 second"

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
    waiting: [],
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
      model: settled(
        withView(model, address, (view) =>
          withConversation(view, (conversation) =>
            Conversation.Shown({
              entries: Match.valueTags(update, {
                Reset: ({ entries }) => entries,
                Appended: ({ entries }) => Array.appendAll(shownEntries(conversation), entries),
              }),
            }),
          ),
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

    ClickedNewTab: ({ space }) => ({
      model: modifyFields(model, { paneAction: () => PaneAction.Idle() }),
      commands: [NewTab({ space })],
    }),

    // The new tab shows once the fleet lists it.
    SucceededNewTab: ({ tab }) => remembered(selected(model, Selection.Tab({ tabId: tab, maybeFocus: Option.none() }))),

    // Closing a tab ends its programs, so it takes a second click like a pane.
    ClickedCloseTab: ({ tab }) => ({ model: modifyFields(model, { paneAction: () => PaneAction.ConfirmingTab({ tab }) }) }),

    // Closing the tab on show moves to its neighbour at once, not to a page that says it is gone.
    ConfirmedCloseTab: ({ tab }) => {
      const idle = modifyFields(model, { paneAction: () => PaneAction.Idle() })
      return Option.match(tabAfterClosing(model, tab), {
        onNone: () => ({ model: idle, commands: [CloseTab({ tab })] }),
        onSome: (next) => {
          const moved = selected(idle, Selection.Tab({ tabId: next.id, maybeFocus: Option.none() }))
          return { model: moved, commands: [CloseTab({ tab }), SaveSelection({ selection: moved.selection })] }
        },
      })
    },

    SucceededCloseTab: () => ({ model }),

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
                model: sentPrompt(modifyFields(model, { delivery: () => Delivery.Sending() }), address, model.prompt),
                commands: [SendPrompt({ address, text: model.prompt })],
              },
      }),

    SucceededSendPrompt: ({ address }) =>
      whenFocused(model, address, () => ({
        model: modifyFields(model, { prompt: () => "", delivery: () => Delivery.Ready() }),
      })),

    // The refused prompt stays in the box, so its text names the bubble to take back.
    FailedSendPrompt: ({ address, reason }) => {
      const without = refusedPrompt(model, address, model.prompt)
      return whenFocused(without, address, () => ({ model: modifyFields(without, { delivery: () => Delivery.Refused({ reason }) }) }))
    },

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

    TickedClock: ({ now }) => ({ model: clocked(modifyFields(model, { now: () => now })) }),

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

const withConversation = (view: View, change: (conversation: Conversation) => Conversation) =>
  View.match(view, { Chat: ({ conversation }) => View.Chat({ conversation: change(conversation) }), Terminal: () => view })

const shownEntries = (conversation: Conversation) =>
  Conversation.match(conversation, { Loading: () => [], Shown: ({ entries }) => entries, Unreadable: () => [] })

// The settings in use are already in the model, so a save that fails costs
// only the next visit's settings; it is logged, not shown.
const settingsChanged = (model: Model, settings: Settings) => ({
  model: modifyFields(model, { settings: () => settings }),
  commands: [SaveSettings({ settings })],
})

/** Shows the settings in place of the tab, and asks the bridge for its fonts again. */
const openSettings = (model: Model): UpdateReturn => {
  const next = selected(modifyFields(model, { isFleetFolded: () => true, fontCatalog: () => FontCatalog.Loading() }), Selection.Settings())
  return { model: next, commands: [SaveSelection({ selection: next.selection }), FetchFonts()] }
}

/** Keeps the tab and pane on show, so a reload opens on them. */
const remembered = (model: Model) => ({ model, commands: [SaveSelection({ selection: model.selection })] })

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

  // Faster while a prompt waits. A new rate starts a new stream, which reads
  // the clock at once, so a prompt just sent learns its time straight away.
  clock: entry(
    { isWaiting: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isWaiting: Array.isReadonlyArrayNonEmpty(model.waiting) }),
      dependenciesToStream: ({ isWaiting }) =>
        Stream.fromEffectSchedule(Clock.currentTimeMillis, Schedule.spaced(isWaiting ? WAITING_CLOCK_TICK : CLOCK_TICK)).pipe(
          Stream.map((now) => Message.TickedClock({ now })),
        ),
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
      sidebarView(model, h),
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
