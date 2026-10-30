// How the page files terminals: by the herdr-app layout trees that place
// them, in herdr-app's own order of spaces, tabs and panes.
import { Array, HashMap, HashSet, Match, Option, Order, pipe, String } from "effect"
import type { Fleet, Layout, Machine, Space, StatusState, Tab, Terminal } from "../shared/Fleet.ts"
import { harnessOf } from "./harness.ts"

export type TabRow = Readonly<{ tab: Tab; label: string; status: Option.Option<StatusState>; agents: ReadonlyArray<Terminal> }>

export type SpaceRow = Readonly<{ space: Space; label: string; status: Option.Option<StatusState>; tabs: ReadonlyArray<TabRow> }>

export type MachineRow = Readonly<{ machine: Machine; spaces: ReadonlyArray<SpaceRow> }>

/** Every machine with its spaces and their tabs, then the agents that no layout places. */
export type Sidebar = Readonly<{ machines: ReadonlyArray<MachineRow>; loose: ReadonlyArray<Terminal> }>

/**
 * Every machine and space in hc's and herdr-app's order, each space marked
 * with its most urgent agent. A loose agent is one no space shows, such as a
 * sub-agent; a loose shell belongs to another app.
 */
export const sidebarOf = (fleet: Fleet): Sidebar => {
  const spaceRow = spaceRowOf(fleet)
  const placed = HashSet.fromIterable(Array.flatMap(spacesOf(fleet), spaceTerminals))
  return {
    machines: Array.map(fleet.machines, (machine) => ({ machine, spaces: Array.map(machine.spaces, spaceRow) })),
    loose: Array.filter(fleet.terminals, (terminal) => isLiveAgent(terminal) && !HashSet.has(placed, terminal.address)),
  }
}

/** The space's agents, tab by tab in pane order. */
export const agentsIn = ({ tabs }: SpaceRow) => Array.flatMap(tabs, ({ agents }) => agents)

/**
 * A space and each of its tabs marked with its most urgent agent, with each
 * tab's agents in pane order. hc keeps a terminal after its program exits, so
 * only live ones count.
 */
export const spaceRowOf = (fleet: Fleet) => {
  const byAddress = HashMap.fromIterable(Array.map(fleet.terminals, (terminal) => [terminal.address, terminal] as const))
  return (space: Space): SpaceRow => {
    const tabs = Array.map(space.tabs, (tab, index): TabRow => {
      const agents = pipe(
        terminalsIn(tab.root),
        Array.map((address) => HashMap.get(byAddress, address)),
        Array.getSomes,
        Array.filter(isLiveAgent),
      )
      return { tab, label: tabLabel(tab, index), status: mostUrgent(agents), agents }
    })
    return { space, label: spaceLabel(space), status: mostUrgent(Array.flatMap(tabs, ({ agents }) => agents)), tabs }
  }
}

const isLiveAgent = (terminal: Terminal) => terminal.state === "live" && isAgent(terminal)

export type DropSide = "before" | "after"

/**
 * Where a space dragged onto another lands, as herdr-app's `space.move` puts
 * it: after the target when it moves down, before it when it moves up. None
 * for the space itself, or for a target on another machine, since herdr-app
 * keeps each space on its own machine.
 */
export const dropSide = (fleet: Fleet, space: string, onto: string): Option.Option<DropSide> =>
  pipe(
    Array.findFirst(fleet.machines, ({ spaces }) => Array.some(spaces, ({ id }) => id === space)),
    Option.flatMap(({ spaces }) =>
      Option.zipWith(
        Array.findFirstIndex(spaces, ({ id }) => id === space),
        Array.findFirstIndex(spaces, ({ id }) => id === onto),
        (from, to): Option.Option<DropSide> => (from === to ? Option.none() : Option.some(from < to ? "after" : "before")),
      ),
    ),
    Option.flatten,
  )

/** Every machine's spaces, this machine's first. */
export const spacesOf = (fleet: Fleet) => Array.flatMap(fleet.machines, ({ spaces }) => spaces)

/** The state that most needs the user: blocked, error, done, working, then idle. */
export const mostUrgent = (agents: ReadonlyArray<Terminal>): Option.Option<StatusState> =>
  Array.head(Array.sort(Array.getSomes(Array.map(agents, ({ status }) => Option.map(status, ({ state }) => state))), byUrgency))

const URGENCY: ReadonlyArray<StatusState> = ["blocked", "error", "done", "working", "idle"]

const byUrgency = Order.mapInput(Order.Number, (state: StatusState) => URGENCY.indexOf(state))

/** The terminals a layout shows, in reading order. */
export const terminalsIn = (node: Layout): ReadonlyArray<string> =>
  Match.valueTags(node, {
    Block: ({ content }) => (content._tag === "Terminal" ? [content.terminal] : []),
    Split: ({ children }) => Array.flatMap(children, terminalsIn),
    Unknown: () => [],
  })

/** The space and tab whose layout shows the terminal. */
export const locate = (fleet: Fleet, address: string): Option.Option<Readonly<{ space: Space; tab: Tab }>> =>
  pipe(
    Array.flatMap(spacesOf(fleet), (space) => Array.map(space.tabs, (tab) => ({ space, tab }))),
    Array.findFirst(({ tab }) => Array.contains(terminalsIn(tab.root), address)),
  )

/** A terminal whose program reports a status (OSC 7501), or a known agent's program. */
export const isAgent = (terminal: Terminal) => Option.isSome(terminal.status) || Option.isSome(harnessOf(terminal))

/**
 * What the user calls the terminal: its name, else its agent, else its
 * foreground program. The address is hc's id, which the user never sees.
 */
export const terminalLabel = (terminal: Terminal) =>
  pipe(
    Option.filter(terminal.name, String.isNonEmpty),
    Option.orElse(() => harnessOf(terminal)),
    Option.orElse(() => Option.filter(Option.map(terminal.foreground, ({ name }) => name), String.isNonEmpty)),
    Option.getOrElse(() => "terminal"),
  )

/** What the terminal's program is doing: its status message, else its title (an agent's conversation), else its state or folder. */
export const terminalNote = (terminal: Terminal) =>
  pipe(
    Option.flatMap(terminal.status, ({ msg, kind }) => Option.orElse(msg, () => kind)),
    Option.orElse(() => Option.filter(terminal.title, String.isNonEmpty)),
    Option.getOrElse(() => Option.match(terminal.status, { onNone: () => terminal.cwd, onSome: ({ state }) => state })),
  )

// herdr-app leaves names empty until the user sets one. It then calls a
// space after its folder's last segment, and a tab by its number.
export const spaceLabel = ({ name, folder }: Space) =>
  nonEmptyOr(name, pipe(String.split(folder, "/"), Array.last, Option.getOrElse(() => folder)))

export const tabLabel = ({ name }: Tab, index: number) => nonEmptyOr(name, `${index + 1}`)

const spaceTerminals = (space: Space) => Array.flatMap(space.tabs, ({ root }) => terminalsIn(root))

const nonEmptyOr = (text: string, fallback: string) => (String.isNonEmpty(text) ? text : fallback)
