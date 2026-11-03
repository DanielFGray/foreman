// The ladder's rungs in the Foreman column, cheapest first, each with its
// state and the switches that change the ladder: on or off, whether it may
// author and review, and a move one place cheaper or dearer. A disabled rung is
// dimmed, since no task is dispatched to it. Every switch runs a `foreman
// ladder` command, so foreman stays the one writer, and the page reads the
// ladder again once it is done.
import { Array } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ForemanRung } from "../shared/Foreman.ts"
import { commandButton } from "./commandButton.ts"
import { type ForemanPage, type Message, RungList } from "./model.ts"

export const ladderView = (page: ForemanPage, h: HtmlBuilder<Message>): Html =>
  h.details(
    [h.Class("foreman-ladder")],
    [
      h.summary([], ["Ladder"]),
      ...RungList.match(page.rungs, {
        Loading: () => [h.p([h.Class("note")], ["Reading the ladder…"])],
        Unlisted: ({ reason }) => [h.p([h.Class("note error")], [reason])],
        Listed: ({ rungs }) => [h.ol([h.Class("foreman-rungs-list"), h.AriaLabel("Rungs")], Array.map(rungs, (row, index) => rungView(row, rungs[index - 1], rungs[index + 1], page, h)))],
      }),
    ],
  )

const rungView = (row: ForemanRung, cheaper: ForemanRung | undefined, dearer: ForemanRung | undefined, page: ForemanPage, h: HtmlBuilder<Message>): Html => {
  const { rung, state, author, review } = row
  const on = state !== "disabled"
  return h.li(
    [h.Class(on ? "" : "off")],
    [
      h.span([h.Class("foreman-rung")], [rung]),
      h.span([h.Class("note")], [state]),
      h.span(
        [h.Class("foreman-rung-switches")],
        [
          commandButton(on ? "on" : "off", `${on ? "disable" : "enable"} ${rung}`, { _tag: "SetRung", rung, on: !on }, page, h, on),
          commandButton("author", author ? `keep ${rung} out of authoring` : `let ${rung} author`, { _tag: "SetRole", rung, role: "author", on: !author }, page, h, author),
          commandButton("review", review ? `keep ${rung} out of review` : `let ${rung} review`, { _tag: "SetRole", rung, role: "review", on: !review }, page, h, review),
          ...(cheaper === undefined ? [] : [commandButton("↑", `move ${rung} below ${cheaper.rung}`, { _tag: "MoveRung", rung, side: "below", of: cheaper.rung }, page, h)]),
          ...(dearer === undefined ? [] : [commandButton("↓", `move ${rung} above ${dearer.rung}`, { _tag: "MoveRung", rung, side: "above", of: dearer.rung }, page, h)]),
        ],
      ),
    ],
  )
}
