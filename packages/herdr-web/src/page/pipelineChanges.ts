// The unsaved edits to a pipeline, in words: what Save will write. The list is
// derived from the saved pipeline and the draft by block id, not kept as a log
// of edits, so a revert, a reset or a fresh read can never leave it stale.
import type { Pipeline, PipelineNode } from "foreman/pipeline"
import { beltOf, type Wire } from "foreman/pipeline-belt"
import { portName, summaryOf } from "./pipelineEdit.ts"

/**
 * One line per difference between the saved pipeline and the draft: blocks
 * added and removed, settings changed, routes added, removed and changed, and
 * wires pointed elsewhere. A wire that moved only because a block was put on
 * it or taken out is told by that block's line, not by a line of its own.
 */
export const changesOf = (saved: Pipeline, draft: Pipeline): ReadonlyArray<string> => {
  const before = new Map(saved.nodes.map((node) => [node.id, node]))
  const after = new Set(draft.nodes.map((node) => node.id))
  const wiresBefore = beltOf(saved).wires
  const wiresAfter = beltOf(draft).wires
  const added = draft.nodes.flatMap((node) => {
    const old = before.get(node.id)
    if (old === undefined) return [addedLine(node, wiresAfter)]
    if (old.kind !== node.kind) return [`made ${node.id} a ${node.kind}`]
    const routes = node.kind === "router" && old.kind === "router" ? alignRoutes(old.routes, node.routes) : []
    return [
      ...settingLines(old, node),
      ...routeLines(node.id, routes),
      ...rewiredLines(node.id, routes, wiresBefore, wiresAfter, before, after),
    ]
  })
  const removed = saved.nodes.flatMap((node) => (after.has(node.id) ? [] : [`removed ${node.kind} ${node.id}`]))
  return [...added, ...removed]
}

const addedLine = (node: PipelineNode, wires: ReadonlyArray<Wire>): string => {
  const into = wires.filter((wire) => wire.to === node.id).map((wire) => (wire.port === "next" ? wire.from : `${wire.from} ${portName(wire)}`))
  return `added ${node.kind} ${node.id} (${summaryOf(node)})${into.length === 0 ? "" : ` after ${into.join(", ")}`}`
}

const shown = (value: string | number | undefined, empty: string): string => (value === undefined || value === "" ? empty : `'${value}'`)

const changed = (id: string, field: string, from: string, to: string): string => `changed ${id}'s ${field} from ${from} to ${to}`

/** The settings `configure` changes, compared field by field, so a rebuilt block with the same values reads as unchanged. */
const settingLines = (old: PipelineNode, now: PipelineNode): ReadonlyArray<string> => {
  const fields: ReadonlyArray<readonly [string, string | number | undefined, string | number | undefined, string]> =
    old.kind === "source" && now.kind === "source"
      ? [["filter", old.filter, now.filter, "every task"]]
      : old.kind === "gate" && now.kind === "gate"
        ? [["step", old.step, now.step, "nothing"]]
        : old.kind === "agent" && now.kind === "agent"
          ? [
              ["role", old.role, now.role, "nothing"],
              ["model", old.model, now.model, "nothing"],
              ["slots", old.slots, now.slots, "no cap"],
            ]
          : old.kind === "check" && now.kind === "check"
            ? [["command", old.command, now.command, "no command"]]
            : []
  return fields.flatMap(([field, from, to, empty]) => (from === to ? [] : [changed(now.id, field, shown(from, empty), shown(to, empty))]))
}

type Route = { readonly when: string; readonly to: string }

/** A draft route matched to the saved route it was, or to none when it is new; a saved route no draft route matches was removed. */
type Aligned =
  | { readonly _tag: "Kept"; readonly saved: number; readonly draft: number; readonly from: Route; readonly to: Route }
  | { readonly _tag: "Added"; readonly draft: number; readonly route: Route }
  | { readonly _tag: "Removed"; readonly saved: number; readonly route: Route }

/**
 * Matches a router's saved routes to its draft routes. Routes have no ids, so
 * the longest run of equal filters anchors the match, and between two anchors
 * the routes pair up in order (a changed filter); what is left over on one
 * side was added or removed. Matching by position alone would read a removed
 * first route as every later route changed.
 */
const alignRoutes = (saved: ReadonlyArray<Route>, draft: ReadonlyArray<Route>): ReadonlyArray<Aligned> => {
  // common[i][j]: the longest run of equal filters in saved[i..] and draft[j..].
  const common = Array.from({ length: saved.length + 1 }, () => Array.from({ length: draft.length + 1 }, () => 0))
  for (let i = saved.length - 1; i >= 0; i--) {
    for (let j = draft.length - 1; j >= 0; j--) {
      common[i]![j] = saved[i]!.when === draft[j]!.when ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!)
    }
  }
  const aligned: Array<Aligned> = []
  const gapS: Array<number> = []
  const gapD: Array<number> = []
  const flush = () => {
    gapS.forEach((s, at) => {
      const d = gapD[at]
      aligned.push(d === undefined ? { _tag: "Removed", saved: s, route: saved[s]! } : { _tag: "Kept", saved: s, draft: d, from: saved[s]!, to: draft[d]! })
    })
    gapD.slice(gapS.length).forEach((d) => aligned.push({ _tag: "Added", draft: d, route: draft[d]! }))
    gapS.length = 0
    gapD.length = 0
  }
  let i = 0
  let j = 0
  while (i < saved.length || j < draft.length) {
    if (i < saved.length && j < draft.length && saved[i]!.when === draft[j]!.when && common[i]![j] === common[i + 1]![j + 1]! + 1) {
      flush()
      aligned.push({ _tag: "Kept", saved: i, draft: j, from: saved[i]!, to: draft[j]! })
      i++
      j++
    } else if (j >= draft.length || (i < saved.length && common[i + 1]![j]! >= common[i]![j + 1]!)) {
      gapS.push(i++)
    } else {
      gapD.push(j++)
    }
  }
  flush()
  return aligned
}

const routeLines = (id: string, routes: ReadonlyArray<Aligned>): ReadonlyArray<string> =>
  routes.flatMap((route) => {
    switch (route._tag) {
      case "Added":
        return [`added route ${route.draft + 1} (${shown(route.route.when, "every task")}) to ${id}`]
      case "Removed":
        return [`removed route ${route.saved + 1} (${shown(route.route.when, "every task")}) from ${id}`]
      case "Kept":
        return route.from.when === route.to.when ? [] : [changed(id, `route ${route.draft + 1} filter`, shown(route.from.when, "every task"), shown(route.to.when, "every task"))]
    }
  })

/**
 * The wires out of a kept block that now run to another kept block. A wire
 * whose old end was removed, or whose new end was added, moved because of
 * that block, and its line already says so.
 */
const rewiredLines = (
  id: string,
  routes: ReadonlyArray<Aligned>,
  wiresBefore: ReadonlyArray<Wire>,
  wiresAfter: ReadonlyArray<Wire>,
  before: ReadonlyMap<string, PipelineNode>,
  after: ReadonlySet<string>,
): ReadonlyArray<string> =>
  wiresAfter
    .filter((wire) => wire.from === id)
    .flatMap((wire) => {
      const port = typeof wire.port === "number" ? routes.find((route) => route._tag === "Kept" && route.draft === wire.port) : undefined
      const savedPort = typeof wire.port === "number" ? (port?._tag === "Kept" ? port.saved : undefined) : wire.port
      const old = wiresBefore.find((one) => one.from === id && one.port === savedPort)
      if (old === undefined || old.to === wire.to || !after.has(old.to) || !before.has(wire.to)) return []
      return [`${id} ${portName(wire)} now runs to ${wire.to}`]
    })
