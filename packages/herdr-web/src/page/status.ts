// An agent's status as a coloured dot.
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { StatusState, Terminal } from "../shared/Fleet.ts"

export const statusDot = <M>(maybeState: Option.Option<StatusState>, h: HtmlBuilder<M>): Html =>
  h.span(
    [
      h.Class(`dot ${Option.getOrElse(maybeState, () => "shell")}`),
      h.Title(Option.getOrElse(maybeState, () => "no status")),
    ],
    [],
  )

/** A space's or tab's mark: its most urgent agent's dot, or nothing without agents. */
export const statusMark = <M>(maybeState: Option.Option<StatusState>, h: HtmlBuilder<M>) =>
  Option.toArray(Option.map(maybeState, (state) => statusDot(Option.some(state), h)))

export const stateOf = ({ status }: Terminal) => Option.map(status, ({ state }) => state)

/** The verb that goes with a state in "waiting 4m". */
const SPENT: Record<StatusState, string> = { blocked: "waiting", error: "error", done: "done", working: "working", idle: "idle" }

/** The heading over the agents in a state. */
export const stateHeading: Record<StatusState, string> = { blocked: "Waiting for you", error: "Error", done: "Done", working: "Working", idle: "Idle" }

/** How long the agent has been in its state, such as "waiting 4m"; nothing while hc has not said when it changed. */
export const timeInState = (terminal: Terminal, now: number): Option.Option<string> =>
  Option.zipWith(stateOf(terminal), terminal.status_ms, (state, since) => `${SPENT[state]} ${duration(now - since)}`)

/** The age of a status change under which the clock must tick each second to keep it right. */
export const SECONDS_SHOWN_UNTIL = 60_000

/** Seconds under a minute, then minutes, hours and days, each rounded down. */
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.floor(seconds / 60)}m` : seconds < 86_400 ? `${Math.floor(seconds / 3_600)}h` : `${Math.floor(seconds / 86_400)}d`
}
