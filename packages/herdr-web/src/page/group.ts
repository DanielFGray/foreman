// How the page files terminals: by the herdr-app layout trees that place
// them, in herdr-app's own order of spaces, tabs and panes.
import { Array, HashMap, HashSet, Match, Option, pipe, Result, String } from "effect"
import type { Fleet, Layout, Space, Tab, Terminal } from "../shared/Fleet.ts"

export type Filter = "Agents" | "All"

export type SpaceGroup = Readonly<{ id: string; label: string; terminals: ReadonlyArray<Terminal> }>

/**
 * Every space with a shown terminal, then the shown terminals that no layout
 * places, under "Other". hc keeps a terminal after its program exits, so only
 * live terminals are listed.
 */
export const groupFleet = (fleet: Fleet, filter: Filter): ReadonlyArray<SpaceGroup> => {
  const isShown = (terminal: Terminal) => terminal.state === "live" && (filter === "All" || isAgent(terminal))
  const byAddress = HashMap.fromIterable(Array.map(fleet.terminals, (terminal) => [terminal.address, terminal] as const))
  const spaces = Array.filterMap(fleet.spaces, (space) => {
    const terminals = pipe(
      spaceTerminals(space),
      Array.filterMap((address) => Result.fromOption(HashMap.get(byAddress, address), () => undefined)),
      Array.filter(isShown),
    )
    return Array.isArrayNonEmpty(terminals) ? Result.succeed({ id: space.id, label: spaceLabel(space), terminals }) : Result.failVoid
  })
  const placed = HashSet.fromIterable(Array.flatMap(fleet.spaces, spaceTerminals))
  const loose = Array.filter(fleet.terminals, (terminal) => isShown(terminal) && !HashSet.has(placed, terminal.address))
  return Array.isArrayNonEmpty(loose) ? [...spaces, { id: OTHER, label: "Other", terminals: loose }] : spaces
}

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
    Array.flatMap(fleet.spaces, (space) => Array.map(space.tabs, (tab) => ({ space, tab }))),
    Array.findFirst(({ tab }) => Array.contains(terminalsIn(tab.root), address)),
  )

/** A terminal whose program reports a status (OSC 7501), which is what agents do. */
export const isAgent = (terminal: Terminal) => Option.isSome(terminal.status)

/** The terminal's name, else its title, else its foreground program, else its address. */
export const terminalLabel = (terminal: Terminal) =>
  pipe(
    terminal.name,
    Option.orElse(() => terminal.title),
    Option.orElse(() => Option.map(terminal.foreground, ({ name }) => name)),
    Option.filter(String.isNonEmpty),
    Option.getOrElse(() => terminal.address),
  )

// herdr-app leaves names empty until the user sets one. It then calls a
// space after its folder's last segment, and a tab by its number.
export const spaceLabel = ({ name, folder }: Space) =>
  nonEmptyOr(name, pipe(String.split(folder, "/"), Array.last, Option.getOrElse(() => folder)))

export const tabLabel = ({ name }: Tab, index: number) => nonEmptyOr(name, `${index + 1}`)

const OTHER = "other"

const spaceTerminals = (space: Space) => Array.flatMap(space.tabs, ({ root }) => terminalsIn(root))

const nonEmptyOr = (text: string, fallback: string) => (String.isNonEmpty(text) ? text : fallback)
