/**
 * A pipeline drawn and edited as belts: blocks in a row from left to right,
 * where a router splits the row into parallel rows that join again.
 *
 * The drawing is derived from the graph every time, so nothing about it is
 * stored. Every edit keeps every wire ending at a block, and deletes only the
 * block it names: a block an edit leaves unreached stays, so the operator can
 * wire it again or take it out. What an edit cannot guarantee (a source that
 * reaches every block, a gate before each step, a review before each land, a
 * rung the ladder has) is `problemsOf`'s to report.
 */
import { Option } from "effect";
import type { BlockSetting } from "./pipeline-edit.ts";
import {
  type AgentNode,
  type Landing,
  type Pipeline,
  type PipelineNode,
  QUEUE,
  standardExits,
} from "./pipeline.ts";

/** Where a block sits on the drawing: its column from the left and its row from the top. */
export interface Cell {
  readonly node: PipelineNode;
  readonly column: number;
  readonly row: number;
}

/**
 * One way out of a block: its `next`, its router's `else`, route `n` of its
 * router, or the exit of an agent or a check that it names. A return to the
 * queue is no wire.
 */
export type Port = "next" | "else" | number | `exit:${string}`;

export interface Wire {
  readonly from: string;
  readonly port: Port;
  readonly to: string;
  /** The route's filter, `else`, the exit's name, or empty for a block's one way out. */
  readonly label: string;
}

export interface Belt {
  readonly cells: ReadonlyArray<Cell>;
  readonly wires: ReadonlyArray<Wire>;
  readonly columns: number;
  readonly rows: number;
}

/**
 * The pipeline laid out as belts.
 *
 * A block's column is the longest route to it from a source, so a block every
 * branch must pass stands right of all of them. Rows follow the walk from each
 * source: `next`, `else` and a block's first exit stay on the row they came
 * from and are walked first, and a route or a later exit to a block not yet
 * drawn, or a later source, opens a row below. A join keeps the row it was first
 * reached on.
 */
export const beltOf = (pipeline: Pipeline): Belt => {
  const nodes = new Map(pipeline.nodes.map((node) => [node.id, node]));
  const wires = wiresOf(pipeline);
  const into = forwardInputsOf(
    wires,
    pipeline.nodes.filter((node) => node.kind === "source").map((node) => node.id),
  );

  const columns = new Map<string, number>();
  const columnOf = (id: string): number => {
    const known = columns.get(id);
    if (known !== undefined) return known;
    const before = (into.get(id) ?? []).filter((from) => nodes.has(from));
    const column = before.length === 0 ? 0 : Math.max(...before.map((from) => columnOf(from))) + 1;
    columns.set(id, column);
    return column;
  };

  const rows = new Map<string, number>();
  let nextRow = 0;
  const walk = (id: string, row: number) => {
    if (!nodes.has(id) || rows.has(id)) return;
    rows.set(id, row);
    const out = wires.filter((wire) => wire.from === id);
    // The belt goes on first, so a branch never takes the main row.
    const [main, ...branches] = [
      ...out.filter((wire) => typeof wire.port !== "number"),
      ...out.filter((wire) => typeof wire.port === "number"),
    ];
    if (main !== undefined) walk(main.to, row);
    for (const wire of branches) {
      if (!rows.has(wire.to)) walk(wire.to, nextRow++);
    }
  };
  for (const node of pipeline.nodes) {
    if (node.kind === "source") walk(node.id, nextRow++);
  }
  // Blocks no source reaches still draw, below the rest, so the operator can see what to rewire.
  for (const node of pipeline.nodes) {
    if (!rows.has(node.id)) walk(node.id, nextRow++);
  }

  const cells = pipeline.nodes.map((node) => ({
    node,
    column: columnOf(node.id),
    row: rows.get(node.id) ?? 0,
  }));
  return {
    cells,
    wires,
    columns: Math.max(0, ...cells.map((cell) => cell.column + 1)),
    rows: nextRow,
  };
};

/** The kinds of block an operator puts on a wire. */
export const INSERTABLE = ["branch", "worktree", "gate", "agent", "check", "router"] as const;
export type Insertable = (typeof INSERTABLE)[number];

/**
 * Puts a new block on a wire: the wire runs into it, and it runs on to where
 * the wire went. Answers the pipeline and the new block's id.
 *
 * A new router sends everything to `else` until a route is added; a new agent
 * authors from the ladder; a new gate holds for `author`; a new check names no
 * command, which validation reports until the operator names one. A branch
 * or a worktree has nothing to set. The operator sets each one after.
 */
export const insertOn = (
  pipeline: Pipeline,
  wire: Pick<Wire, "from" | "port">,
  kind: Insertable,
): { readonly pipeline: Pipeline; readonly id: string } => {
  const target = targetOf(pipeline, wire);
  if (target === undefined) return { pipeline, id: "" };
  const id = freshId(pipeline, kind);
  const block: PipelineNode =
    kind === "gate"
      ? { kind, id, step: "author", next: target }
      : kind === "agent"
        ? {
            kind,
            id,
            role: "author",
            model: "ladder",
            exits: standardExits({ kind, role: "author" }, target),
          }
        : kind === "check"
          ? { kind, id, command: "", exits: standardExits({ kind }, target) }
          : kind === "router"
            ? { kind, id, routes: [], else: target }
            : { kind, id, next: target };
  const rewired = retargeted(pipeline, wire, id);
  return { pipeline: { nodes: [...rewired.nodes, block] }, id };
};

/**
 * Takes a block out, and no other. The wires into it run on to where it went:
 * a router's `else`, an agent's or a check's first exit that does not return
 * the task, or a block's `next`. An end (land, done or park) goes only when no
 * wire enters it, since a wire must end at a block; turn one into another
 * instead. The blocks only this one reached stay, and `problemsOf` names them.
 */
export const remove = (pipeline: Pipeline, id: string): Pipeline => {
  const node = pipeline.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) return pipeline;
  const others = pipeline.nodes.filter((candidate) => candidate.id !== id);
  const onward = onwardOf(node);
  if (onward !== undefined) return { nodes: others.map((other) => redirect(other, id, onward)) };
  return wiresOf(pipeline).some((wire) => wire.to === id) ? pipeline : { nodes: others };
};

/** Adds a route to a router. It joins `else` at once, until blocks are put on it. */
export const addRoute = (pipeline: Pipeline, router: string, when: string): Pipeline =>
  mapNode(pipeline, router, (node) =>
    node.kind === "router" ? { ...node, routes: [...node.routes, { when, to: node.else }] } : node,
  );

/** Drops route `index` of a router. The blocks only it reached stay. */
export const removeRoute = (pipeline: Pipeline, router: string, index: number): Pipeline =>
  mapNode(pipeline, router, (node) =>
    node.kind === "router"
      ? { ...node, routes: node.routes.filter((_, at) => at !== index) }
      : node,
  );

/**
 * Points a wire at another block. Refused (none) when the new wire closes a
 * cycle among forward wires. Existing cycle-closing returns stay in place
 * without preventing joins between unrelated branches.
 */
export const rejoin = (
  pipeline: Pipeline,
  wire: Pick<Wire, "from" | "port">,
  to: string,
): Option.Option<Pipeline> => {
  const into = forwardInputsOf(
    wiresOf(pipeline),
    pipeline.nodes.filter((node) => node.kind === "source").map((node) => node.id),
  );
  const seen = new Set<string>();
  const reaches = (id: string): boolean => {
    if (id === to) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (into.get(id) ?? []).some(reaches);
  };
  return pipeline.nodes.some((node) => node.id === wire.from) &&
    pipeline.nodes.some((node) => node.id === to) &&
    !reaches(wire.from)
    ? Option.some(retargeted(pipeline, wire, to))
    : Option.none();
};

/** Starts a new belt: a source with this filter that joins the first source's belt. */
export const addSource = (
  pipeline: Pipeline,
  filter: string,
): { readonly pipeline: Pipeline; readonly id: string } => {
  const first = pipeline.nodes.find((node) => node.kind === "source");
  const next = first?.kind === "source" ? first.next : pipeline.nodes[0]?.id;
  if (next === undefined) return { pipeline, id: "" };
  const id = freshId(pipeline, "source");
  return { pipeline: { nodes: [...pipeline.nodes, { kind: "source", id, filter, next }] }, id };
};

/**
 * Turns one end of a route into another, keeping its id and the wires into it:
 * a land into a done, a done into a park, a park into a land.
 */
export const swapEnd = (pipeline: Pipeline, id: string): Pipeline =>
  mapNode(pipeline, id, (node) =>
    node.kind === "land"
      ? { kind: "done", id }
      : node.kind === "done"
        ? { kind: "park", id }
        : node.kind === "park"
          ? { kind: "land", id }
          : node,
  );

/**
 * Changes what a block does, never where it is wired or what it is called:
 * the id is what a task's facts name, and the wires are the belt's to change.
 */
export const configure = (pipeline: Pipeline, id: string, setting: BlockSetting): Pipeline =>
  mapNode(pipeline, id, (node) => settled(node, setting));

/** A block with `setting` applied, or as it was when the setting is for another kind of block. */
const settled = (node: PipelineNode, setting: BlockSetting): PipelineNode => {
  switch (setting.kind) {
    case "source":
      return node.kind === "source" ? { ...node, filter: setting.filter } : node;
    case "gate":
      return node.kind === "gate" ? { ...node, step: setting.step } : node;
    case "check":
      return node.kind === "check" ? { ...node, command: setting.command } : node;
    case "land":
      return node.kind === "land" ? { ...node, how: setting.how } : node;
    case "agent": {
      if (node.kind !== "agent") return node;
      const { slots: _slots, ...rest } = node;
      return {
        ...rest,
        role: setting.role,
        model: setting.model,
        ...(setting.slots === undefined ? {} : { slots: setting.slots }),
      };
    }
    case "router":
      return node.kind === "router"
        ? {
            ...node,
            routes: node.routes.map((route, at) =>
              at === setting.route ? { ...route, when: setting.when } : route,
            ),
          }
        : node;
  }
};

/** Incoming wires after excluding edges that close a walk from a source. */
const forwardInputsOf = (wires: ReadonlyArray<Wire>, sources: ReadonlyArray<string>) => {
  const into = new Map<string, Array<string>>();
  const visited = new Set<string>();
  const visit = (id: string, path: ReadonlySet<string>) => {
    if (visited.has(id)) return;
    visited.add(id);
    const nextPath = new Set([...path, id]);
    for (const wire of wires.filter((candidate) => candidate.from === id)) {
      // A wire back into this path closes a cycle. Draw it, but let the
      // source's forward routes determine the columns of the blocks it joins.
      if (nextPath.has(wire.to)) continue;
      into.set(wire.to, [...(into.get(wire.to) ?? []), wire.from]);
      visit(wire.to, nextPath);
    }
  };
  for (const id of sources) visit(id, new Set());
  for (const wire of wires) visit(wire.from, new Set());

  return into;
};

const wiresOf = (pipeline: Pipeline): ReadonlyArray<Wire> =>
  pipeline.nodes.flatMap((node): ReadonlyArray<Wire> => {
    switch (node.kind) {
      case "source":
      case "gate":
      case "branch":
      case "worktree":
        return [{ from: node.id, port: "next", to: node.next, label: "" }];
      case "agent":
      case "check":
        return node.exits.flatMap((exit): ReadonlyArray<Wire> =>
          exit.to === QUEUE
            ? []
            : [{ from: node.id, port: `exit:${exit.name}`, to: exit.to, label: exit.name }],
        );
      case "router":
        return [
          ...node.routes.map((route, at) => ({
            from: node.id,
            port: at,
            to: route.to,
            label: route.when,
          })),
          { from: node.id, port: "else" as const, to: node.else, label: "else" },
        ];
      case "land":
      case "done":
      case "park":
        return [];
    }
  });

const targetOf = (pipeline: Pipeline, wire: Pick<Wire, "from" | "port">): string | undefined =>
  wiresOf(pipeline).find(
    (candidate) => candidate.from === wire.from && candidate.port === wire.port,
  )?.to;

const retargeted = (pipeline: Pipeline, wire: Pick<Wire, "from" | "port">, to: string): Pipeline =>
  mapNode(pipeline, wire.from, (node) => {
    if (wire.port === "next" && "next" in node) return { ...node, next: to };
    if (wire.port === "else" && node.kind === "router") return { ...node, else: to };
    if (typeof wire.port === "string" && wire.port.startsWith("exit:") && "exits" in node) {
      const name = wire.port.slice("exit:".length);
      return {
        ...node,
        exits: node.exits.map((exit) => (exit.name === name ? { ...exit, to } : exit)),
      };
    }
    if (typeof wire.port === "number" && node.kind === "router") {
      return {
        ...node,
        routes: node.routes.map((route, at) => (at === wire.port ? { ...route, to } : route)),
      };
    }
    return node;
  });

/** Every wire of `node` that ran to `from` now runs to `to`. */
const redirect = (node: PipelineNode, from: string, to: string): PipelineNode => {
  const swap = (id: string) => (id === from ? to : id);
  switch (node.kind) {
    case "source":
    case "gate":
    case "branch":
    case "worktree":
      return { ...node, next: swap(node.next) };
    case "agent":
    case "check":
      return { ...node, exits: node.exits.map((exit) => ({ ...exit, to: swap(exit.to) })) };
    case "router":
      return {
        ...node,
        routes: node.routes.map((route) => ({ ...route, to: swap(route.to) })),
        else: swap(node.else),
      };
    case "land":
    case "done":
    case "park":
      return node;
  }
};

const mapNode = (
  pipeline: Pipeline,
  id: string,
  change: (node: PipelineNode) => PipelineNode,
): Pipeline => ({
  nodes: pipeline.nodes.map((node) => (node.id === id ? change(node) : node)),
});

/**
 * A new `<kind>-<hex>` id. Random rather than counted, because a counted id
 * would come back after its block was deleted, and a task's facts about the
 * old block would place it at the new one.
 */
const freshId = (pipeline: Pipeline, kind: string): string => {
  const taken = new Set(pipeline.nodes.map((node) => node.id));
  for (;;) {
    const id = `${kind}-${crypto.randomUUID().slice(0, 6)}`;
    if (!taken.has(id)) return id;
  }
};

/** Where the wires into a block run once it is taken out, or nothing for a block that cannot go. */
const onwardOf = (node: PipelineNode): string | undefined => {
  switch (node.kind) {
    case "router":
      return node.else;
    case "agent":
    case "check":
      return node.exits.find((exit) => exit.to !== QUEUE)?.to;
    case "land":
    case "done":
    case "park":
      return undefined;
    default:
      return node.next;
  }
};
