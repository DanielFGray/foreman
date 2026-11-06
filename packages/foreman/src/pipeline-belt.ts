/**
 * A pipeline drawn and edited as belts: blocks in a row from left to right,
 * where a router splits the row into parallel rows that join again.
 *
 * The drawing is derived from the graph every time, so nothing about it is
 * stored. Every edit keeps every wire ending at a block, and deletes only the
 * block it names, or a publish gate that a land's `how` does not need
 * (`configure`): a block an edit leaves unreached stays, so the operator can
 * wire it again or take it out. What an edit cannot guarantee (a source that
 * reaches every block, a gate before each step, a review before each land, a
 * rung the ladder has) is `problemsOf`'s to report.
 */
import { Option } from "effect";
import type { BlockSetting } from "./pipeline-edit.ts";
import {
  type DrawnNode,
  type Drawing,
  engineOf,
  type Exit,
  PULL_REQUEST_STEPS,
  pullRequestLands,
  QUEUE,
  routesWithoutGate,
  standardExits,
  strandedPublishGates,
} from "./pipeline.ts";
import type { Step } from "./policy.ts";

/** Where a block sits on the drawing: its column from the left and its row from the top. */
export interface Cell {
  readonly node: DrawnNode;
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

/**
 * A wire as the belt draws it. A back wire closes a loop, so it runs against
 * the flow (`backWiresOf`).
 */
export interface BeltWire extends Wire {
  readonly back: boolean;
}

export interface Belt {
  readonly cells: ReadonlyArray<Cell>;
  readonly wires: ReadonlyArray<BeltWire>;
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
export const beltOf = (pipeline: Drawing): Belt => {
  const nodes = new Map(pipeline.nodes.map((node) => [node.id, node]));
  const wires = wiresOf(pipeline);
  const backs = backWiresOf(pipeline, wires);

  const columns = new Map<string, number>();
  const columnOf = (id: string): number => {
    const known = columns.get(id);
    if (known !== undefined) return known;
    const before = wires
      .filter((wire) => wire.to === id && !backs.has(wire) && nodes.has(wire.from))
      .map((wire) => wire.from);
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
    wires: wires.map((wire) => ({
      ...wire,
      back: backs.has(wire),
    })),
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
  pipeline: Drawing,
  wire: Pick<Wire, "from" | "port">,
  kind: Insertable,
): { readonly pipeline: Drawing; readonly id: string } => {
  const target = targetOf(pipeline, wire);
  if (target === undefined) return { pipeline, id: "" };
  const id = freshId(pipeline, kind);
  const block: DrawnNode =
    kind === "gate"
      ? { kind, id, step: "author", next: target }
      : kind === "agent"
        ? {
            kind,
            id,
            role: "author",
            model: "ladder",
            exits: freshExits(pipeline, standardExits({ kind, role: "author" }, target)),
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
export const remove = (pipeline: Drawing, id: string): Drawing => {
  const node = pipeline.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) return pipeline;
  const others = pipeline.nodes.filter((candidate) => candidate.id !== id);
  const onward = onwardOf(node);
  if (onward !== undefined) return { nodes: others.map((other) => redirect(other, id, onward)) };
  return wiresOf(pipeline).some((wire) => wire.to === id) ? pipeline : { nodes: others };
};

/** Adds a route to a router. It joins `else` at once, until blocks are put on it. */
export const addRoute = (pipeline: Drawing, router: string, when: string): Drawing =>
  mapNode(pipeline, router, (node) =>
    node.kind === "router" ? { ...node, routes: [...node.routes, { when, to: node.else }] } : node,
  );

/** Drops route `index` of a router. The blocks only it reached stay. */
export const removeRoute = (pipeline: Drawing, router: string, index: number): Drawing =>
  mapNode(pipeline, router, (node) =>
    node.kind === "router"
      ? { ...node, routes: node.routes.filter((_, at) => at !== index) }
      : node,
  );

/**
 * Points a wire at another block, which may stand before it: a wire that
 * closes a loop is drawn as a back wire, and `problemsOf` reports a loop that
 * nothing ends. An exit may also lead to `queue`, a return. Refused (none)
 * when either block is not in the pipeline.
 */
export const rejoin = (
  pipeline: Drawing,
  wire: Pick<Wire, "from" | "port">,
  to: string,
): Option.Option<Drawing> =>
  pipeline.nodes.some((node) => node.id === wire.from) &&
  (pipeline.nodes.some((node) => node.id === to) ||
    (to === QUEUE && typeof wire.port === "string" && wire.port.startsWith("exit:")))
    ? Option.some(retargeted(pipeline, wire, to))
    : Option.none();

/** Starts a new belt: a source with this filter that joins the first source's belt. */
export const addSource = (
  pipeline: Drawing,
  filter: string,
): { readonly pipeline: Drawing; readonly id: string } => {
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
export const swapEnd = (pipeline: Drawing, id: string): Drawing =>
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
 * Adds an exit named `name` to an agent, leading where its first exit leads,
 * or back to the queue when it has none, with a fresh id. The operator rewires
 * it after.
 */
export const addExit = (pipeline: Drawing, id: string, name: string): Drawing =>
  mapExits(pipeline, id, (exits) => [
    ...exits,
    { id: freshExitId(pipeline), name, to: exits[0]?.to ?? QUEUE },
  ]);

/**
 * Renames an exit, keeping its id and where it leads, so a task whose last
 * exit it was stays where it is. A filter that names the exit by its old name
 * names the new one, unless another exit in the pipeline still has the old
 * name, since a filter counts exits by name across every block.
 */
export const renameExit = (pipeline: Drawing, id: string, name: string, to: string): Drawing => {
  const named = (candidate: Drawing) =>
    candidate.nodes.flatMap((node) =>
      node.kind === "agent" || node.kind === "check"
        ? node.exits.filter((exit) => exit.name === name).map(() => node.id)
        : [],
    );
  if (!named(pipeline).includes(id)) return pipeline;
  const renamed = mapExits(pipeline, id, (exits) =>
    exits.map((exit) => (exit.name === name ? { ...exit, name: to } : exit)),
  );
  if (named(renamed).length > 0) return renamed;
  const filter = (text: string) => renamedInFilter(text, name, to);
  return {
    nodes: renamed.nodes.map((node) =>
      node.kind === "source"
        ? { ...node, filter: filter(node.filter) }
        : node.kind === "router"
          ? {
              ...node,
              routes: node.routes.map((route) => ({ ...route, when: filter(route.when) })),
            }
          : node,
    ),
  };
};

/**
 * Marks an author's exit as its claim (`empty: claim`), or unmarks it. An
 * author has one claim, so marking one unmarks the block's others.
 */
export const setEmpty = (
  pipeline: Drawing,
  id: string,
  name: string,
  empty: Exit["empty"],
): Drawing =>
  mapExits(pipeline, id, (exits) =>
    exits.map((exit) => {
      const { empty: _empty, ...rest } = exit;
      if (exit.name === name) return empty === undefined ? rest : { ...rest, empty };
      return empty === undefined ? exit : rest;
    }),
  );

/** Drops an exit. The blocks only it reached stay, as with a dropped route. */
export const removeExit = (pipeline: Drawing, id: string, name: string): Drawing =>
  mapExits(pipeline, id, (exits) => exits.filter((exit) => exit.name !== name));

/** Sets which rung an exit charges with failing the task, or none. */
export const chargeExit = (
  pipeline: Drawing,
  id: string,
  name: string,
  fails: Exit["fails"],
): Drawing =>
  mapExits(pipeline, id, (exits) =>
    exits.map((exit) => {
      if (exit.name !== name) return exit;
      const { fails: _fails, ...rest } = exit;
      return fails === undefined ? rest : { ...rest, fails };
    }),
  );
/**
 * Changes what a block does, never what it is called: the id is what a task's
 * facts name. It rewires nothing, except that a land's `how` brings the gates
 * that landing needs (`landingGated`).
 */
export const configure = (pipeline: Drawing, id: string, setting: BlockSetting): Drawing => {
  const configured = mapNode(pipeline, id, (node) => settled(node, setting));
  return setting.kind === "land" ? landingGated(pipeline, configured, id) : configured;
};

/**
 * `after`, a change of land `id` in `before`, with the gates its landing needs.
 * A pull-request land takes a gate of each of its steps on every route to it,
 * so each one a route lacks is put directly before the land. A publish gate
 * that reached a pull-request land before the change and reaches none after it
 * is taken out, since it holds a step that never comes.
 */
const landingGated = (before: Drawing, after: Drawing, id: string): Drawing => {
  const stranded = new Set(strandedPublishGates(engineOf(before)).map((gate) => gate.id));
  const kept = strandedPublishGates(engineOf(after))
    .filter((gate) => !stranded.has(gate.id))
    .reduce((pipeline, gate) => remove(pipeline, gate.id), after);
  const land = pullRequestLands(engineOf(kept)).filter((node) => node.id === id);
  return PULL_REQUEST_STEPS.filter(
    (step) => routesWithoutGate(engineOf(kept), step, land).length > 0,
  ).reduce((pipeline, step) => gatedBefore(pipeline, id, step), kept);
};

/**
 * Puts a gate of `step` directly before block `id`: every wire into the block
 * leads into the gate. The gate is `<step>-gate`, as the standard pipelines
 * name it, unless the pipeline already has a block of that id.
 */
const gatedBefore = (pipeline: Drawing, id: string, step: Step): Drawing => {
  const named = `${step}-gate`;
  const gate = pipeline.nodes.some((node) => node.id === named) ? freshId(pipeline, named) : named;
  return {
    nodes: [
      ...pipeline.nodes.map((node) => redirect(node, id, gate)),
      { kind: "gate", id: gate, step, next: id },
    ],
  };
};

/** A block with `setting` applied, or as it was when the setting is for another kind of block. */
const settled = (node: DrawnNode, setting: BlockSetting): DrawnNode => {
  switch (setting.kind) {
    case "source":
      return node.kind === "source" ? { ...node, filter: setting.filter } : node;
    case "gate":
      return node.kind === "gate" ? { ...node, step: setting.step } : node;
    case "check":
      return node.kind === "check" ? { ...node, command: setting.command } : node;
    case "land":
      return node.kind === "land" ? { ...node, how: setting.how, onto: setting.onto } : node;
    case "agent": {
      if (node.kind !== "agent") return node;
      const { slots: _slots, ...rest } = node;
      return {
        ...rest,
        role: setting.role,
        model: setting.model,
        // Only an author claims trunk already does the task.
        exits:
          setting.role === "author"
            ? node.exits
            : node.exits.map(({ empty: _empty, ...exit }) => exit),
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

/**
 * The wires that run back up the belt. A wire is back when it closes a loop
 * (the block it enters reaches the block it leaves) and leads no farther from
 * the sources than where it starts. Every loop has such a wire, so the others
 * run forward without a loop, and the operator's return to an earlier block is
 * the one drawn back, whatever order the blocks are listed in.
 */
const backWiresOf = (pipeline: Drawing, wires: ReadonlyArray<Wire>): ReadonlySet<Wire> => {
  const depth = depthsOf(pipeline, wires);
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from]);
    const queue = [from];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (id === to) return true;
      for (const wire of wires) {
        if (wire.from === id && !seen.has(wire.to)) {
          seen.add(wire.to);
          queue.push(wire.to);
        }
      }
    }
    return false;
  };
  return new Set(
    wires.filter(
      (wire) =>
        (depth.get(wire.to) ?? 0) <= (depth.get(wire.from) ?? 0) && reaches(wire.to, wire.from),
    ),
  );
};

/**
 * Each block's distance in wires from the nearest source. A block no source
 * reaches counts from itself, or from the first such block before it that
 * reaches it.
 */
const depthsOf = (pipeline: Drawing, wires: ReadonlyArray<Wire>): ReadonlyMap<string, number> => {
  const depth = new Map<string, number>();
  const spread = (roots: ReadonlyArray<string>) => {
    let layer = roots.filter((id) => !depth.has(id));
    for (let at = 0; layer.length > 0; at++) {
      for (const id of layer) depth.set(id, at);
      const next = wires.filter((wire) => layer.includes(wire.from)).map((wire) => wire.to);
      layer = [...new Set(next)].filter((id) => !depth.has(id));
    }
  };
  spread(pipeline.nodes.filter((node) => node.kind === "source").map((node) => node.id));
  for (const node of pipeline.nodes) spread([node.id]);
  return depth;
};

const wiresOf = (pipeline: Drawing): ReadonlyArray<Wire> =>
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
      case "composite":
        return node.exits.flatMap((exit): ReadonlyArray<Wire> =>
          exit.to === QUEUE
            ? []
            : [{ from: node.id, port: `exit:${exit.id}`, to: exit.to, label: exit.id }],
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

const targetOf = (pipeline: Drawing, wire: Pick<Wire, "from" | "port">): string | undefined =>
  wiresOf(pipeline).find(
    (candidate) => candidate.from === wire.from && candidate.port === wire.port,
  )?.to;

const retargeted = (pipeline: Drawing, wire: Pick<Wire, "from" | "port">, to: string): Drawing =>
  mapNode(pipeline, wire.from, (node): DrawnNode => {
    if (wire.port === "next" && "next" in node) return { ...node, next: to };
    if (wire.port === "else" && node.kind === "router") return { ...node, else: to };
    if (typeof wire.port === "string" && wire.port.startsWith("exit:")) {
      const name = wire.port.slice("exit:".length);
      if (node.kind === "agent" || node.kind === "check") {
        return {
          ...node,
          exits: node.exits.map((exit) => (exit.name === name ? { ...exit, to } : exit)),
        };
      }
      if (node.kind === "composite") {
        return {
          ...node,
          exits: node.exits.map((exit) => (exit.id === name ? { ...exit, to } : exit)),
        };
      }
    }
    if (typeof wire.port === "number" && node.kind === "router") {
      return {
        ...node,
        routes: node.routes.map((route, at) => (at === wire.port ? { ...route, to } : route)),
      };
    }
    return node;
  });

/** Retargets every wire of `node` that ran to `from` so it runs to `to`. */
const redirect = (node: DrawnNode, from: string, to: string): DrawnNode => {
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
    case "composite":
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
  pipeline: Drawing,
  id: string,
  change: (node: DrawnNode) => DrawnNode,
): Drawing => ({
  nodes: pipeline.nodes.map((node) => (node.id === id ? change(node) : node)),
});

const mapExits = (
  pipeline: Drawing,
  id: string,
  change: (exits: ReadonlyArray<Exit>) => ReadonlyArray<Exit>,
): Drawing =>
  mapNode(pipeline, id, (node) =>
    node.kind === "agent" || node.kind === "check" ? { ...node, exits: change(node.exits) } : node,
  );

/**
 * A new `exit-<letters>` id that no exit in the pipeline has. Random for the
 * reason a block's id is: a counted or derived id would come back after its
 * exit was removed, and a task that named the old exit would be placed at the
 * new one. Letters only, because a run stores the id as its ending, and the
 * store reads an ending in the form of an exit name (`EXIT_NAME`) as an exit.
 */
const freshExitId = (pipeline: Drawing, also: ReadonlyArray<string> = []): string => {
  const taken = new Set([
    ...also,
    ...pipeline.nodes.flatMap((node) =>
      node.kind === "agent" || node.kind === "check" ? node.exits.map((exit) => exit.id) : [],
    ),
  ]);
  for (;;) {
    const letters = Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) =>
      String.fromCharCode(97 + (byte % 26)),
    ).join("");
    const id = `exit-${letters}`;
    if (!taken.has(id)) return id;
  }
};

/** `exits` with a fresh id each, distinct from each other and from the pipeline's. */
const freshExits = (pipeline: Drawing, exits: ReadonlyArray<Exit>): ReadonlyArray<Exit> =>
  exits.reduce<ReadonlyArray<Exit>>(
    (given, exit) => [
      ...given,
      {
        ...exit,
        id: freshExitId(
          pipeline,
          given.map((one) => one.id),
        ),
      },
    ],
    [],
  );

/**
 * A filter with each `exit:` and `exits:` term that names exit `from` naming
 * `to` instead, its spacing kept.
 */
const renamedInFilter = (filter: string, from: string, to: string): string =>
  filter
    .split(/(\s+)/)
    .map((word) => {
      const term = /^(-?exits?:)([a-z-]+)(.*)$/.exec(word);
      return term !== null && term[2] === from ? `${term[1]}${to}${term[3]}` : word;
    })
    .join("");

/**
 * A new `<kind>-<hex>` id. Random rather than counted, because a counted id
 * would come back after its block was deleted, and a task's facts about the
 * old block would place it at the new one.
 */
const freshId = (pipeline: Drawing, kind: string): string => {
  const taken = new Set(pipeline.nodes.map((node) => node.id));
  for (;;) {
    const id = `${kind}-${crypto.randomUUID().slice(0, 6)}`;
    if (!taken.has(id)) return id;
  }
};

/** Where the wires into a block run once it is taken out, or nothing for a block that cannot go. */
const onwardOf = (node: DrawnNode): string | undefined => {
  switch (node.kind) {
    case "router":
      return node.else;
    case "agent":
    case "check":
      return node.exits.find((exit) => exit.to !== QUEUE)?.to;
    case "composite":
      return node.exits.find((exit) => exit.to !== QUEUE)?.to;
    case "land":
    case "done":
    case "park":
      return undefined;
    default:
      return node.next;
  }
};
