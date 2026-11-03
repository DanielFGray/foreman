// Where tasks stand in the selected project's pipeline, as the dispatcher last
// placed them. The drawing wears a count on each block, a list under it names
// the tasks, and a stopped pipeline shows its problems. All of it is read-only
// and follows foreman's reading, so it needs no polling of its own.
import { Array, Option, pipe } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PipelineNode } from "foreman/pipeline"
import type { Belt } from "foreman/pipeline-belt"
import type { ForemanPlacement, ForemanReading } from "../shared/Foreman.ts"
import type { Message, Model } from "./model.ts"

/** What the dispatcher last said of one project: its placed tasks, and why its pipeline is stopped, if it is. */
export interface Standing {
  readonly tasks: ReadonlyArray<ForemanPlacement>
  readonly problems: ReadonlyArray<string>
}

export const standingOf = (model: Model, project: string): Standing =>
  Option.match(Option.flatMap(model.foreman, (state) => state.reading), {
    onNone: () => ({ tasks: [], problems: [] }),
    onSome: (reading: ForemanReading) => ({
      tasks: Array.filter(reading.placements, (placed) => placed.project === project),
      problems: pipe(reading.stopped, Array.filter((each) => each.project === project), Array.flatMap((each) => each.problems)),
    }),
  })

/**
 * The tasks a block holds: those foreman draws on it (`stands`). A task not yet
 * started stands at its source, a waiting one at the gate in front of its block.
 */
export const tasksAt = (node: PipelineNode, tasks: ReadonlyArray<ForemanPlacement>): ReadonlyArray<ForemanPlacement> =>
  Array.filter(tasks, (placed) => placed.stands === node.id)

/** "2 waiting, 1 running": the tasks at a block counted by state, in the order a task goes through them. */
export const countsOf = (tasks: ReadonlyArray<ForemanPlacement>): string =>
  pipe(
    ["waiting", "running", "ended", "parked"] as const,
    Array.flatMap((state) => {
      const n = Array.filter(tasks, (placed) => placed.state === state).length
      return n === 0 ? [] : [`${n} ${state}`]
    }),
    Array.join(", "),
  )

/** The mark a block wears: how many tasks stand at it, or wait behind a gate. */
export const badgeView = (node: PipelineNode, tasks: ReadonlyArray<ForemanPlacement>, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const here = tasksAt(node, tasks)
  if (!Array.isReadonlyArrayNonEmpty(here)) return []
  const title = node.kind === "gate" ? `${here.length} held at this gate` : countsOf(here)
  return [h.span([h.Class("pipeline-count"), h.Title(title), h.AriaLabel(title)], [String(here.length)])]
}

/** Why the pipeline cannot run; the editor still opens so the drawing can be mended. */
export const stoppedView = (project: string, problems: ReadonlyArray<string>, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Array.isReadonlyArrayNonEmpty(problems)
    ? [
        h.section(
          [h.Class("pipeline-stopped"), h.Role("alert"), h.AriaLabel("Stopped")],
          [
            h.p([h.Class("note error")], [`The pipeline of ${project} is stopped, so no task takes a step.`]),
            h.ul([h.Class("pipeline-problems")], Array.map(problems, (problem) => h.li([], [problem]))),
          ],
        ),
      ]
    : []

/** Under the drawing: each block that holds tasks, with a list of them that opens and shuts. */
export const standingView = (belt: Belt, tasks: ReadonlyArray<ForemanPlacement>, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const blocks = Array.map(belt.cells, ({ node }) => [node, tasksAt(node, tasks)] as const)
  const held = Array.filter(blocks, ([, here]) => Array.isReadonlyArrayNonEmpty(here))
  if (!Array.isReadonlyArrayNonEmpty(held)) return [h.p([h.Class("note")], ["No task stands at a block."])]
  return [
    h.section(
      [h.Class("pipeline-standing"), h.AriaLabel("Tasks at each block")],
      Array.map(held, ([node, here]) =>
        h.keyed("details")(
          node.id,
          [h.Class("pipeline-standing-block")],
          [
            h.summary([], [`${node.id}: ${countsOf(here)}`]),
            h.ul(
              [h.AriaLabel(`tasks at ${node.id}`)],
              Array.map(here, (placed) =>
                h.li(
                  [],
                  [
                    h.span([h.Class("foreman-key")], [placed.key]),
                    ` ${placed.label}`,
                    ...(Array.isReadonlyArrayNonEmpty(placed.gates)
                      ? [h.span([h.Class("note")], [` (held by ${Array.join(Array.map(placed.gates, (gate) => `${gate.id} for ${gate.step}`), ", ")})`])]
                      : []),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  ]
}
