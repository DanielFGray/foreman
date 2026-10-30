// The view an agent's pane opens in. A pane gets its view when it comes on
// screen: on a reload, a switch of tab or space, or a new pane. It keeps that
// view until the user picks another, so an agent started in a shell that is
// on screen leaves it a terminal. The settings' `agentView` says where a pick
// holds: for the run of the agent it was made for, for every agent in its
// space, or not at all, when every agent opens as a chat.
import { Array, Match, Option, pipe, Record, String } from "effect"
import { modifyFields } from "foldkit/struct"
import { terminalsIn } from "./group.ts"
import type { Model, ViewName, ViewPick } from "./model.ts"
import { findTerminal, lastFleet, newView, shownTerminals, supportsAt, withView } from "./selection.ts"

/**
 * Gives each shown terminal that has no view yet the one it opens in. A
 * terminal whose program is not known yet waits, since a pane the page
 * starts an agent in shows no program for a moment.
 */
export const withOpeningViews = (model: Model): Model =>
  pipe(
    shownTerminals(model),
    Array.filter((address) => !Record.has(model.views, address) && Option.exists(findTerminal(model, address), ({ foreground }) => Option.isSome(foreground))),
    Array.match({
      onEmpty: () => model,
      onNonEmpty: (addresses) =>
        modifyFields(model, { views: (views) => Array.reduce(addresses, views, (opened, address) => Record.set(opened, address, newView(openingView(model, address)))) }),
    }),
  )

/** Shows `view` in the pane at `address`, and keeps the pick for the agent's run and for its space. */
export const pickedView = (model: Model, address: string, view: ViewName): Model => {
  const scopes = [...Option.toArray(runScope(model, address)), ...Option.toArray(spaceScope(model, address))]
  return modifyFields(withView(model, address, () => newView(view)), {
    viewPicks: (picks) =>
      Array.take(
        [
          ...Array.map(scopes, (scope): ViewPick => ({ scope, view })),
          // A terminal runs one agent at a time, so its older runs are done.
          ...Array.filter(picks, ({ scope }) => !Array.contains(scopes, scope) && !String.startsWith(`run:${address}:`)(scope)),
        ],
        PICKS_KEPT,
      ),
  })
}

const openingView = (model: Model, address: string): ViewName =>
  !supportsAt(model, address, "chat")
    ? "Terminal"
    : Match.value(model.settings.agentView).pipe(
        Match.when("run", () => pickedIn(model, runScope(model, address))),
        Match.when("space", () => pickedIn(model, spaceScope(model, address))),
        Match.when("chat", (): ViewName => "Chat"),
        Match.exhaustive,
      )

const pickedIn = (model: Model, scope: Option.Option<string>): ViewName =>
  pipe(
    scope,
    Option.flatMap((wanted) => Array.findFirst(model.viewPicks, ({ scope }) => scope === wanted)),
    Option.match({ onNone: () => "Terminal", onSome: ({ view }) => view }),
  )

/** One run of an agent: its terminal, and the agent's process. */
const runScope = (model: Model, address: string) =>
  Option.map(Option.flatMap(findTerminal(model, address), ({ foreground }) => foreground), ({ pid }) => `run:${address}:${pid}`)

/** The space whose tab holds the terminal. herdr-app names spaces on each machine, so the machine is part of it. */
const spaceScope = (model: Model, address: string) =>
  Option.flatMap(lastFleet(model.bridge), ({ machines }) =>
    Array.findFirst(machines, ({ name, spaces }) =>
      Option.map(
        Array.findFirst(spaces, ({ tabs }) => Array.some(tabs, ({ root }) => Array.contains(terminalsIn(root), address))),
        ({ id }) => `space:${name}:${id}`,
      ),
    ),
  )

const PICKS_KEPT = 100
