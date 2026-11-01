import { Option } from "effect"
import { expect, test } from "vitest"
import type { Fleet, SpaceGit } from "../shared/Fleet.ts"
import type { ForemanRow } from "../shared/Foreman.ts"
import { queueScopeOf, visibleRows } from "./foreman.ts"
import { init } from "./main.ts"
import { Bridge, type Model, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"

const gitOf = (project: Option.Option<string>): SpaceGit => ({ top: "/src", branch: Option.none(), changed: false, project })

const space = (id: string) => ({ id, name: "", folder: `/src/${id}`, tabs: [{ id: `tab-${id}`, name: "", root: { _tag: "Unknown" as const, type: "browser" } }] })

const fleet: Fleet = {
  connected: true,
  terminals: [],
  git: { app: gitOf(Option.some("app")), notes: gitOf(Option.none()) },
  machines: [{ name: "here", isLocal: true, state: "connected", spaces: [space("app"), space("notes")] }],
}

/** The model with a tab of space `id` on show, the column shown or not, and the scope `all` or not. */
const modelOn = (id: string, { shown, all }: { shown: boolean; all: boolean }): Model => {
  const start = init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [] }).model
  return {
    ...start,
    selection: Selection.Tab({ tabId: `tab-${id}`, maybeFocus: Option.none() }),
    bridge: Bridge.Watching({ fleet }),
    foremanPage: { ...start.foremanPage, shown, all },
  }
}

const row = (key: string, project: Option.Option<string>): ForemanRow => ({
  view: "queue",
  key,
  label: key,
  detail: Option.none(),
  project,
  parent: Option.none(),
  epic: false,
  actions: [],
})

test("the queue is read for the selected space's project, every project for all, and not at all when hidden or in no project", () => {
  expect(queueScopeOf(modelOn("app", { shown: true, all: false }))).toEqual(Option.some(Option.some("app")))
  expect(queueScopeOf(modelOn("app", { shown: true, all: true }))).toEqual(Option.some(Option.none()))
  expect(queueScopeOf(modelOn("app", { shown: false, all: false }))).toEqual(Option.none())
  expect(queueScopeOf(modelOn("notes", { shown: true, all: false }))).toEqual(Option.none())
  // `all` widens even a space in no project: foreman's own read of every open project.
  expect(queueScopeOf(modelOn("notes", { shown: true, all: true }))).toEqual(Option.some(Option.none()))
})

test("a row of another project never shows for a space, even in a read that has not caught up with a switch", () => {
  const rows = [row("ts-app", Option.some("app")), row("ts-lib", Option.some("lib")), row("acct", Option.none())]
  expect(visibleRows(modelOn("app", { shown: true, all: false }), rows).map(({ key }) => key)).toEqual(["ts-app", "acct"])
  expect(visibleRows(modelOn("notes", { shown: true, all: false }), rows).map(({ key }) => key)).toEqual(["acct"])
  expect(visibleRows(modelOn("app", { shown: true, all: true }), rows)).toEqual(rows)
})
