import { Array, Effect, Match, Option, Record, Schedule, Schema, Stream, String } from "effect"
import { Command, Subscription, type Update } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { ChatUpdate, Entry } from "../shared/Chat.ts"
import { Fleet, type Layout, type Size, type Space, type Status, type Tab, type Terminal } from "../shared/Fleet.ts"
import { chatView } from "./chatView.ts"
import { groupFleet, locate, type SpaceGroup, spaceLabel, tabLabel, terminalLabel, terminalsIn } from "./group.ts"
import { BridgeClient, failureReason, reportFailure } from "./rpc.ts"

// CONSTANT

const SCREEN_HISTORY_LINES = 200
const SCREEN_REFRESH = "2 seconds"
const RECONNECT_DELAY = "2 seconds"
/** Keys an agent's prompts ask for: menu choices, yes and no, and the ways out. */
const QUICK_KEYS = ["1", "2", "3", "y", "n", "enter", "esc", "ctrl+c"]
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

export const Screen = defineTaggedUnion({
  Reading: {},
  Shown: { text: Schema.String },
  Unreadable: { reason: Schema.String },
})
export type Screen = typeof Screen.Type

export const Conversation = defineTaggedUnion({
  Loading: {},
  Shown: { entries: Schema.Array(Entry) },
  Unreadable: { reason: Schema.String },
})
export type Conversation = typeof Conversation.Type

/** What a pane shows of its terminal: a Claude Code agent's chat, or the screen as text. */
export const View = defineTaggedUnion({
  Chat: { conversation: Conversation },
  Screen: { screen: Screen },
})
export type View = typeof View.Type

const ViewName = Schema.Literals(["Chat", "Screen"])
type ViewName = typeof ViewName.Type

export const Delivery = defineTaggedUnion({
  Ready: {},
  Sending: {},
  Refused: { reason: Schema.String },
})
export type Delivery = typeof Delivery.Type

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
  TickedScreen: {},
  SucceededReadScreen: { address: Schema.String, text: Schema.String },
  FailedReadScreen: { address: Schema.String, reason: Schema.String },
  UpdatedPrompt: { text: Schema.String },
  SubmittedPrompt: {},
  SucceededSendPrompt: { address: Schema.String },
  FailedSendPrompt: { address: Schema.String, reason: Schema.String },
  ClickedKey: { key: Schema.String },
  SucceededPressKeys: { address: Schema.String },
  FailedPressKeys: { address: Schema.String, reason: Schema.String },
})
export type Message = typeof Message.Type

// INIT

export const init = () => ({
  model: {
    bridge: Bridge.Waiting(),
    filter: Filter.make("Agents"),
    isFleetFolded: false,
    selection: Selection.Nothing(),
    views: {},
    prompt: "",
    delivery: Delivery.Ready(),
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
        Tab: ({ tabId }) => ({ model: selected(model, Selection.Tab({ tabId, maybeFocus: Option.some(address) })) }),
        Loose: () => ({ model }),
      }),

    // A screen view is read by the screen subscription, which starts again
    // with a read whenever the set of screens changes.
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

    TickedScreen: () => ({ model, commands: Array.map(openAs(model, "Screen"), (address) => ReadScreen({ address })) }),

    SucceededReadScreen: ({ address, text }) => ({
      model: withView(model, address, (view) => withScreen(view, Screen.Shown({ text }))),
    }),

    FailedReadScreen: ({ address, reason }) => ({
      model: withView(model, address, (view) => withScreen(view, Screen.Unreadable({ reason }))),
    }),

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
        commands: screenRead(model, address),
      })),

    FailedSendPrompt: ({ address, reason }) =>
      whenFocused(model, address, () => ({ model: modifyFields(model, { delivery: () => Delivery.Refused({ reason }) }) })),

    ClickedKey: ({ key }) =>
      Option.match(maybeFocus(model), {
        onNone: () => ({ model }),
        onSome: (address) => ({ model, commands: [PressKeys({ address, keys: [key] })] }),
      }),

    SucceededPressKeys: ({ address }) =>
      whenFocused(model, address, () => ({
        model: modifyFields(model, { delivery: () => Delivery.Ready() }),
        commands: screenRead(model, address),
      })),

    FailedPressKeys: ({ address, reason }) =>
      whenFocused(model, address, () => ({ model: modifyFields(model, { delivery: () => Delivery.Refused({ reason }) }) })),
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
  const next = modifyFields(model, { selection: () => selection, delivery: () => Delivery.Ready() })
  const shown = shownTerminals(next)
  return modifyFields(next, { views: (views) => Record.filter(views, (_, address) => Array.contains(shown, address)) })
}

/** The terminal's view: the one picked for it, else its chat when it has one, else its screen. */
const viewOf = (model: Model, address: string) =>
  Option.getOrElse(Record.get(model.views, address), () => newView(isClaudeCode(model, address) ? "Chat" : "Screen"))

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
  name === "Chat" ? View.Chat({ conversation: Conversation.Loading() }) : View.Screen({ screen: Screen.Reading() })

// hc reports status, not screen changes, so a screen is read again after each
// change the page makes, and on a timer.
const screenRead = (model: Model, address: string) =>
  View.match(viewOf(model, address), { Chat: () => [], Screen: () => [ReadScreen({ address })] })

const withScreen = (view: View, screen: Screen) => View.match(view, { Chat: () => view, Screen: () => View.Screen({ screen }) })

const withConversation = (view: View, change: (conversation: Conversation) => Conversation) =>
  View.match(view, { Chat: ({ conversation }) => View.Chat({ conversation: change(conversation) }), Screen: () => view })

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

export const ReadScreen = Command.define("ReadScreen", {
  args: { address: Schema.String },
  messages: [Message.SucceededReadScreen, Message.FailedReadScreen],
  execute: ({ address }) =>
    Effect.gen(function* () {
      const client = yield* BridgeClient
      const { text } = yield* client.read({ terminal: address, lines: SCREEN_HISTORY_LINES })
      return Message.SucceededReadScreen({ address, text })
    }).pipe(reportFailure((reason) => Message.FailedReadScreen({ address, reason }))),
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
// chat and screen entries depend on which shown terminals have that view, not
// on the focus, so moving the focus leaves every chat running.
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

  // The first tick comes at once, so a screen shown anew is read straight away.
  screen: entry(
    { addresses: Schema.Array(Schema.String) },
    {
      modelToDependencies: (model) => ({ addresses: openAs(model, "Screen") }),
      dependenciesToStream: ({ addresses }) =>
        Array.isReadonlyArrayNonEmpty(addresses) ? Stream.tick(SCREEN_REFRESH).pipe(Stream.map(() => Message.TickedScreen())) : Stream.empty,
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
    [h.Class("app")],
    [
      headerView(model, h),
      h.div(
        [h.Class("panes")],
        [h.nav([h.Class(model.isFleetFolded ? "fleet folded" : "fleet")], fleetView(model, h)), workspaceView(model, h)],
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
            [tabsView(space, tab.id, h), focusChipsView(model, h), h.div([h.Class("layout")], [layoutView(tab.root, model, h)]), ...composerView(model, h)],
          ),
      }),
    Loose: ({ address }) =>
      h.section(
        [h.Class("workspace")],
        [h.div([h.Class("layout")], [paneView(address, Option.none(), model, h)]), ...composerView(model, h)],
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
        Terminal: ({ terminal }) => paneView(terminal, size, model, h),
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

const paneView = (
  address: string,
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
          // A permission dialog shows only on the screen, so a chat can switch to it.
          ...(isClaudeCode(model, address)
            ? Array.map(ViewName.literals, (name) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Class(shown._tag === name ? "chip on" : "chip"),
                    h.OnClick(Message.SelectedView({ address, view: name })),
                  ],
                  [name === "Chat" ? "chat" : "screen"],
                ),
              )
            : []),
        ],
      ),
      View.match(shown, {
        Chat: ({ conversation }) =>
          Conversation.match(conversation, {
            Loading: () => h.p([h.Class("chat note")], ["reading the conversation…"]),
            Shown: ({ entries }) => chatView(entries, h),
            Unreadable: ({ reason }) => h.p([h.Class("chat note error")], [reason]),
          }),
        Screen: ({ screen }) =>
          Screen.match(screen, {
            Reading: () => h.pre([h.Class("screen")], ["reading…"]),
            Shown: ({ text }) => h.pre([h.Class("screen")], [h.span([], [text])]),
            Unreadable: ({ reason }) => h.pre([h.Class("screen error")], [reason]),
          }),
      }),
    ],
  )
}

/** The keys and prompt for the focused pane; none when no terminal is on show. */
const composerView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(maybeFocus(model), {
    onNone: () => [],
    onSome: (address) => {
      const target = Option.match(findTerminal(model, address), { onNone: () => address, onSome: terminalLabel })
      const isSending = Delivery.match(model.delivery, { Ready: () => false, Sending: () => true, Refused: () => false })
      return [
        h.div(
          [h.Class("keys")],
          Array.map(QUICK_KEYS, (key) => h.button([h.Type("button"), h.Class("chip"), h.OnClick(Message.ClickedKey({ key }))], [key])),
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
