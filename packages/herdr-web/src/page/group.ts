// How the page files terminals: under the herdr-app space and tab that their
// `herdr.space` and `herdr.tab` labels name, in herdr-app's own order.
import { Array, Option, pipe, Result, String } from "effect"
import type { Fleet, Space, Terminal } from "../shared/Fleet.ts"

export type Filter = "Agents" | "All"

export type TabGroup = Readonly<{ id: string; label: string; terminals: ReadonlyArray<Terminal> }>
export type SpaceGroup = Readonly<{ id: string; label: string; tabs: ReadonlyArray<TabGroup> }>

/** The spaces and tabs that hold at least one shown terminal; terminals no space claims come last, under "Other". */
export const groupFleet = (fleet: Fleet, filter: Filter): ReadonlyArray<SpaceGroup> => {
  const shown = Array.filter(fleet.terminals, (terminal) => filter === "All" || isAgent(terminal))
  const spaceIds = new Set(Array.map(fleet.spaces, ({ id }) => id))
  const unclaimed = Array.filter(shown, (terminal) => !Option.exists(label(terminal, SPACE), (id) => spaceIds.has(id)))

  const spaces = Array.filterMap(fleet.spaces, (space) => {
    const inSpace = Array.filter(shown, (terminal) => Option.contains(label(terminal, SPACE), space.id))
    const tabIds = new Set(Array.map(space.tabs, ({ id }) => id))
    const filed = Array.map(space.tabs, ({ id, name }, index) => ({
      id,
      label: nonEmptyOr(name, `${index + 1}`),
      terminals: Array.filter(inSpace, (terminal) => Option.contains(label(terminal, TAB), id)),
    }))
    // herdr-app does not label every terminal with its tab; those still
    // belong to the space.
    const loose = {
      id: `${space.id}/${OTHER}`,
      label: "",
      terminals: Array.filter(inSpace, (terminal) => !Option.exists(label(terminal, TAB), (id) => tabIds.has(id))),
    }
    const tabs = Array.filter([...filed, loose], ({ terminals }) => Array.isArrayNonEmpty(terminals))
    return Array.isArrayNonEmpty(tabs) ? Result.succeed({ id: space.id, label: spaceLabel(space), tabs }) : Result.failVoid
  })

  return Array.isArrayNonEmpty(unclaimed)
    ? [...spaces, { id: OTHER, label: "Other", tabs: [{ id: OTHER, label: "", terminals: unclaimed }] }]
    : spaces
}

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

const SPACE = "herdr.space"
const TAB = "herdr.tab"
const OTHER = "other"

const label = (terminal: Terminal, key: string) => Option.fromUndefinedOr(terminal.labels[key])

const nonEmptyOr = (text: string, fallback: string) => (String.isNonEmpty(text) ? text : fallback)

// herdr-app leaves a space's name empty until the user names it, and then
// shows the folder's last segment.
const spaceLabel = ({ name, folder }: Space) =>
  nonEmptyOr(name, pipe(String.split(folder, "/"), Array.last, Option.getOrElse(() => folder)))
