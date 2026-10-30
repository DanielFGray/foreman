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
