/**
 * Expansion of composite instances into the blocks of their definitions.
 *
 * `expand` is pure. Foreman runs, validates, places and traces the expansion;
 * the operator draws the pipeline as written, with instances
 * (`docs/composite-blocks.md`). An expansion that fails is a validation
 * problem of that project alone.
 */
import { Result, Schema as S } from "effect";
import {
  type CompositeDefinition,
  type CompositeNode,
  type CompositeParam,
  type Composites,
  type DrawnNode,
  DrawnNode as DrawnNodeSchema,
  type Drawing,
  isVarName,
  mapFilterBlocks,
  type ParamValue,
  type Pipeline,
  type PipelineNode,
  QUEUE,
} from "./pipeline.ts";

/** A wire inside a definition that leaves by an exit. */
const OUT = "out:";

/**
 * Fields a parameter may set on a block inside a definition. The node schema
 * of each block checks the value after the replace. AddParam reads the same
 * list (`docs/composite-blocks.md`).
 */
export const PARAM_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  agent: ["model", "instructions", "slots", "stopped"],
  check: ["command"],
  gate: ["step"],
  land: ["how", "onto"],
};
/** Whether a parameter may set `field` on a block of `kind`: a listed field, or an agent's `vars.<name>`. */
export const isSettable = (kind: string, field: string): boolean =>
  PARAM_FIELDS[kind]?.includes(field) === true ||
  (kind === "agent" && field.startsWith(VARS_PREFIX) && isVarName(field.slice(VARS_PREFIX.length)));

const VARS_PREFIX = "vars.";

/** `block` with `field` set to `value`; `vars.<name>` sets one entry of the agent's vars. */
const withField = (block: DrawnNode, field: string, value: ParamValue): object =>
  field.startsWith(VARS_PREFIX)
    ? {
        ...block,
        vars: {
          ...("vars" in block ? block.vars : undefined),
          [field.slice(VARS_PREFIX.length)]: String(value),
        },
      }
    : { ...block, [field]: value };

export type ExpandResult =
  | { readonly _tag: "Expanded"; readonly pipeline: Pipeline }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<string> };

/**
 * The pipeline with each composite instance replaced by copies of its
 * definition's blocks. Failures (unknown definition, unwired exit, missing
 * parameter, recursion, a refused parameter value) are problems of the
 * project that holds the instance.
 *
 * Every wire is resolved once, in the scope it was written in: the drawing's
 * wires here, a definition's wires when its blocks are copied. No later pass
 * rewrites them, so an id inside a definition can share a name with a block
 * of the drawing without the two meeting.
 */
export const expand = (drawing: Drawing, composites: Composites): ExpandResult => {
  const problems: Array<string> = duplicateIdsOf(drawing.nodes).map(
    (id) => `two blocks are named ${id}`,
  );
  const resolve = entryResolver(drawing.nodes, composites);
  const resolved = drawing.nodes.map((node) => mapTargets(node, resolve));
  const nodes = expandList(resolved, composites, new Set(), problems);
  if (problems.length > 0) return { _tag: "Failed", problems: [...new Set(problems)] };
  return { _tag: "Expanded", pipeline: { nodes } };
};

/** The ids named by more than one node, each once. */
const duplicateIdsOf = (nodes: ReadonlyArray<DrawnNode>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) repeated.add(node.id);
    seen.add(node.id);
  }
  return [...repeated];
};

/**
 * Each engine block of `nodes`, with every composite instance in it replaced
 * by its expansion. The wires of `nodes` are already resolved in their scope.
 */
const expandList = (
  nodes: ReadonlyArray<DrawnNode>,
  composites: Composites,
  stack: ReadonlySet<string>,
  problems: Array<string>,
): ReadonlyArray<PipelineNode> => {
  const blocks: Array<PipelineNode> = [];
  for (const node of nodes) {
    if (node.kind === "composite") {
      blocks.push(...expandInstance(node, composites, stack, problems));
      continue;
    }
    blocks.push(node);
  }
  return blocks;
};

/**
 * The expanded block ids each composite instance in `drawing` covers, for a
 * page that draws instances as one block and places tasks that stand inside
 * on that block (`docs/composite-blocks.md`). An instance that cannot expand
 * is omitted; expansion problems are reported elsewhere.
 */
export const coversOf = (
  drawing: Drawing,
  composites: Composites,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const covers = new Map<string, ReadonlyArray<string>>();
  for (const node of drawing.nodes) {
    if (node.kind !== "composite") continue;
    const unpacked = unpackInstance(node, composites, drawing.nodes);
    if (unpacked._tag === "Unpacked") {
      covers.set(
        node.id,
        unpacked.blocks.map((block) => block.id),
      );
    }
  }
  return covers;
};

/**
 * The expanded engine blocks of one instance, and where a wire into each of
 * its entries lands: `reaches` maps the instance's id (its default entry) and
 * `<id>/<entry id>` to an expanded block id. Used by Unpack so the drawing
 * keeps the same ids the expansion would have used
 * (`docs/composite-blocks.md`). The instance's exits are read in the scope of
 * `scope`, the drawing it sits in, as `expand` reads them, so an exit that
 * leads back to the instance itself reaches one of its entries.
 */
export const unpackInstance = (
  instance: CompositeNode,
  composites: Composites,
  scope: ReadonlyArray<DrawnNode>,
):
  | {
      readonly _tag: "Unpacked";
      readonly blocks: ReadonlyArray<PipelineNode>;
      readonly reaches: ReadonlyMap<string, string>;
    }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<string> } => {
  const resolve = entryResolver(scope, composites);
  const resolved: CompositeNode = {
    ...instance,
    exits: instance.exits.map((exit) => ({ ...exit, to: resolve(exit.to) })),
  };
  const problems: Array<string> = [];
  const blocks = expandInstance(resolved, composites, new Set(), problems);
  if (problems.length > 0) return { _tag: "Failed", problems: [...new Set(problems)] };
  const reaches = new Map<string, string>();
  for (const target of entryTargetsOf(instance, composites)) {
    const reached = resolve(target);
    if (reached !== target) reaches.set(target, reached);
  }
  if (!reaches.has(instance.id)) {
    return {
      _tag: "Failed",
      problems: [`${instance.id}: the definition ${instance.of} has no entry`],
    };
  }
  return { _tag: "Unpacked", blocks, reaches };
};

/**
 * The blocks of one instance after parameter replace, prefixing and wire
 * rewrite. Empty when the instance cannot expand; `problems` holds why.
 * `stack` names the definitions this instance sits inside, so a definition
 * that holds itself stops here.
 */
const expandInstance = (
  instance: CompositeNode,
  composites: Composites,
  stack: ReadonlySet<string>,
  problems: Array<string>,
): ReadonlyArray<PipelineNode> => {
  if (stack.has(instance.of)) {
    problems.push(
      `${instance.id}: the definition ${instance.of} holds itself, directly or through others`,
    );
    return [];
  }
  const definition = composites[instance.of];
  if (definition === undefined) {
    problems.push(`${instance.id}: the definition ${instance.of} is unknown`);
    return [];
  }

  const exitWires = wiresOfExits(instance, definition, problems);
  if (exitWires === undefined) return [];

  const values = valuesOf(instance, definition, problems);
  if (values === undefined) return [];

  const innerById = new Map(definition.blocks.map((block) => [block.id, block]));
  if (definition.entries.length === 0) {
    problems.push(`${instance.id}: the definition ${instance.of} has no entry`);
    return [];
  }
  for (const entry of definition.entries) {
    if (!innerById.has(splitTarget(entry.block)[0])) {
      problems.push(
        `${instance.id}: the definition ${instance.of} names entry ${entry.id} at ${entry.block}, which is no block`,
      );
      return [];
    }
  }
  const slashed = [...definition.blocks.map((block) => block.id), instance.id].filter((id) =>
    id.includes("/"),
  );
  if (slashed.length > 0) {
    problems.push(...slashed.map((id) => `${id}: a block id holds no "/"`));
    return [];
  }
  const repeated = duplicateIdsOf(definition.blocks);
  if (repeated.length > 0) {
    problems.push(
      ...repeated.map(
        (id) => `${instance.id}: the definition ${instance.of} names two blocks ${id}`,
      ),
    );
    return [];
  }

  // A wire inside the definition, resolved in the definition's scope: an
  // exit's wire is already resolved in the instance's scope, a wire to an inner
  // instance reaches the entry it names (else its default), anything else gets
  // the instance's prefix.
  const wireIn = (target: string): string => {
    if (target === QUEUE) return QUEUE;
    if (target.startsWith(OUT)) {
      const wire = exitWires.get(target.slice(OUT.length));
      if (wire !== undefined) return wire;
      problems.push(
        `${instance.id}: the definition ${instance.of} wires ${target}, which is no exit of it`,
      );
      return target;
    }
    const [blockId, entryId] = splitTarget(target);
    const inner = innerById.get(blockId);
    if (inner === undefined || (entryId !== undefined && inner.kind !== "composite")) {
      problems.push(
        `${instance.id}: the definition ${instance.of} wires ${target}, which is no block of it`,
      );
      return target;
    }
    if (inner.kind === "composite") {
      // An inner instance is reached by one of its entries. When that fails
      // the nested instance reports why, so a placeholder is enough.
      const reached = entryOf(
        { of: inner.of, prefix: instance.prefix + inner.prefix },
        entryId,
        composites,
        new Set([instance.of]),
      );
      return reached ?? instance.prefix + blockId;
    }
    return instance.prefix + target;
  };

  const copies: Array<DrawnNode> = [];
  for (const block of definition.blocks) {
    // Parameters replace fields on the definition block before prefixing, so
    // the match is by the definition's own id.
    const set = applyParams(block, instance, values, problems);
    if (set === undefined) return [];
    const wired = mapFilters(mapTargets(set, wireIn), (name) => instance.prefix + name);
    copies.push(prefixed(wired, instance.prefix));
  }
  return expandList(copies, composites, new Set(stack).add(instance.of), problems);
};

/** A wire target split into the block and the entry it names (`<block>/<entry id>`). */
const splitTarget = (target: string): readonly [string, string | undefined] => {
  const at = target.indexOf("/");
  return at < 0 ? [target, undefined] : [target.slice(0, at), target.slice(at + 1)];
};

/**
 * The block a wire into entry `entryId` of the instance reaches (the default
 * entry when `entryId` is undefined), with an inner instance followed through
 * its definition. Reads only the definitions, so it does not depend on the
 * expansion. Undefined when a definition is unknown, has no such entry, or
 * holds itself through the entry.
 */
const entryOf = (
  instance: Pick<CompositeNode, "of" | "prefix">,
  entryId: string | undefined,
  composites: Composites,
  visited: ReadonlySet<string>,
): string | undefined => {
  if (visited.has(instance.of)) return undefined;
  const definition = composites[instance.of];
  if (definition === undefined) return undefined;
  const entry =
    entryId === undefined
      ? definition.entries[0]
      : definition.entries.find((one) => one.id === entryId);
  if (entry === undefined) return undefined;
  const [blockId, innerEntry] = splitTarget(entry.block);
  const block = definition.blocks.find((one) => one.id === blockId);
  if (block === undefined) return undefined;
  if (block.kind !== "composite") return instance.prefix + block.id;
  return entryOf(
    { of: block.of, prefix: instance.prefix + block.prefix },
    innerEntry,
    composites,
    new Set(visited).add(instance.of),
  );
};

/** The wire targets that reach an instance: its id, then `<id>/<entry id>` for each entry. */
const entryTargetsOf = (
  instance: Pick<CompositeNode, "id" | "of">,
  composites: Composites,
): ReadonlyArray<string> => [
  instance.id,
  ...(composites[instance.of]?.entries ?? []).map((entry) => `${instance.id}/${entry.id}`),
];

/**
 * Maps each wire target that names a composite instance in `nodes` (its id, or
 * `<id>/<entry id>`) to the block it reaches. A target that names none is
 * returned unchanged.
 */
const entryResolver = (
  nodes: ReadonlyArray<DrawnNode>,
  composites: Composites,
): ((target: string) => string) => {
  const reached = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind !== "composite") continue;
    for (const target of entryTargetsOf(node, composites)) {
      const [, entryId] = splitTarget(target);
      const block = entryOf(node, entryId, composites, new Set());
      if (block !== undefined) reached.set(target, block);
    }
  }
  return (target) => reached.get(target) ?? target;
};

/** Each definition exit's wire on the instance, or nothing when one is missing or extra. */
const wiresOfExits = (
  instance: CompositeNode,
  definition: CompositeDefinition,
  problems: Array<string>,
): ReadonlyMap<string, string> | undefined => {
  const declared = new Set(definition.exits.map((exit) => exit.id));
  const wired = new Map<string, string>();
  for (const exit of instance.exits) {
    if (!declared.has(exit.id)) {
      problems.push(
        `${instance.id}: exit ${exit.id} is not an exit of the definition ${instance.of}`,
      );
      return undefined;
    }
    if (wired.has(exit.id)) {
      problems.push(`${instance.id}: two wires name the exit ${exit.id}`);
      return undefined;
    }
    wired.set(exit.id, exit.to);
  }
  for (const exit of definition.exits) {
    if (!wired.has(exit.id)) {
      problems.push(`${instance.id}: exit ${exit.id} is not wired`);
      return undefined;
    }
  }
  return wired;
};

/** Each parameter with its value on the instance, default included, or nothing when one is missing. */
const valuesOf = (
  instance: CompositeNode,
  definition: CompositeDefinition,
  problems: Array<string>,
): ReadonlyArray<readonly [CompositeParam, ParamValue]> | undefined => {
  const given = new Map(Object.entries(instance.set));
  for (const name of given.keys()) {
    if (!definition.params.some((param) => param.name === name)) {
      problems.push(
        `${instance.id}: parameter ${name} is not a parameter of the definition ${instance.of}`,
      );
      return undefined;
    }
  }
  const values: Array<readonly [CompositeParam, ParamValue]> = [];
  for (const param of definition.params) {
    const value = given.get(param.name) ?? param.default;
    if (value === undefined) {
      problems.push(`${instance.id}: parameter ${param.name} is not set`);
      return undefined;
    }
    values.push([param, value]);
  }
  return values;
};

/**
 * Replace the fields each parameter sets on this definition block. A value
 * the block's schema refuses is a problem named on the instance.
 */
const applyParams = (
  block: DrawnNode,
  instance: CompositeNode,
  values: ReadonlyArray<readonly [CompositeParam, ParamValue]>,
  problems: Array<string>,
): DrawnNode | undefined => {
  let current: DrawnNode = block;
  for (const [param, value] of values) {
    for (const { block: target, field } of param.sets) {
      if (target !== block.id) continue;
      if (!isSettable(current.kind, field)) {
        problems.push(
          `${instance.id}: parameter ${param.name} cannot set ${field} on ${current.kind} ${block.id}`,
        );
        return undefined;
      }
      const decoded = S.decodeUnknownResult(DrawnNodeSchema)(withField(current, field, value));
      if (Result.isFailure(decoded)) {
        problems.push(
          `${instance.id}: parameter ${param.name} sets a value ${block.id}.${field} refuses`,
        );
        return undefined;
      }
      current = decoded.success;
    }
  }
  return current;
};

/**
 * A definition block's copy under the instance's prefix. A nested instance's
 * prefix joins the instance's, so its expanded ids stay stable.
 */
const prefixed = (node: DrawnNode, prefix: string): DrawnNode => {
  const id = prefix + node.id;
  return node.kind === "composite"
    ? { ...node, id, prefix: prefix + node.prefix }
    : { ...node, id };
};

/** `node` with `f` applied to the block of each filter term that names one. */
const mapFilters = (node: DrawnNode, f: (block: string) => string): DrawnNode => {
  switch (node.kind) {
    case "source":
      return { ...node, filter: mapFilterBlocks(node.filter, f) };
    case "router":
      return {
        ...node,
        routes: node.routes.map((route) => ({ ...route, when: mapFilterBlocks(route.when, f) })),
      };
    default:
      return node;
  }
};

/** `node` with `f` applied to each wire target it holds. */
const mapTargets = (node: DrawnNode, f: (target: string) => string): DrawnNode => {
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
