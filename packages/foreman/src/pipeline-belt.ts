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
import { expand, PARAM_FIELDS, unpackInstance } from "./composite.ts";
import type { BlockSetting } from "./pipeline-edit.ts";
import {
  AgentNode,
  type CompositeDefinition,
  type CompositeEntry,
  type Composites,
  type DrawnNode,
  type Drawing,
  type Exit,
  LANDINGS,
  type ParamValue,
  type Pipeline,
  PULL_REQUEST_STEPS,
  pullRequestLands,
  QUEUE,
  routesWithoutGate,
  standardExits,
  strandedPublishGates,
} from "./pipeline.ts";
import { STEPS, type Step } from "./policy.ts";

export { PARAM_FIELDS };

/** A wire inside a definition that leaves by an exit. */
const OUT = "out:";

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
  /** The entry id of a wire into a composite instance that names one; absent for the default entry and for every other block. */
  readonly entry?: string;
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
  // A wire to `<instance>/<entry id>` ends at the instance's block; `entry` keeps which way in.
  const wires = wiresOf(pipeline).map((wire): Wire => {
    const block = blockOf(wire.to);
    return block === wire.to
      ? wire
      : { ...wire, to: block, entry: wire.to.slice(block.length + 1) };
  });
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
export const INSERTABLE = [
  "branch",
  "worktree",
  "gate",
  "agent",
  "check",
  "router",
  "composite",
] as const;
export type Insertable = (typeof INSERTABLE)[number];

/**
 * What an editor that cannot load foreman's modules offers for a block's
 * settings, read from the schemas. `composite` is not a bare choice: a
 * composite is inserted by naming its definition (`composites`).
 */
export const choicesOf = (composites: Composites) => ({
  insertable: INSERTABLE.filter((kind) => kind !== "composite"),
  composites: Object.keys(composites).sort(),
  steps: STEPS,
  roles: AgentNode.fields.role.literals,
  landings: LANDINGS,
});

/**
 * Puts a new block on a wire: the wire runs into it, and it runs on to where
 * the wire went. Answers the pipeline and the new block's id.
 *
 * A new router sends everything to `else` until a route is added; a new agent
 * authors from the ladder; a new gate holds for `author`; a new check names no
 * command, which validation reports until the operator names one. A branch
 * or a worktree has nothing to set. A composite instance names its definition
 * (`of`); its first exit takes the wire's old target and its prefix is
 * `<id>.` (`docs/composite-blocks.md`). The operator sets each one after.
 */
export const insertOn = (
  pipeline: Drawing,
  wire: Pick<Wire, "from" | "port">,
  kind: Insertable,
  of?: string,
  composites: Composites = {},
): { readonly pipeline: Drawing; readonly id: string } => {
  const target = targetOf(pipeline, wire);
  if (target === undefined) return { pipeline, id: "" };
  if (kind === "composite") {
    if (of === undefined) return { pipeline, id: "" };
    const definition = composites[of];
    if (definition === undefined) return { pipeline, id: "" };
    const id = freshId(pipeline, of);
    const block: DrawnNode = {
      kind: "composite",
      id,
      of,
      prefix: `${id}.`,
      set: {},
      exits: definition.exits.map((exit, at) => ({
        id: exit.id,
        to: at === 0 ? target : QUEUE,
      })),
    };
    const rewired = retargeted(pipeline, wire, id);
    return { pipeline: { nodes: [...rewired.nodes, block] }, id };
  }
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
 * Saves the selected blocks as a new composite definition and replaces them
 * with one instance whose prefix is `""`, so the blocks keep their ids
 * (`docs/composite-blocks.md`).
 *
 * Each distinct target a wire from outside reaches becomes one entry, named by
 * that target, in the order the wires appear. `reaches` maps each such target
 * to the wire target that now leads to its entry: the instance's id for the
 * first entry, `<id>/<entry id>` for the others.
 *
 * Refused when the selection holds a source, names a missing block, or no wire
 * enters it.
 *
 * `definitionEntries` are the entries of the definition being drawn, when the
 * drawing is one. Nothing in the drawing wires into their blocks, so the
 * selection's entries are counted from them first.
 */
export const makeComposite = (
  pipeline: Drawing,
  ids: ReadonlyArray<string>,
  name: string,
  composites: Composites = {},
  definitionEntries: ReadonlyArray<CompositeEntry> = [],
):
  | {
      readonly _tag: "Made";
      readonly pipeline: Drawing;
      readonly definition: CompositeDefinition;
      readonly id: string;
      readonly reaches: ReadonlyMap<string, string>;
    }
  | { readonly _tag: "Refused"; readonly reason: string } => {
  if (ids.length === 0)
    return { _tag: "Refused", reason: "MakeComposite needs at least one block" };
  const selected = new Set(ids);
  if (selected.size !== ids.length) {
    return { _tag: "Refused", reason: "MakeComposite names a block more than once" };
  }
  const selectedNodes = pipeline.nodes.filter((node) => selected.has(node.id));
  if (selectedNodes.length !== selected.size) {
    const missing = ids.find((id) => !pipeline.nodes.some((node) => node.id === id));
    return { _tag: "Refused", reason: `${missing} is not in the pipeline` };
  }
  if (selectedNodes.some((node) => node.kind === "source")) {
    return { _tag: "Refused", reason: "a composite definition holds no source" };
  }

  const wires = wiresOf(pipeline);
  const entering = [
    ...new Set([
      ...definitionEntries
        .filter((entry) => selected.has(blockOf(entry.block)))
        .map((entry) => entry.block),
      ...wires
        .filter((wire) => selected.has(blockOf(wire.to)) && !selected.has(wire.from))
        .map((wire) => wire.to),
    ]),
  ];
  if (entering.length === 0) {
    return { _tag: "Refused", reason: "no wire enters the selection" };
  }
  const entries: Array<CompositeEntry> = [];
  for (const target of entering) {
    const name = target.replace("/", "-");
    let id = `entry-${name}`;
    for (let n = 2; entries.some((one) => one.id === id); n++) id = `entry-${name}-${n}`;
    entries.push({ id, name, block: target });
  }

  // The first wire out to each outside block names its exit, in drawing order.
  const exits: Array<{ id: string; name: string; to: string }> = [];
  const takenExitIds = new Set<string>();
  for (const wire of wires) {
    if (!selected.has(wire.from) || selected.has(blockOf(wire.to))) continue;
    if (exits.some((exit) => exit.to === wire.to)) continue;
    const source = selectedNodes.find((node) => node.id === wire.from);
    const exitName = exitNameOf(source, wire.to, composites) ?? wire.to;
    let exitId = `exit-${exitName}`;
    if (takenExitIds.has(exitId)) {
      exitId = freshExitId(pipeline, [...takenExitIds]);
    }
    takenExitIds.add(exitId);
    exits.push({ id: exitId, name: exitName, to: wire.to });
  }
  const outOf = new Map(exits.map((exit) => [exit.to, exit.id]));

  const rewrite = (target: string): string => {
    if (target === QUEUE || selected.has(blockOf(target))) return target;
    const exitId = outOf.get(target);
    return exitId !== undefined ? `${OUT}${exitId}` : target;
  };

  const definition: CompositeDefinition = {
    entries,
    exits: exits.map(({ id, name }) => ({ id, name })),
    params: [],
    blocks: selectedNodes.map((node) => rewriteTargets(node, rewrite)),
  };

  const remaining = pipeline.nodes.filter((node) => !selected.has(node.id));
  const id = remaining.some((node) => node.id === name)
    ? freshId({ nodes: remaining }, name)
    : name;
  const instance: DrawnNode = {
    kind: "composite",
    id,
    of: name,
    prefix: "",
    set: {},
    exits: exits.map((exit) => ({ id: exit.id, to: exit.to })),
  };
  const reaches = new Map(
    entries.map((entry, at) => [entry.block, at === 0 ? id : `${id}/${entry.id}`] as const),
  );
  const rewired = remaining.map((node) =>
    [...reaches].reduce((one, [from, to]) => redirect(one, from, to), node),
  );
  return {
    _tag: "Made",
    pipeline: { nodes: [...rewired, instance] },
    definition,
    id,
    reaches,
  };
};

/**
 * The name a wire out of `source` takes as an exit: the exit's name on an
 * agent or check, or on a composite instance the definition's name of the
 * exit. Undefined for a router, gate, branch or worktree, whose wires have
 * no exit name.
 */
const exitNameOf = (
  source: DrawnNode | undefined,
  to: string,
  composites: Composites,
): string | undefined => {
  if (source === undefined) return undefined;
  switch (source.kind) {
    case "agent":
    case "check":
      return source.exits.find((exit) => exit.to === to)?.name;
    case "composite": {
      const exit = source.exits.find((one) => one.to === to);
      return composites[source.of]?.exits.find((named) => named.id === exit?.id)?.name;
    }
    default:
      return undefined;
  }
};

/**
 * Replaces a composite instance with its expanded blocks, keeping the
 * expanded ids so a task standing at one of them stays there.
 */
export const unpack = (
  pipeline: Drawing,
  id: string,
  composites: Composites,
):
  | {
      readonly _tag: "Unpacked";
      readonly pipeline: Drawing;
      /** Where a wire to the instance (or to `<id>/<entry id>`) now leads, which a definition's entries must follow. */
      readonly reaches: ReadonlyMap<string, string>;
    }
  | { readonly _tag: "Refused"; readonly reason: string } => {
  const instance = pipeline.nodes.find((node) => node.id === id);
  if (instance?.kind !== "composite") {
    return { _tag: "Refused", reason: `${id} is not a composite instance` };
  }
  const opened = unpackInstance(instance, composites, pipeline.nodes);
  if (opened._tag === "Failed") {
    return { _tag: "Refused", reason: opened.problems.join("; ") };
  }
  return {
    _tag: "Unpacked",
    pipeline: {
      nodes: [
        ...pipeline.nodes
          .filter((node) => node.id !== id)
          .map((node) =>
            [...opened.reaches].reduce((one, [from, to]) => redirect(one, from, to), node),
          ),
        ...opened.blocks,
      ],
    },
    reaches: opened.reaches,
  };
};

/** Sets a parameter value on a composite instance. */
export const setParam = (pipeline: Drawing, id: string, name: string, value: ParamValue): Drawing =>
  mapNode(pipeline, id, (node) =>
    node.kind === "composite" ? { ...node, set: { ...node.set, [name]: value } } : node,
  );

/** Adds a parameter to a definition, or refuses a duplicate name or a field it cannot set. */
export const addParam = (
  definition: CompositeDefinition,
  param: {
    readonly name: string;
    readonly default?: ParamValue;
    readonly sets: ReadonlyArray<{ readonly block: string; readonly field: string }>;
  },
):
  | { readonly _tag: "Changed"; readonly definition: CompositeDefinition }
  | { readonly _tag: "Refused"; readonly reason: string } => {
  if (definition.params.some((one) => one.name === param.name)) {
    return {
      _tag: "Refused",
      reason: `the definition already has a parameter named ${param.name}`,
    };
  }
  if (param.sets.length === 0) {
    return { _tag: "Refused", reason: `parameter ${param.name} must set at least one field` };
  }
  for (const { block, field } of param.sets) {
    const node = definition.blocks.find((one) => one.id === block);
    if (node === undefined) {
      return { _tag: "Refused", reason: `${block} is not in the definition` };
    }
    const allowed = PARAM_FIELDS[node.kind];
    if (allowed === undefined || !allowed.includes(field)) {
      return {
        _tag: "Refused",
        reason: `parameter ${param.name} cannot set ${field} on ${node.kind} ${block}`,
      };
    }
  }
  return {
    _tag: "Changed",
    definition: {
      ...definition,
      params: [
        ...definition.params,
        {
          name: param.name,
          default: param.default,
          sets: [...param.sets],
        },
      ],
    },
  };
};

/** Drops a parameter from a definition. */
export const removeParam = (
  definition: CompositeDefinition,
  name: string,
): CompositeDefinition => ({
  ...definition,
  params: definition.params.filter((param) => param.name !== name),
});

/** Renames a composite exit by id, leaving every instance wired. */
export const renameCompositeExit = (
  definition: CompositeDefinition,
  id: string,
  name: string,
):
  | { readonly _tag: "Changed"; readonly definition: CompositeDefinition }
  | { readonly _tag: "Refused"; readonly reason: string } => {
  if (!definition.exits.some((exit) => exit.id === id)) {
    return { _tag: "Refused", reason: `the definition has no exit ${id}` };
  }
  if (definition.exits.some((exit) => exit.id !== id && exit.name === name)) {
    return { _tag: "Refused", reason: `the definition already has an exit named ${name}` };
  }
  return {
    _tag: "Changed",
    definition: {
      ...definition,
      exits: definition.exits.map((exit) => (exit.id === id ? { ...exit, name } : exit)),
    },
  };
};

type DefinitionResult =
  | { readonly _tag: "Changed"; readonly definition: CompositeDefinition }
  | { readonly _tag: "Refused"; readonly reason: string };

/** Adds an entry named `name` that reaches `block`, with a fresh id. */
export const addEntry = (
  definition: CompositeDefinition,
  block: string,
  name: string,
): DefinitionResult => {
  const refusal = entryTargetRefusal(definition, block) ?? entryNameRefusal(definition, name);
  if (refusal !== undefined) return { _tag: "Refused", reason: refusal };
  let id = `entry-${name}`;
  for (let n = 2; definition.entries.some((one) => one.id === id); n++) id = `entry-${name}-${n}`;
  return {
    _tag: "Changed",
    definition: { ...definition, entries: [...definition.entries, { id, name, block }] },
  };
};

/** Drops an entry. The last one stays: a definition with no way in cannot be used. */
export const removeEntry = (definition: CompositeDefinition, id: string): DefinitionResult => {
  if (!definition.entries.some((entry) => entry.id === id)) {
    return { _tag: "Refused", reason: `the definition has no entry ${id}` };
  }
  if (definition.entries.length === 1) {
    return { _tag: "Refused", reason: `${id} is the last entry: a definition needs one` };
  }
  return {
    _tag: "Changed",
    definition: { ...definition, entries: definition.entries.filter((entry) => entry.id !== id) },
  };
};

/** Renames an entry by id, leaving every wire to it in place. */
export const renameEntry = (
  definition: CompositeDefinition,
  id: string,
  name: string,
): DefinitionResult => {
  if (!definition.entries.some((entry) => entry.id === id)) {
    return { _tag: "Refused", reason: `the definition has no entry ${id}` };
  }
  const refusal = entryNameRefusal(definition, name, id);
  if (refusal !== undefined) return { _tag: "Refused", reason: refusal };
  return {
    _tag: "Changed",
    definition: {
      ...definition,
      entries: definition.entries.map((entry) => (entry.id === id ? { ...entry, name } : entry)),
    },
  };
};

/** Points an entry at another block. */
export const setEntry = (
  definition: CompositeDefinition,
  id: string,
  block: string,
): DefinitionResult => {
  if (!definition.entries.some((entry) => entry.id === id)) {
    return { _tag: "Refused", reason: `the definition has no entry ${id}` };
  }
  const refusal = entryTargetRefusal(definition, block);
  if (refusal !== undefined) return { _tag: "Refused", reason: refusal };
  return {
    _tag: "Changed",
    definition: {
      ...definition,
      entries: definition.entries.map((entry) => (entry.id === id ? { ...entry, block } : entry)),
    },
  };
};

const entryTargetRefusal = (definition: CompositeDefinition, block: string) =>
  definition.blocks.some((one) => one.id === blockOf(block))
    ? undefined
    : `${block} is not in the definition`;

const entryNameRefusal = (definition: CompositeDefinition, name: string, except?: string) =>
  definition.entries.some((entry) => entry.id !== except && entry.name === name)
    ? `the definition already has an entry named ${name}`
    : undefined;

/** Whether `target` is `<instance>/<entry id>` of an instance in the drawing whose definition has that entry. */
const entryTargetOf = (pipeline: Drawing, target: string, composites: Composites): boolean => {
  const at = target.indexOf("/");
  if (at < 0) return false;
  const instance = pipeline.nodes.find((node) => node.id === target.slice(0, at));
  return (
    instance?.kind === "composite" &&
    (composites[instance.of]?.entries ?? []).some((entry) => entry.id === target.slice(at + 1))
  );
};

/** The block a wire target names: the target without its `/<entry id>`. */
export const blockOf = (target: string): string => {
  const at = target.indexOf("/");
  return at < 0 ? target : target.slice(0, at);
};

/** `node` with `f` applied to each wire target it holds. */
const rewriteTargets = (node: DrawnNode, f: (target: string) => string): DrawnNode => {
  switch (node.kind) {
    case "source":
    case "gate":
    case "branch":
    case "worktree":
      return { ...node, next: f(node.next) };
    case "agent":
    case "check":
      return { ...node, exits: node.exits.map((exit) => ({ ...exit, to: f(exit.to) })) };
    case "composite":
      return { ...node, exits: node.exits.map((exit) => ({ ...exit, to: f(exit.to) })) };
    case "router":
      return {
        ...node,
        routes: node.routes.map((route) => ({ ...route, to: f(route.to) })),
        else: f(node.else),
      };
    case "land":
    case "done":
    case "park":
      return node;
  }
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
  // A wire to `<id>/<entry id>` enters the same block, so it runs on too.
  if (onward !== undefined) {
    return {
      nodes: others.map((other) =>
        rewriteTargets(other, (target) => (blockOf(target) === id ? onward : target)),
      ),
    };
  }
  return wiresOf(pipeline).some((wire) => blockOf(wire.to) === id) ? pipeline : { nodes: others };
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
 * nothing ends. An exit may also lead to `queue`, a return. Inside a
 * definition draft, `out:<exit id>` is a valid end when `outs` holds that id
 * (`docs/composite-blocks.md`). `<instance>/<entry id>` is a valid end when
 * the instance's definition has that entry. Refused (none) when either end is
 * not allowed.
 */
export const rejoin = (
  pipeline: Drawing,
  wire: Pick<Wire, "from" | "port">,
  to: string,
  outs: ReadonlySet<string> = new Set(),
  composites: Composites = {},
): Option.Option<Drawing> => {
  const outId = to.startsWith(OUT) ? to.slice(OUT.length) : undefined;
  const allowed =
    pipeline.nodes.some((node) => node.id === to) ||
    entryTargetOf(pipeline, to, composites) ||
    (to === QUEUE && typeof wire.port === "string" && wire.port.startsWith("exit:")) ||
    (outId !== undefined && outs.has(outId));
  return pipeline.nodes.some((node) => node.id === wire.from) && allowed
    ? Option.some(retargeted(pipeline, wire, to))
    : Option.none();
};

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
export const configure = (
  pipeline: Drawing,
  id: string,
  setting: BlockSetting,
  composites: Composites = {},
): Drawing => {
  const configured = mapNode(pipeline, id, (node) => settled(node, setting));
  return setting.kind === "land" ? landingGated(pipeline, configured, id, composites) : configured;
};

/**
 * `after`, a change of land `id` in `before`, with the gates its landing needs.
 * A pull-request land takes a gate of each of its steps on every route to it,
 * so each one a route lacks is put directly before the land. A publish gate
 * that reached a pull-request land before the change and reaches none after it
 * is taken out, since it holds a step that never comes.
 *
 * Routes are read from the expansion, so a land reached through a composite
 * instance still gets its gates (`docs/composite-blocks.md`).
 */
const landingGated = (
  before: Drawing,
  after: Drawing,
  id: string,
  composites: Composites,
): Drawing => {
  const stranded = new Set(
    strandedPublishGates(expandedOf(before, composites)).map((gate) => gate.id),
  );
  const kept = strandedPublishGates(expandedOf(after, composites))
    .filter((gate) => !stranded.has(gate.id))
    .reduce((pipeline, gate) => remove(pipeline, gate.id), after);
  const land = pullRequestLands(expandedOf(kept, composites)).filter((node) => node.id === id);
  return PULL_REQUEST_STEPS.filter(
    (step) => routesWithoutGate(expandedOf(kept, composites), step, land).length > 0,
  ).reduce((pipeline, step) => gatedBefore(pipeline, id, step), kept);
};

/**
 * The expansion of a drawing for landing-gate placement. An expansion that
 * fails yields no engine blocks, so a broken composite does not invent gates.
 */
const expandedOf = (drawing: Drawing, composites: Composites): Pipeline => {
  const result = expand(drawing, composites);
  return result._tag === "Expanded" ? result.pipeline : { nodes: [] };
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
