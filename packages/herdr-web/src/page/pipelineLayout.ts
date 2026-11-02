// Where the Pipeline editor puts each block and wire on the page. Sizes follow
// from the kind of block, so the drawing needs no measuring of the browser: a
// column is as wide as its widest block, a row as tall as its tallest, and a
// wire's route is a list of points that the view draws as a path.
import type { Belt, Cell, Wire } from "foreman/pipeline-belt"

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export type Point = readonly [number, number]

export interface PlacedWire {
  readonly wire: Wire
  /** The corners of the wire's route, from the block it leaves to the block it enters. */
  readonly points: ReadonlyArray<Point>
  /** The middle of the stretch the wire's label and "+" sit on, and that stretch's length. */
  readonly anchor: Point
  readonly room: number
}

export interface Layout {
  readonly width: number
  readonly height: number
  /** Grid tracks: the widths of the columns with the gaps between them, and the same for rows. */
  readonly columnTracks: ReadonlyArray<number>
  readonly rowTracks: ReadonlyArray<number>
  readonly boxes: ReadonlyMap<string, Box>
  readonly wires: ReadonlyArray<PlacedWire>
}

export const PAD = 12
const GAP_Y = 40
const MIN_GAP_X = 34
const STAGGER = 11
/** The height between the exits of a block with several wires, enough for a label above each. */
const EXIT_SPACING = 30
const LABEL_MAX = 84

/** How big a block draws: gates and routers are chips, the rest are cards. */
export const sizeOf = (kind: Cell["node"]["kind"], exits: number): { readonly w: number; readonly h: number } => {
  switch (kind) {
    case "source":
      return { w: 100, h: 44 }
    case "agent":
    case "check":
    case "park":
      return { w: 114, h: 44 }
    case "land":
    case "done":
      return { w: 72, h: 44 }
    case "branch":
    case "worktree":
      return { w: 72, h: 28 }
    case "gate":
      return { w: 88, h: 28 }
    case "router":
      return { w: 88, h: Math.max(28, EXIT_SPACING * exits) }
  }
}

/** The width of a wire's label, which the gap before the next column must have room for. */
export const labelWidth = (label: string): number => (label === "" ? 0 : Math.min(LABEL_MAX, Math.ceil(label.length * 5.8) + 6))

export const layoutOf = (belt: Belt): Layout => {
  const exitsOf = (id: string) => belt.wires.filter((wire) => wire.from === id)
  const sizes = new Map(belt.cells.map((cell) => [cell.node.id, sizeOf(cell.node.kind, exitsOf(cell.node.id).length)]))
  const sizeFor = (cell: Cell) => sizes.get(cell.node.id) ?? sizeOf(cell.node.kind, 1)

  const columnWidth = Array.from({ length: belt.columns }, (_, column) =>
    Math.max(0, ...belt.cells.filter((cell) => cell.column === column).map((cell) => sizeFor(cell).w)),
  )
  const rowHeight = Array.from({ length: belt.rows }, (_, row) =>
    Math.max(0, ...belt.cells.filter((cell) => cell.row === row).map((cell) => sizeFor(cell).h)),
  )
  const rowTop: Array<number> = []
  rowHeight.reduce((top, height, row) => ((rowTop[row] = top), top + height + GAP_Y), PAD)

  // Boxes depend on the columns' left edges, which depend on the gaps before them,
  // which depend on the wires that leave the columns before: so go column by column.
  const columnLeft: Array<number> = []
  const gap: Array<number> = []
  const boxes = new Map<string, Box>()
  const boxOf = (id: string) => boxes.get(id)
  let left = PAD
  for (let column = 0; column < belt.columns; column++) {
    columnLeft[column] = left
    const here = belt.cells.filter((cell) => cell.column === column)
    for (const cell of here) {
      const { w, h } = sizeFor(cell)
      boxes.set(cell.node.id, { x: left + (columnWidth[column]! - w) / 2, y: rowTop[cell.row]! + (rowHeight[cell.row]! - h) / 2, w, h })
    }
    const leaving = belt.wires.filter((wire) => here.some((cell) => cell.node.id === wire.from))
    gap[column] = Math.max(MIN_GAP_X, ...leaving.map((wire) => labelWidth(wire.label) + 18 + STAGGER * (leaving.length - 1)))
    left += columnWidth[column]! + gap[column]!
  }

  const columnOfId = new Map(belt.cells.map((cell) => [cell.node.id, cell]))
  const wires = belt.wires.map((wire, index): PlacedWire | undefined => {
    const from = columnOfId.get(wire.from)
    const to = columnOfId.get(wire.to)
    const fromBox = boxOf(wire.from)
    const toBox = boxOf(wire.to)
    if (from === undefined || to === undefined || fromBox === undefined || toBox === undefined) return undefined
    const siblings = exitsOf(wire.from)
    const at = siblings.findIndex((other) => other.port === wire.port)
    const y0 = siblings.length === 1 ? fromBox.y + fromBox.h / 2 : fromBox.y + EXIT_SPACING / 2 + EXIT_SPACING * at
    const y1 = toBox.y + toBox.h / 2
    const out: Point = [fromBox.x + fromBox.w, y0]
    const into: Point = [toBox.x, y1]
    const leavingColumn = belt.wires.filter((other) => columnOfId.get(other.from)?.column === from.column)
    const k = leavingColumn.indexOf(wire)
    const vx1 = columnLeft[from.column + 1]! - 12 - STAGGER * (k % 4)
    const crossesCard = belt.cells.some((cell) => cell.column > from.column && cell.column < to.column && cell.row === to.row)
    const points: ReadonlyArray<Point> = !crossesCard
      ? [out, [vx1, y0], [vx1, y1], into]
      : (() => {
          // A lane runs between two rows, where no card stands.
          const laneY =
            (to.row < from.row ? rowTop[from.row]! - GAP_Y / 2 : rowTop[from.row]! + rowHeight[from.row]! + GAP_Y / 2) + ((index % 3) - 1) * 5
          const vx2 = columnLeft[to.column]! - 12 - STAGGER * (index % 3)
          return [out, [vx1, y0], [vx1, laneY], [vx2, laneY], [vx2, y1], into]
        })()
    const corners = dedupe(points)
    return { wire, points: corners, ...anchorOf(corners) }
  })

  const trackOf = (sizes: ReadonlyArray<number>, gaps: ReadonlyArray<number>) => sizes.flatMap((size, index) => (index < sizes.length - 1 ? [size, gaps[index]!] : [size]))
  return {
    width: left - gap[belt.columns - 1]! + PAD,
    height: (rowTop[belt.rows - 1] ?? PAD) + (rowHeight[belt.rows - 1] ?? 0) + GAP_Y / 2 + PAD,
    columnTracks: trackOf(columnWidth, gap),
    rowTracks: trackOf(rowHeight, rowHeight.map(() => GAP_Y)),
    boxes,
    wires: wires.filter((placed): placed is PlacedWire => placed !== undefined),
  }
}

const dedupe = (points: ReadonlyArray<Point>): ReadonlyArray<Point> =>
  points.filter((point, index) => index === 0 || point[0] !== points[index - 1]![0] || point[1] !== points[index - 1]![1])

/** The label and "+" sit mid-stretch on the longest level stretch that is not the last, so two wires into one block keep apart. */
const anchorOf = (points: ReadonlyArray<Point>): { readonly anchor: Point; readonly room: number } => {
  const stretches = points.flatMap((point, index): ReadonlyArray<{ readonly from: Point; readonly to: Point }> => {
    const next = points[index + 1]
    return next !== undefined && next[1] === point[1] && next[0] > point[0] ? [{ from: point, to: next }] : []
  })
  const candidates = stretches.length > 1 ? stretches.slice(0, -1) : stretches
  const best = candidates.reduce((one, other) => (other.to[0] - other.from[0] > one.to[0] - one.from[0] ? other : one), candidates[0] ?? { from: points[0]!, to: points[points.length - 1]! })
  return { anchor: [(best.from[0] + best.to[0]) / 2, best.from[1]], room: best.to[0] - best.from[0] }
}

/** The room between a block and the inspector floating beside it. */
const BESIDE_GAP = 12

/**
 * Where a panel `panelWidth` wide floats beside a block on a drawing `width`
 * wide: right of the block when it fits there, else left of it, else under
 * it, pressed against the drawing's right edge. The panel takes no width of
 * its own, so the drawing is laid out as if it were not there.
 */
export const besideOf = (box: Box, width: number, panelWidth: number): Point => {
  const right = box.x + box.w + BESIDE_GAP
  if (right + panelWidth <= width) return [right, box.y]
  const left = box.x - BESIDE_GAP - panelWidth
  if (left >= 0) return [left, box.y]
  return [Math.max(0, Math.min(box.x, width - panelWidth)), box.y + box.h + BESIDE_GAP]
}
