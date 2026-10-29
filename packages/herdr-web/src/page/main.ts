import { Array, Effect, Match, Option, Schedule, Schema, Stream, String } from "effect"
import { Command, Subscription, type Update } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { ChatUpdate, Entry } from "../shared/Chat.ts"
import { Fleet, type Status, type Terminal } from "../shared/Fleet.ts"
import { chatView } from "./chatView.ts"
import { groupFleet, type SpaceGroup, terminalLabel } from "./group.ts"
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

/** What the open terminal shows: a Claude Code agent's chat, or the screen as text. */
export const Pane = defineTaggedUnion({
  Chat: { conversation: Conversation },
  Screen: { screen: Screen },
})
export type Pane = typeof Pane.Type

const PaneName = Schema.Literals(["Chat", "Screen"])
type PaneName = typeof PaneName.Type

export const Delivery = defineTaggedUnion({
  Ready: {},
  Sending: {},
  Refused: { reason: Schema.String },
})
export type Delivery = typeof Delivery.Type

export const Selection = defineTaggedUnion({
  NoTerminal: {},
  Terminal: { address: Schema.String, pane: Pane, prompt: Schema.String, delivery: Delivery },
})
export type Selection = typeof Selection.Type

export const Model = Schema.Struct({ bridge: Bridge, filter: Filter, selection: Selection })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ReceivedFleet: { fleet: Fleet },
  LostBridge: {},
  SelectedFilter: { filter: Filter },
  ClickedTerminal: { address: Schema.String },
  ClickedClose: {},
  SelectedPane: { pane: PaneName },
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
  model: { bridge: Bridge.Waiting(), filter: Filter.make("Agents"), selection: Selection.NoTerminal() },
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ReceivedFleet: ({ fleet }) => ({ model: modifyFields(model, { bridge: () => Bridge.Watching({ fleet }) }) }),

    LostBridge: () => ({
      model: modifyFields(model, { bridge: () => Bridge.Lost({ maybeFleet: lastFleet(model.bridge) }) }),
    }),

    SelectedFilter: ({ filter }) => ({ model: modifyFields(model, { filter: () => filter }) }),

    ClickedTerminal: ({ address }) =>
      opened(Selection.Terminal({ address, pane: newPane("Screen"), prompt: "", delivery: Delivery.Ready() }), model, {
        pane: isClaudeCode(model, address) ? "Chat" : "Screen",
      }),

    ClickedClose: () => ({ model: modifyFields(model, { selection: () => Selection.NoTerminal() }) }),

    SelectedPane: ({ pane }) =>
      Selection.match<UpdateReturn>(model.selection, {
        NoTerminal: () => ({ model }),
        Terminal: (selected) => opened(selected, model, { pane }),
      }),

    ReceivedChat: ({ address, update }) => ({
      model: withSelected(model, address, (selected) => ({
        ...selected,
        pane: withConversation(selected.pane, (conversation) =>
          Conversation.Shown({
            entries: Match.valueTags(update, {
              Reset: ({ entries }) => entries,
              Appended: ({ entries }) => Array.appendAll(shownEntries(conversation), entries),
            }),
          }),
        ),
      })),
    }),

    FailedChat: ({ address, reason }) => ({
      model: withSelected(model, address, (selected) => ({
        ...selected,
        pane: withConversation(selected.pane, () => Conversation.Unreadable({ reason })),
      })),
    }),

    TickedScreen: () =>
      Selection.match<UpdateReturn>(model.selection, {
        NoTerminal: () => ({ model }),
        Terminal: ({ address, pane }) => ({ model, commands: screenReads(address, pane) }),
      }),

    SucceededReadScreen: ({ address, text }) => ({
      model: withSelected(model, address, (selected) => ({ ...selected, pane: withScreen(selected.pane, Screen.Shown({ text })) })),
    }),

    FailedReadScreen: ({ address, reason }) => ({
      model: withSelected(model, address, (selected) => ({
        ...selected,
        pane: withScreen(selected.pane, Screen.Unreadable({ reason })),
      })),
    }),

    UpdatedPrompt: ({ text }) =>
      Selection.match<UpdateReturn>(model.selection, {
        NoTerminal: () => ({ model }),
        Terminal: (selected) => ({
          model: modifyFields(model, { selection: () => Selection.Terminal({ ...selected, prompt: text }) }),
        }),
      }),

    SubmittedPrompt: () =>
      Selection.match<UpdateReturn>(model.selection, {
        NoTerminal: () => ({ model }),
        Terminal: ({ address, prompt }) =>
          String.isEmpty(String.trim(prompt))
            ? { model }
            : {
                model: withSelected(model, address, (selected) => ({ ...selected, delivery: Delivery.Sending() })),
                commands: [SendPrompt({ address, text: prompt })],
              },
      }),

    SucceededSendPrompt: ({ address }) => ({
      model: withSelected(model, address, (selected) => ({ ...selected, prompt: "", delivery: Delivery.Ready() })),
      commands: selectedScreenReads(model, address),
    }),

    FailedSendPrompt: ({ address, reason }) => ({
      model: withSelected(model, address, (selected) => ({ ...selected, delivery: Delivery.Refused({ reason }) })),
    }),

    ClickedKey: ({ key }) =>
      Selection.match<UpdateReturn>(model.selection, {
        NoTerminal: () => ({ model }),
        Terminal: ({ address }) => ({ model, commands: [PressKeys({ address, keys: [key] })] }),
      }),

    SucceededPressKeys: ({ address }) => ({
      model: withSelected(model, address, (selected) => ({ ...selected, delivery: Delivery.Ready() })),
      commands: selectedScreenReads(model, address),
    }),

    FailedPressKeys: ({ address, reason }) => ({
      model: withSelected(model, address, (selected) => ({ ...selected, delivery: Delivery.Refused({ reason }) })),
    }),
  })

type UpdateReturn = Update.Return<Model, Message, BridgeClient>
type SelectedTerminal = typeof Selection.Terminal.Type

const lastFleet = (bridge: Bridge) =>
  Bridge.match(bridge, {
    Waiting: () => Option.none<Fleet>(),
    Watching: ({ fleet }) => Option.some(fleet),
    Lost: ({ maybeFleet }) => maybeFleet,
  })

const maybeSelectedAddress = (model: Model) =>
  Selection.match(model.selection, {
    NoTerminal: () => Option.none<string>(),
    Terminal: ({ address }) => Option.some(address),
  })

/** Shows `pane` for the selected terminal, from the start: a new chat, or a screen read now. */
const opened = (selected: SelectedTerminal, model: Model, { pane }: { pane: PaneName }): UpdateReturn => {
  const next = { ...selected, pane: newPane(pane) }
  return {
    model: modifyFields(model, { selection: () => Selection.Terminal(next) }),
    commands: screenReads(next.address, next.pane),
  }
}

const newPane = (name: PaneName) =>
  name === "Chat" ? Pane.Chat({ conversation: Conversation.Loading() }) : Pane.Screen({ screen: Screen.Reading() })

// hc reports status, not screen changes, so the screen is read again after
// each change the page makes, and on a timer.
const screenReads = (address: string, pane: Pane) =>
  Pane.match(pane, { Chat: () => [], Screen: () => [ReadScreen({ address })] })

const selectedScreenReads = (model: Model, address: string) =>
  Selection.match(model.selection, {
    NoTerminal: () => [],
    Terminal: (selected) => (selected.address === address ? screenReads(address, selected.pane) : []),
  })

const withScreen = (pane: Pane, screen: Screen) => Pane.match(pane, { Chat: () => pane, Screen: () => Pane.Screen({ screen }) })

const withConversation = (pane: Pane, change: (conversation: Conversation) => Conversation) =>
  Pane.match(pane, { Chat: ({ conversation }) => Pane.Chat({ conversation: change(conversation) }), Screen: () => pane })

const shownEntries = (conversation: Conversation) =>
  Conversation.match(conversation, { Loading: () => [], Shown: ({ entries }) => entries, Unreadable: () => [] })

/** Whether hc reports a Claude Code agent in the terminal; only those have a chat to read. */
const isClaudeCode = (model: Model, address: string) =>
  Option.exists(findTerminal(model, address), ({ status }) =>
    Option.exists(status, ({ app }) => Option.contains(app, CLAUDE_CODE)),
  )

const findTerminal = (model: Model, address: string) =>
  Option.flatMap(lastFleet(model.bridge), ({ terminals }) => Array.findFirst(terminals, (terminal) => terminal.address === address))

// A reply names the terminal it is for. One that arrives after the user picked
// another terminal is dropped, so it cannot show one terminal's screen under
// another's name.
const withSelected = (model: Model, address: string, change: (selected: SelectedTerminal) => SelectedTerminal) =>
  Selection.match(model.selection, {
    NoTerminal: () => model,
    Terminal: (selected) =>
      selected.address === address ? modifyFields(model, { selection: () => Selection.Terminal(change(selected)) }) : model,
  })

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

  screen: entry(
    { maybeAddress: Schema.Option(Schema.String) },
    {
      modelToDependencies: (model) => ({ maybeAddress: maybeOpenAddress(model, "Screen") }),
      dependenciesToStream: ({ maybeAddress }) =>
        Option.match(maybeAddress, {
          onNone: () => Stream.empty,
          onSome: () => Stream.tick(SCREEN_REFRESH).pipe(Stream.drop(1), Stream.map(() => Message.TickedScreen())),
        }),
    },
  ),

  // The open chat, live. When the call fails the page shows why and calls
  // again after a pause; the bridge then sends the whole recent chat again.
  chat: entry(
    { maybeAddress: Schema.Option(Schema.String) },
    {
      modelToDependencies: (model) => ({ maybeAddress: maybeOpenAddress(model, "Chat") }),
      dependenciesToStream: ({ maybeAddress }) =>
        Option.match(maybeAddress, {
          onNone: () => Stream.empty,
          onSome: (address) =>
            Effect.gen(function* () {
              const client = yield* BridgeClient
              return client.chat({ terminal: address }).pipe(
                Stream.map((update) => Message.ReceivedChat({ address, update })),
                Stream.catch((error) => Stream.make(Message.FailedChat({ address, reason: failureReason(error) }))),
              )
            }).pipe(Stream.unwrap, Stream.repeat(Schedule.spaced(RECONNECT_DELAY))),
        }),
    },
  ),
}))

/** The selected terminal's address while it shows `pane`. */
const maybeOpenAddress = (model: Model, pane: PaneName) =>
  Selection.match(model.selection, {
    NoTerminal: () => Option.none<string>(),
    Terminal: ({ address, pane: shown }) => (shown._tag === pane ? Option.some(address) : Option.none()),
  })

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "herdr",
  body: h.div(
    [h.Class("app")],
    [
      headerView(model, h),
      h.div(
        [h.Class("panes")],
        [
          h.nav([h.Class("fleet")], fleetView(model, h)),
          Selection.match(model.selection, {
            NoTerminal: () => h.section([h.Class("detail empty")], ["Pick a terminal."]),
            Terminal: (selected) => detailView(model, selected, h),
          }),
        ],
      ),
    ],
  ),
})

const headerView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class("header")],
    [
      h.h1([], ["herdr"]),
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
        onNonEmpty: (groups) => Array.map(groups, (group) => spaceView(group, maybeSelectedAddress(model), h)),
      }),
  })

const spaceView = ({ id, label, tabs }: SpaceGroup, maybeSelected: Option.Option<string>, h: HtmlBuilder<Message>): Html =>
  h.keyed("section")(
    id,
    [h.Class("space")],
    [
      h.h2([], [label]),
      ...Array.flatMap(tabs, (tab) => [
        ...(tabs.length > 1 && String.isNonEmpty(tab.label) ? [h.h3([], [tab.label])] : []),
        h.ul([], Array.map(tab.terminals, (terminal) => terminalRowView(terminal, maybeSelected, h))),
      ]),
    ],
  )

const terminalRowView = (terminal: Terminal, maybeSelected: Option.Option<string>, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    terminal.address,
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.Class(Option.contains(maybeSelected, terminal.address) ? "row on" : "row"),
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
    onSome: ({ state, msg, kind }) =>
      Option.getOrElse(Option.orElse(msg, () => kind), () => state),
  })

const detailView = (model: Model, selected: SelectedTerminal, h: HtmlBuilder<Message>): Html => {
  const maybeTerminal = findTerminal(model, selected.address)
  const title = Option.match(maybeTerminal, { onNone: () => selected.address, onSome: terminalLabel })
  const isSending = Delivery.match(selected.delivery, { Ready: () => false, Sending: () => true, Refused: () => false })

  return h.keyed("section")(
    selected.address,
    [h.Class("detail")],
    [
      h.div(
        [h.Class("detail-head")],
        [
          ...Option.match(maybeTerminal, { onNone: () => [], onSome: ({ status }) => [statusDot(status, h)] }),
          h.h2([], [title]),
          h.span([h.Class("msg")], [Option.match(maybeTerminal, { onNone: () => "gone", onSome: statusText })]),
          // A permission dialog shows only on the screen, so a chat can switch to it.
          ...(isClaudeCode(model, selected.address)
            ? Array.map(PaneName.literals, (pane) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Class(selected.pane._tag === pane ? "chip on" : "chip"),
                    h.OnClick(Message.SelectedPane({ pane })),
                  ],
                  [pane === "Chat" ? "chat" : "screen"],
                ),
              )
            : []),
          h.button([h.Type("button"), h.Class("chip"), h.OnClick(Message.ClickedClose())], ["close"]),
        ],
      ),
      Pane.match(selected.pane, {
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
      h.div(
        [h.Class("keys")],
        Array.map(QUICK_KEYS, (key) =>
          h.button([h.Type("button"), h.Class("chip"), h.OnClick(Message.ClickedKey({ key }))], [key]),
        ),
      ),
      h.form(
        [h.Class("prompt"), h.OnSubmit(Message.SubmittedPrompt())],
        [
          h.textarea([
            h.Value(selected.prompt),
            h.Placeholder(`Type to ${title}; Enter is pressed for you`),
            h.AriaLabel("Prompt"),
            h.OnInput((text) => Message.UpdatedPrompt({ text })),
          ]),
          h.button([h.Type("submit"), h.Disabled(isSending)], [isSending ? "sending…" : "send"]),
        ],
      ),
      ...Delivery.match(selected.delivery, {
        Ready: () => [],
        Sending: () => [],
        Refused: ({ reason }) => [h.p([h.Class("note error")], [reason])],
      }),
    ],
  )
}
