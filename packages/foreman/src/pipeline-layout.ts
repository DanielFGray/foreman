// Where a pipeline drawing puts each block and wire. Sizes follow
// from the kind of block, so the drawing needs no measuring by the renderer: a
// column is as wide as its widest block, a row as tall as its tallest, and a
// wire's route is a list of points that the view draws as a path.
import type { Pipeline, PipelineNode } from "./pipeline.ts";
import { type Belt, beltOf, type Cell, type Port, type Wire } from "./pipeline-belt.ts";

/** Which way work moves through a drawing: left to right, or top to bottom. */
export type Flow = "across" | "down";

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type Point = readonly [number, number];

export interface PlacedWire {
  readonly wire: Wire;
  /** The corners of the wire's route, from the block it leaves to the block it enters. */
  readonly points: ReadonlyArray<Point>;
  /** Where the wire's label sits, and how wide it may draw there. */
  readonly anchor: Point;
  readonly room: number;
  /** Where an editor's "+" sits, to put a block on the wire: on the anchor across, beside the label down. */
  readonly plus: Point;
}

export interface Layout {
  readonly width: number;
  readonly height: number;
  /** Grid tracks: the widths of the columns with the gaps between them, and the same for rows. */
  readonly columnTracks: ReadonlyArray<number>;
  readonly rowTracks: ReadonlyArray<number>;
  readonly boxes: ReadonlyMap<string, Box>;
  readonly wires: ReadonlyArray<PlacedWire>;
}

/**
 * A pipeline as a renderer draws it, in plain JSON: each block at its box with
 * the words on its card, and each wire as the corners of its route. It is what
 * `foreman pipeline show --json` prints, so a renderer that cannot run this
 * module, such as a herdr-app mod, draws the same picture as one that can.
 */
export interface Drawing {
  readonly flow: Flow;
  readonly width: number;
  readonly height: number;
  readonly blocks: ReadonlyArray<{
    readonly id: string;
    readonly kind: PipelineNode["kind"];
    readonly icon: string;
    readonly summary: string;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  }>;
  readonly wires: ReadonlyArray<{
    readonly from: string;
    readonly port: Port;
    readonly to: string;
    readonly label: string;
    readonly points: ReadonlyArray<Point>;
    readonly anchor: Point;
    readonly plus: Point;
  }>;
}

export const drawingOf = (pipeline: Pipeline, flow: Flow): Drawing => {
  const layout = layoutOf(beltOf(pipeline), flow);
  return {
    flow,
    width: layout.width,
    height: layout.height,
    blocks: pipeline.nodes.flatMap((node) => {
      const box = layout.boxes.get(node.id);
      return box === undefined
        ? []
        : [
            {
              id: node.id,
              kind: node.kind,
              icon: KIND_ICON[node.kind],
              summary: summaryOf(node),
              ...box,
            },
          ];
    }),
    wires: layout.wires.map(({ wire, points, anchor, plus }) => ({
      from: wire.from,
      port: wire.port,
      to: wire.to,
      label: wire.label,
      points,
      anchor,
      plus,
    })),
  };
};

export const PAD = 12;
/** The gap between two lanes, which a lane wire runs down the middle of. */
const LANE_GAP = 40;
const MIN_GAP = 34;
const STAGGER = 11;
/** How far apart a block's exits leave it when a flow runs across, enough for a label above each. */
const EXIT_SPACING = 30;
/** How deep the row of labels is that sits under a layer when the flow runs down. */
const LABEL_ROW = 20;
const LABEL_MAX = 84;
/** The '+' an editor draws on a wire, and the room it needs beside a label. */
const PLUS = 14;
const PLUS_ROOM = PLUS + 4;

/** How big a block draws before its exits widen it: gates and routers are chips, the rest are cards. */
export const sizeOf = (kind: Cell["node"]["kind"]): { readonly w: number; readonly h: number } => {
  switch (kind) {
    case "source":
      return { w: 100, h: 44 };
    case "agent":
    case "check":
    case "park":
      return { w: 114, h: 44 };
    case "land":
    case "done":
      return { w: 72, h: 44 };
    case "branch":
    case "worktree":
    case "router":
      return { w: kind === "router" ? 88 : 72, h: 28 };
    case "gate":
      return { w: 88, h: 28 };
  }
};

/** The width of a wire's label, which the gap before the next column must have room for. */
export const labelWidth = (label: string): number =>
  label === "" ? 0 : Math.min(LABEL_MAX, Math.ceil(label.length * 5.8) + 6);

/** A box in the flow's own axes: `a` runs the way work moves, `b` runs across the lanes. */
interface Span {
  readonly a: number;
  readonly b: number;
  readonly la: number;
  readonly lb: number;
}

/** A belt measured out in the flow's own axes: where each layer and lane starts and how big it is. */
interface Grid {
  readonly belt: Belt;
  readonly down: boolean;
  readonly cellOf: ReadonlyMap<string, Cell>;
  readonly laneWires: ReadonlyArray<Wire>;
  readonly spans: ReadonlyMap<string, Span>;
  readonly layerStart: ReadonlyArray<number>;
  readonly layerLength: ReadonlyArray<number>;
  readonly gap: ReadonlyArray<number>;
  readonly laneStart: ReadonlyArray<number>;
  readonly laneWidth: ReadonlyArray<number>;
  readonly laneGap: ReadonlyArray<number>;
}

/**
 * Lays a belt out in the flow's own axes and turns them into x and y at the
 * end. A belt column is a layer the work passes through, and a belt row is a
 * lane beside the others. A layer is as long as its longest block, a lane as
 * wide as its widest, and a block is wide enough for its exits to leave it
 * side by side.
 *
 * The flows differ only where labels go, because a label's text always runs
 * across the page. Across, a label sits above the level stretch that leaves
 * its block, so the gap after a layer must be as long as its widest label.
 * Down, the labels of a layer sit in one row just under it, each on its own
 * exit, so exits stand a label's width apart; a lane wire's label sits on the
 * lane, so the gap between two lanes must be as wide as the labels there.
 */
export const layoutOf = (belt: Belt, flow: Flow): Layout => {
  const grid = gridOf(belt, flow === "down");
  const { down, layerLength, gap, laneStart, laneWidth, laneGap } = grid;
  const trackOf = (sizes: ReadonlyArray<number>, gaps: ReadonlyArray<number>) =>
    sizes.flatMap((size, index) => (index < sizes.length - 1 ? [size, gaps[index]!] : [size]));
  const last = belt.rows - 1;
  const along = grid.layerStart[belt.columns - 1]! + layerLength[belt.columns - 1]! + PAD;
  const beside = (laneStart[last] ?? PAD) + (laneWidth[last] ?? 0) + (laneGap[last] ?? 0) / 2 + PAD;
  const alongTracks = trackOf(layerLength, gap);
  const besideTracks = trackOf(laneWidth, laneGap);
  return {
    width: down ? beside : along,
    height: down ? along : beside,
    columnTracks: down ? besideTracks : alongTracks,
    rowTracks: down ? alongTracks : besideTracks,
    boxes: new Map(
      [...grid.spans].map(([id, { a, b, la, lb }]) => [
        id,
        down ? { x: b, y: a, w: lb, h: la } : { x: a, y: b, w: la, h: lb },
      ]),
    ),
    wires: belt.wires.flatMap((wire, index) => placedWireOf(grid, wire, index)),
  };
};

const gridOf = (belt: Belt, down: boolean): Grid => {
  const cellOf = new Map(belt.cells.map((cell) => [cell.node.id, cell]));
  const lengths = new Map(belt.cells.map((cell) => [cell.node.id, lengthsOf(belt, cell, down)]));
  const lengthOf = (cell: Cell) => lengths.get(cell.node.id)!;
  const laneWires = belt.wires.filter((wire) => onLane(belt, cellOf, wire));

  const layerLength = Array.from({ length: belt.columns }, (_, column) =>
    Math.max(
      0,
      ...belt.cells.filter((cell) => cell.column === column).map((cell) => lengthOf(cell).la),
    ),
  );
  const laneWidth = Array.from({ length: belt.rows }, (_, row) =>
    Math.max(0, ...belt.cells.filter((cell) => cell.row === row).map((cell) => lengthOf(cell).lb)),
  );
  const laneGap = laneWidth.map((_, row) =>
    Math.max(
      LANE_GAP,
      ...(down ? laneWires : [])
        .filter((wire) => laneIndexOf(cellOf, wire) === row)
        .map((wire) => labelWidth(wire.label) + 16),
    ),
  );
  const gap = layerLength.map((_, column) =>
    down ? gapDown(belt, column, laneWires) : gapAcross(belt, column, cellOf),
  );
  const startsOf = (sizes: ReadonlyArray<number>, gaps: ReadonlyArray<number>) =>
    sizes.reduce<Array<number>>(
      (starts, size, index) => [
        ...starts,
        index === 0 ? PAD : starts[index - 1]! + sizes[index - 1]! + gaps[index - 1]!,
      ],
      [],
    );
  const layerStart = startsOf(layerLength, gap);
  const laneStart = startsOf(laneWidth, laneGap);
  const spans = new Map(
    belt.cells.map((cell): [string, Span] => {
      const { la, lb } = lengthOf(cell);
      return [
        cell.node.id,
        {
          a: layerStart[cell.column]! + (layerLength[cell.column]! - la) / 2,
          b: laneStart[cell.row]! + (laneWidth[cell.row]! - lb) / 2,
          la,
          lb,
        },
      ];
    }),
  );
  return {
    belt,
    down,
    cellOf,
    laneWires,
    spans,
    layerStart,
    layerLength,
    gap,
    laneStart,
    laneWidth,
    laneGap,
  };
};

/** A block's lengths in the flow's axes, wide enough across for each of several exits to have its slot. */
const lengthsOf = (
  belt: Belt,
  cell: Cell,
  down: boolean,
): { readonly la: number; readonly lb: number } => {
  const { w, h } = sizeOf(cell.node.kind);
  const leaving = exitsOf(belt, cell.node.id);
  const exits = leaving.length > 1 ? leaving.reduce((sum, wire) => sum + slotOf(wire, down), 0) : 0;
  return down ? { la: h, lb: Math.max(w, exits) } : { la: w, lb: Math.max(h, exits) };
};

const exitsOf = (belt: Belt, id: string) => belt.wires.filter((wire) => wire.from === id);

/**
 * The room an exit takes across its block: down, its label stands on the exit
 * with its "+" beside it, so their widths.
 */
const slotOf = (wire: Wire, down: boolean) =>
  down
    ? Math.max(EXIT_SPACING, labelWidth(wire.label) + 12 + (wire.label === "" ? 0 : PLUS_ROOM))
    : EXIT_SPACING;

/** A wire runs on a lane when a block stands in its own row between its two ends. */
const onLane = (belt: Belt, cellOf: ReadonlyMap<string, Cell>, wire: Wire) => {
  const from = cellOf.get(wire.from);
  const to = cellOf.get(wire.to);
  return (
    from !== undefined &&
    to !== undefined &&
    belt.cells.some(
      (cell) => cell.column > from.column && cell.column < to.column && cell.row === to.row,
    )
  );
};

/** The gap a lane wire runs in: the one before its row when it climbs to an earlier row, else the one after. */
const laneIndexOf = (cellOf: ReadonlyMap<string, Cell>, wire: Wire) => {
  const from = cellOf.get(wire.from)!;
  return cellOf.get(wire.to)!.row < from.row ? from.row - 1 : from.row;
};

/**
 * A wire's route from its exit to the middle of the block it enters, turning
 * just before the next layer. A lane wire turns onto its lane there instead,
 * and off it just before the layer it enters.
 */
const placedWireOf = (grid: Grid, wire: Wire, index: number): ReadonlyArray<PlacedWire> => {
  const { belt, down, cellOf, spans, layerStart, laneStart, laneWidth, laneGap } = grid;
  const from = cellOf.get(wire.from);
  const to = cellOf.get(wire.to);
  const fromSpan = spans.get(wire.from);
  const toSpan = spans.get(wire.to);
  if (from === undefined || to === undefined || fromSpan === undefined || toSpan === undefined)
    return [];
  const b0 = exitOf(grid, wire, fromSpan);
  const b1 = toSpan.b + toSpan.lb / 2;
  const out: Point = [fromSpan.a + fromSpan.la, b0];
  const into: Point = [toSpan.a, b1];
  const k = belt.wires
    .filter((other) => cellOf.get(other.from)?.column === from.column)
    .indexOf(wire);
  const a1 = layerStart[from.column + 1]! - 12 - STAGGER * (k % 4);
  const a2 = layerStart[to.column]! - 12 - STAGGER * (index % 3);
  const lane = grid.laneWires.includes(wire);
  const laneB =
    (to.row < from.row
      ? laneStart[from.row]! - laneGap[from.row - 1]! / 2
      : laneStart[from.row]! + laneWidth[from.row]! + laneGap[from.row]! / 2) +
    ((index % 3) - 1) * 5;
  const route: ReadonlyArray<Point> = lane
    ? [out, [a1, b0], [a1, laneB], [a2, laneB], [a2, b1], into]
    : [out, [a1, b0], [a1, b1], into];
  const points = dedupe(route.map(([a, b]) => (down ? [b, a] : [a, b])));
  if (!down) {
    const across = anchorOf(points);
    // Across, a label sits above its stretch, so the "+" hangs just under it.
    const [x, y] = across.anchor;
    const plus: Point = wire.label === "" ? middleOfLongest(points) : [x, y + PLUS / 2 + 2];
    return [{ wire, points, ...across, plus }];
  }
  if (lane) {
    const middle = (a1 + a2) / 2;
    return [
      {
        wire,
        points,
        anchor: [laneB, middle],
        room: laneGap[laneIndexOf(cellOf, wire)]! - 16,
        plus: [laneB, middle + (wire.label === "" ? 0 : LABEL_ROW)],
      },
    ];
  }
  const row = layerStart[from.column]! + grid.layerLength[from.column]! + LABEL_ROW / 2;
  const half = labelWidth(wire.label) / 2;
  return [
    {
      wire,
      points,
      anchor: [b0, row],
      room: labelWidth(wire.label),
      plus: [half === 0 ? b0 : b0 + half + 4 + PLUS / 2, row],
    },
  ];
};

/** Where a wire leaves its block across the flow: the middle of its slot, with the slots centred on the block. */
const exitOf = (grid: Grid, wire: Wire, span: Span): number => {
  const siblings = exitsOf(grid.belt, wire.from);
  const slots = siblings.map((other) => slotOf(other, grid.down));
  const at = siblings.findIndex((other) => other.port === wire.port);
  const sum = (sizes: ReadonlyArray<number>) => sizes.reduce((total, size) => total + size, 0);
  return span.b + (span.lb - sum(slots)) / 2 + sum(slots.slice(0, at)) + slots[at]! / 2;
};

/** Across, the gap after a layer holds the widest label of the wires that go on to a later layer. */
const gapAcross = (belt: Belt, column: number, cellOf: ReadonlyMap<string, Cell>): number => {
  const leaving = belt.wires.filter(
    (wire) =>
      cellOf.get(wire.from)?.column === column && (cellOf.get(wire.to)?.column ?? -1) > column,
  );
  return Math.max(
    MIN_GAP,
    ...leaving.map((wire) => labelWidth(wire.label) + 18 + STAGGER * (leaving.length - 1)),
  );
};

/**
 * Down, the gap after a layer holds the row of labels, then the staggered
 * turns of the wires that leave the layer and of the lane wires that enter
 * the next, so no turn runs through a label.
 */
const gapDown = (belt: Belt, column: number, laneWires: ReadonlyArray<Wire>): number => {
  const columnOf = new Map(belt.cells.map((cell) => [cell.node.id, cell.column]));
  const leaving = belt.wires.filter((wire) => columnOf.get(wire.from) === column).length;
  const entering = belt.wires.flatMap((wire, index) =>
    laneWires.includes(wire) && columnOf.get(wire.to) === column + 1 ? [index % 3] : [],
  );
  const stagger = Math.max(Math.min(leaving - 1, 3), ...entering, 0);
  return Math.max(MIN_GAP, LABEL_ROW + 16 + STAGGER * stagger);
};

const dedupe = (points: ReadonlyArray<Point>): ReadonlyArray<Point> =>
  points.filter(
    (point, index) =>
      index === 0 || point[0] !== points[index - 1]![0] || point[1] !== points[index - 1]![1],
  );

/** The label and "+" sit mid-stretch on the longest level stretch that is not the last, so two wires into one block keep apart. */
const anchorOf = (
  points: ReadonlyArray<Point>,
): { readonly anchor: Point; readonly room: number } => {
  const stretches = points.flatMap(
    (point, index): ReadonlyArray<{ readonly from: Point; readonly to: Point }> => {
      const next = points[index + 1];
      return next !== undefined && next[1] === point[1] && next[0] > point[0]
        ? [{ from: point, to: next }]
        : [];
    },
  );
  const candidates = stretches.length > 1 ? stretches.slice(0, -1) : stretches;
  const best = candidates.reduce(
    (one, other) => (other.to[0] - other.from[0] > one.to[0] - one.from[0] ? other : one),
    candidates[0] ?? { from: points[0]!, to: points[points.length - 1]! },
  );
  return {
    anchor: [(best.from[0] + best.to[0]) / 2, best.from[1]],
    room: best.to[0] - best.from[0],
  };
};

/** The middle of a route's longest segment, where a "+" has the most room. */
const middleOfLongest = (points: ReadonlyArray<Point>): Point => {
  const length = (i: number) =>
    Math.abs(points[i + 1]![0] - points[i]![0]) + Math.abs(points[i + 1]![1] - points[i]![1]);
  const longest = points
    .slice(1)
    .reduce((best, _point, i) => (length(i) > length(best) ? i : best), 0);
  const [a, b] = [points[longest]!, points[longest + 1] ?? points[longest]!];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
};

/** The room between a block and the inspector floating beside it. */
const BESIDE_GAP = 12;

/**
 * Where a panel `panelWidth` wide floats beside a block on a drawing `width`
 * wide: right of the block when it fits there, else left of it, else under
 * it, pressed against the drawing's right edge. The panel takes no width of
 * its own, so the drawing is laid out as if it were not there.
 */
export const besideOf = (box: Box, width: number, panelWidth: number): Point => {
  const right = box.x + box.w + BESIDE_GAP;
  if (right + panelWidth <= width) return [right, box.y];
  const left = box.x - BESIDE_GAP - panelWidth;
  if (left >= 0) return [left, box.y];
  return [Math.max(0, Math.min(box.x, width - panelWidth)), box.y + box.h + BESIDE_GAP];
};

/** How each kind of block is marked on its card and in the palette. */
export const KIND_ICON: Record<PipelineNode["kind"], string> = {
  source: "⇥",
  router: "⑂",
  gate: "◧",
  agent: "⚙",
  check: "✓",
  land: "⤓",
  park: "⏸",
  branch: "⎇",
  worktree: "▤",
  done: "✔",
};

/** A wire's way out in words: `next`, `else`, or `route n` counted from one. */
export const portName = (wire: Pick<Wire, "port">): string =>
  typeof wire.port === "number"
    ? `route ${wire.port + 1}`
    : wire.port.startsWith("exit:")
      ? wire.port.slice("exit:".length)
      : wire.port;

/** A block's settings in a few words, for its card. */
export const summaryOf = (node: PipelineNode): string => {
  switch (node.kind) {
    case "source":
      return node.filter === "" ? "every task" : node.filter;
    case "router":
      return node.routes.length === 1 ? "1 route" : `${node.routes.length} routes`;
    case "gate":
      return `holds for ${node.step}`;
    case "agent":
      return `${node.role} · ${node.model}${node.slots === undefined ? "" : ` ×${node.slots}`}`;
    case "check":
      return node.command === "" ? "names no command" : `runs ${node.command}`;
    case "branch":
      return "cuts foreman/<id> from trunk";
    case "worktree":
      return "a directory of its own";
    case "land":
      return node.how === "fast-forward" ? "fast-forwards" : "merges";
    case "done":
      return "completes";
    case "park":
      return "waits for you";
  }
};
