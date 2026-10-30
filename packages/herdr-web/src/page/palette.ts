// The command palette's search: every machine's spaces, tabs, panes and
// agents, and the settings, matched by a typed query and ranked.
import { Array, Option, Order, pipe, Record, Result, Schema as S, String } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
import { locate, spaceRowOf, spacesOf, terminalLabel, terminalNote } from "./group.ts"
import { Bot, Folder, type IconNode, Settings as SettingsIcon, SquareTerminal } from "./icons.ts"
import { programOf } from "./programs.ts"

/** What opening a result shows: the same things a click in the sidebar shows. */
export const PaletteTarget = defineTaggedUnion({
  Tab: { tabId: S.String },
  Terminal: { address: S.String },
  Settings: {},
})
export type PaletteTarget = typeof PaletteTarget.Type

/** In the order the palette lists them. */
export const GROUPS = ["Recent", "Spaces", "Tabs", "Panes", "Settings"] as const
export type Group = (typeof GROUPS)[number]

export type PaletteResult = Readonly<{
  /** Unique across the list, since a recent pane is listed twice. */
  key: string
  group: Group
  icon: IconNode
  title: string
  detail: string
  target: PaletteTarget
}>

/** The search box's id, for the command that focuses it. */
export const PALETTE_INPUT_ID = "palette-input"

/** The most results listed; a longer list is for scrolling, not choosing. */
const MAX_RESULTS = 40

/**
 * The results for a query, grouped in the palette's order. Each word of the
 * query must match a result's title or one of its other fields (folder,
 * git branch, program, machine, tab); a title match ranks above a field
 * match, and a match at the start of the title above one in its middle. An empty query
 * lists the recent panes first, then everything.
 */
export const searchPalette = (fleet: Option.Option<Fleet>, recent: ReadonlyArray<string>, query: string): ReadonlyArray<PaletteResult> => {
  const words = pipe(String.toLowerCase(query), String.split(/\s+/), Array.filter(String.isNonEmpty))
  const entries = [...fleetEntries(fleet), ...SETTINGS_ENTRIES]
  const ranked = Array.flatMap(GROUPS, (group) =>
    pipe(
      Array.filter(entries, (entry) => entry.result.group === group),
      Array.filterMap((entry) => Option.match(rank(entry, words), { onNone: () => Result.failVoid, onSome: (score) => Result.succeed([entry.result, score] as const) })),
      Array.sort(byScore),
      Array.map(([result]) => result),
    ),
  )
  const recents = String.isEmpty(String.trim(query)) ? recentResults(entries, recent) : []
  return Array.take([...recents, ...ranked], MAX_RESULTS)
}

type Entry = Readonly<{ result: PaletteResult; fields: ReadonlyArray<string> }>

// 0 for a title that starts with the word, 1 for one that holds it, 2 for a field that holds it.
const rank = ({ result, fields }: Entry, words: ReadonlyArray<string>): Option.Option<number> => {
  const title = String.toLowerCase(result.title)
  const scores = Array.map(words, (word) =>
    String.startsWith(word)(title)
      ? Option.some(0)
      : String.includes(word)(title)
        ? Option.some(1)
        : Array.some(fields, (field) => String.includes(word)(String.toLowerCase(field)))
          ? Option.some(2)
          : Option.none(),
  )
  return Option.map(Option.all(scores), (all) => Array.reduce(all, 0, (sum, score) => sum + score))
}

const byScore = Order.mapInput(Order.Number, ([, score]: readonly [PaletteResult, number]) => score)

/** The recent panes that are still in the fleet, newest first, as their own group. */
const recentResults = (entries: ReadonlyArray<Entry>, recent: ReadonlyArray<string>): ReadonlyArray<PaletteResult> =>
  Array.getSomes(
    Array.map(recent, (address) =>
      Option.map(
        Array.findFirst(entries, ({ result }) => result.group === "Panes" && result.target._tag === "Terminal" && result.target.address === address),
        ({ result }): PaletteResult => ({ ...result, key: `recent/${result.key}`, group: "Recent" }),
      ),
    ),
  )

const fleetEntries = (fleet: Option.Option<Fleet>): ReadonlyArray<Entry> =>
  Option.match(fleet, {
    onNone: () => [],
    onSome: (current) => {
      const spaceRow = spaceRowOf(current)
      const machineOf = (spaceId: string) =>
        Option.match(Array.findFirst(current.machines, ({ spaces }) => Array.some(spaces, ({ id }) => id === spaceId)), {
          onNone: () => "",
          onSome: ({ name }) => name,
        })
      const rows = Array.map(spacesOf(current), spaceRow)
      const branchOf = (spaceId: string) => Option.flatMap(Record.get(current.git, spaceId), ({ branch }) => branch)
      const spaces = Array.flatMap(rows, ({ space, label, tabs }) =>
        Option.match(Array.head(tabs), {
          onNone: () => [],
          onSome: ({ tab }): ReadonlyArray<Entry> => [
            {
              result: {
                key: `space/${space.id}`,
                group: "Spaces",
                icon: Folder,
                title: label,
                detail: Option.match(branchOf(space.id), { onNone: () => space.folder, onSome: (branch) => `${space.folder} · ${branch}` }),
                target: PaletteTarget.Tab({ tabId: tab.id }),
              },
              fields: [space.folder, machineOf(space.id), ...Option.toArray(branchOf(space.id)), ...Array.map(tabs, (row) => row.label)],
            },
          ],
        }),
      )
      const tabs = Array.flatMap(rows, ({ space, label: spaceName, tabs: tabRows }) =>
        Array.map(
          tabRows,
          ({ tab, label, program }): Entry => ({
            result: {
              key: `tab/${tab.id}`,
              group: "Tabs",
              icon: Option.match(program, { onNone: () => SquareTerminal, onSome: (known) => known.icon }),
              title: label,
              detail: spaceName,
              target: PaletteTarget.Tab({ tabId: tab.id }),
            },
            fields: [spaceName, space.folder, machineOf(space.id), ...Option.toArray(Option.map(program, ({ name }) => name))],
          }),
        ),
      )
      const panes = Array.map(
        Array.filter(current.terminals, ({ state }) => state === "live"),
        (terminal): Entry => paneEntry(current, terminal),
      )
      return [...spaces, ...tabs, ...panes]
    },
  })

const paneEntry = (fleet: Fleet, terminal: Terminal): Entry => {
  const place = locate(fleet, terminal.address)
  const program = programOf(terminal)
  const where = Option.match(place, { onNone: () => [], onSome: ({ space, tab }) => [space.name, space.folder, tab.name] })
  return {
    result: {
      key: `pane/${terminal.address}`,
      group: "Panes",
      icon: Option.match(program, { onNone: () => Bot, onSome: (known) => known.icon }),
      title: terminalLabel(terminal),
      detail: Option.match(place, {
        onNone: () => terminalNote(terminal),
        onSome: ({ space, tab }) => `${space.name || space.folder} / ${tab.name || terminalNote(terminal)}`,
      }),
      target: PaletteTarget.Terminal({ address: terminal.address }),
    },
    // An address names its machine before the slash.
    fields: [terminal.cwd, ...Option.toArray(Option.map(program, ({ name }) => name)), ...Option.toArray(terminal.title), ...where, ...Array.dropRight(String.split(terminal.address, "/"), 1)],
  }
}

// The settings the page has, each found by the words a user would try.
const SETTINGS_ENTRIES: ReadonlyArray<Entry> = Array.map(
  [
    ["Settings", "Fonts, text sizes and the agent list", ["font", "size", "text", "agents", "sidebar"]],
    ["Terminal font", "Settings", ["font", "size", "monospace", "text"]],
    ["Chat font", "Settings", ["font", "size", "text"]],
    ["Agent list", "Settings", ["agents", "sidebar", "nested", "below", "list"]],
  ] as const,
  ([title, detail, fields]): Entry => ({
    result: { key: `setting/${title}`, group: "Settings", icon: SettingsIcon, title, detail, target: PaletteTarget.Settings() },
    fields,
  }),
)

/** The most panes kept as recent. */
const RECENT_LIMIT = 5

/** The recent panes with `address` first, once: opening a pane again moves it up, not down the list twice. */
export const withRecent = (recent: ReadonlyArray<string>, address: string): ReadonlyArray<string> =>
  Array.take([address, ...Array.filter(recent, (other) => other !== address)], RECENT_LIMIT)

/** Ctrl+K, or Cmd+K on a Mac. Firefox keeps Ctrl+Shift+K for its web console. */
export const isPaletteKey = ({ key, ctrlKey, metaKey, shiftKey, altKey }: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">) =>
  (ctrlKey || metaKey) && !shiftKey && !altKey && String.toLowerCase(key) === "k"
