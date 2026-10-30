// What the selection puts on show: the tab, its terminals, the focused one,
// and each terminal's view.
import { Array, Match, Option, Record, String } from "effect"
import { modifyFields } from "foldkit/struct"
import type { Fleet, Space, Tab } from "../shared/Fleet.ts"
import { type Feature, supports } from "../shared/Harness.ts"
import { spacesOf, terminalLabel, terminalsIn } from "./group.ts"
import { Bridge, Conversation, Delivery, type Model, PaneAction, Selection, type UpdateReturn, View, type ViewName } from "./model.ts"

/** The tab to show in place of `tabId` once it closes: the next, else the one before; none unless `tabId` is on show. */
export const tabAfterClosing = (model: Model, tabId: string): Option.Option<Tab> =>
  Option.flatMap(selectedTab(model), ({ space, tab }) =>
    tab.id === tabId
      ? Option.flatMap(Array.findFirstIndex(space.tabs, (other) => other.id === tabId), (index) =>
          Option.orElse(Array.get(space.tabs, index + 1), () => Array.get(space.tabs, index - 1)),
        )
      : Option.none(),
  )

export const lastFleet = (bridge: Bridge) =>
  Bridge.match(bridge, {
    Waiting: () => Option.none<Fleet>(),
    Watching: ({ fleet }) => Option.some(fleet),
    Lost: ({ maybeFleet }) => maybeFleet,
  })

/** The selected tab and the space that holds it, while the fleet still has them. */
export const selectedTab = (model: Model): Option.Option<Readonly<{ space: Space; tab: Tab }>> =>
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
    NewSpace: () => Option.none(),
    Worktrees: () => Option.none(),
  })

/** The terminals on show, in the layout's reading order. */
export const shownTerminals = (model: Model): ReadonlyArray<string> =>
  Selection.match(model.selection, {
    Nothing: () => [],
    Tab: () => Option.match(selectedTab(model), { onNone: () => [], onSome: ({ tab }) => terminalsIn(tab.root) }),
    Loose: ({ address }) => [address],
    Settings: () => [],
    NewSpace: () => [],
    Worktrees: () => [],
  })

/** The terminal the prompt and keys go to: the chosen pane while it is on show, else the first one. */
export const maybeFocus = (model: Model) => {
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
    NewSpace: () => Option.none<string>(),
    Worktrees: () => Option.none<string>(),
  })
}

// A new selection forgets the views it no longer shows, and any reply to the
// last prompt.
export const selected = (model: Model, selection: Selection) => {
  const next = modifyFields(model, { selection: () => selection, delivery: () => Delivery.Ready(), paneAction: () => PaneAction.Idle() })
  const shown = shownTerminals(next)
  return modifyFields(next, { views: (views) => Record.filter(views, (_, address) => Array.contains(shown, address)) })
}

/**
 * The terminal's view: the one picked for it while on show, else the chat
 * when it was last picked for the agent that runs there now, else the
 * terminal itself. A run is the agent's process, so an agent started again,
 * or started from a shell, opens as a terminal.
 */
export const viewOf = (model: Model, address: string) =>
  Option.getOrElse(Record.get(model.views, address), () =>
    newView(Option.exists(runOf(model, address), (run) => Array.contains(model.chatRuns, run)) && supportsAt(model, address, "chat") ? "Chat" : "Terminal"),
  )

/** The run of the agent in a terminal: its address and its foreground process. */
export const runOf = (model: Model, address: string) =>
  Option.map(Option.flatMap(findTerminal(model, address), ({ foreground }) => foreground), ({ pid }) => `${address}:${pid}`)

/**
 * The chat runs after `name` was picked for the terminal at `address`. One
 * run per terminal is kept, the newest, and at most CHAT_RUNS_KEPT of them.
 */
export const chatRunsAfter = (model: Model, address: string, name: ViewName) =>
  Array.take(
    [
      ...(name === "Chat" ? Option.toArray(runOf(model, address)) : []),
      ...Array.filter(model.chatRuns, (run) => !String.startsWith(`${address}:`)(run)),
    ],
    CHAT_RUNS_KEPT,
  )

const CHAT_RUNS_KEPT = 100

/** The shown terminals whose view is `name`. */
export const openAs = (model: Model, name: ViewName) =>
  Array.filter(shownTerminals(model), (address) => viewOf(model, address)._tag === name)

// A reply names the terminal it is for. One for a terminal no longer on show
// is dropped, so a late reply cannot bring back a view the page forgot.
export const withView = (model: Model, address: string, change: (view: View) => View) =>
  Array.contains(shownTerminals(model), address)
    ? modifyFields(model, { views: (views) => Record.set(views, address, change(viewOf(model, address))) })
    : model

/** Applies a reply to the prompt or keys only while their terminal is still the focus. */
export const whenFocused = (model: Model, address: string, apply: () => UpdateReturn): UpdateReturn =>
  Option.contains(maybeFocus(model), address) ? apply() : { model }

export const newView = (name: ViewName) =>
  Match.value(name).pipe(
    Match.when("Chat", () => View.Chat({ conversation: Conversation.Loading() })),
    Match.when("Terminal", () => View.Terminal({ link: { _tag: "Connecting" } })),
    Match.exhaustive,
  )

/** Whether the agent in the terminal has `feature`, such as a chat to read. */
export const supportsAt = (model: Model, address: string, feature: Feature) => Option.exists(findTerminal(model, address), (terminal) => supports(terminal, feature))

// A pane can outlive its terminal until herdr-app's layout catches up.
export const labelAt = (model: Model, address: string) => Option.match(findTerminal(model, address), { onNone: () => "closed terminal", onSome: terminalLabel })

export const findTerminal = (model: Model, address: string) =>
  Option.flatMap(lastFleet(model.bridge), ({ terminals }) => Array.findFirst(terminals, (terminal) => terminal.address === address))
