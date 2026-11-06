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
  type ParamValue,
  type Pipeline,
  type PipelineNode,
  QUEUE,
} from "./pipeline.ts";

/** A wire inside a definition that leaves by an exit. */
const OUT = "out:";

/**
 * Fields a parameter may set on a block inside a definition. The node schema
 * of each block checks the value after the replace.
 */
const SETTABLE: Readonly<Record<string, ReadonlyArray<string>>> = {
  agent: ["model", "instructions", "slots", "stopped"],
  check: ["command"],
  gate: ["step"],
  land: ["how", "onto"],
};

export type ExpandResult =
  | { readonly _tag: "Expanded"; readonly pipeline: Pipeline }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<string> };

/**
 * The pipeline with each composite instance replaced by copies of its
 * definition's blocks. Failures (unknown definition, unwired exit, missing
 * parameter, recursion, a refused parameter value) are problems of the
 * project that holds the instance.
 */
export const expand = (drawing: Drawing, composites: Composites): ExpandResult => {
  const problems: Array<string> = [];
  const { nodes } = expandNodes(drawing.nodes, composites, new Set(), problems, new Map());
  if (problems.length > 0) return { _tag: "Failed", problems: [...new Set(problems)] };
  // Every composite was replaced; what remains is the engine pipeline.
  const pipeline: Pipeline = {
    nodes: nodes.filter((node): node is PipelineNode => node.kind !== "composite"),
  };
  return { _tag: "Expanded", pipeline };
};

/**
 * Expand every instance in `nodes`, depth-first. Nested instances inside a
 * definition expand with the prefixes joined when their copy is made.
 * `rewrites` maps each expanded instance id to the final entry id after any
 * nested expansion, so a wire into an instance whose entry was itself a
 * composite still reaches the innermost entry.
 */
const expandNodes = (
  nodes: ReadonlyArray<DrawnNode>,
  composites: Composites,
  stack: ReadonlySet<string>,
  problems: Array<string>,
  rewrites: Map<string, string>,
): { readonly nodes: ReadonlyArray<DrawnNode> } => {
  let current: ReadonlyArray<DrawnNode> = nodes;
  for (;;) {
    const instance = current.find((node): node is CompositeNode => node.kind === "composite");
    if (instance === undefined) return { nodes: current };
    const expanded = expandInstance(instance, composites, stack, problems, rewrites);
    if (expanded === undefined) {
      // Drop the failed instance so a later reader does not loop on it; the
      // problems already stop the project.
      current = current.filter((node) => node.id !== instance.id);
      continue;
    }
    rewrites.set(instance.id, expanded.entryId);
    current = [
      ...current
        .filter((node) => node.id !== instance.id)
        .map((node) => retarget(node, instance.id, expanded.entryId)),
      ...expanded.blocks,
    ];
  }
};

/**
 * One instance's blocks after parameter replace, prefixing and wire rewrite.
 * Nothing when the instance cannot expand; `problems` holds why.
 */
const expandInstance = (
  instance: CompositeNode,
  composites: Composites,
  stack: ReadonlySet<string>,
  problems: Array<string>,
  rewrites: Map<string, string>,
): { readonly entryId: string; readonly blocks: ReadonlyArray<DrawnNode> } | undefined => {
  if (stack.has(instance.of)) {
    problems.push(
      `${instance.id}: the definition ${instance.of} holds itself, directly or through others`,
    );
    return undefined;
  }
  const definition = composites[instance.of];
  if (definition === undefined) {
    problems.push(`${instance.id}: the definition ${instance.of} is unknown`);
    return undefined;
  }

  const exitWires = wiresOfExits(instance, definition, problems);
  if (exitWires === undefined) return undefined;

  const values = valuesOf(instance, definition, problems);
  if (values === undefined) return undefined;

  const innerIds = new Set(definition.blocks.map((block) => block.id));
  if (!innerIds.has(definition.entry)) {
    problems.push(
      `${instance.id}: the definition ${instance.of} names entry ${definition.entry}, which is no block`,
    );
    return undefined;
  }

  const beforeNested: Array<DrawnNode> = [];
  for (const block of definition.blocks) {
    // Parameters replace fields on the definition block before prefixing, so
    // the match is by the definition's own id.
    const set = applyParams(block, instance, definition.params, values, problems);
    if (set === undefined) return undefined;
    beforeNested.push(copyBlock(set, instance.prefix, innerIds, exitWires));
  }

  const nestedStack = new Set(stack).add(instance.of);
  const { nodes: blocks } = expandNodes(beforeNested, composites, nestedStack, problems, rewrites);
  // Follow nested rewrites so the entry is the block that remains after
  // nested composites expand away.
  let entryId = instance.prefix + definition.entry;
  while (rewrites.has(entryId)) entryId = rewrites.get(entryId)!;
  return { entryId, blocks };
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

/** Each parameter's value on the instance, default included, or nothing when one is missing. */
const valuesOf = (
  instance: CompositeNode,
  definition: CompositeDefinition,
  problems: Array<string>,
): ReadonlyMap<string, ParamValue> | undefined => {
  const values = new Map<string, ParamValue>();
  for (const param of definition.params) {
    if (Object.prototype.hasOwnProperty.call(instance.set, param.name)) {
      values.set(param.name, instance.set[param.name]!);
      continue;
    }
    if (param.default !== undefined) {
      values.set(param.name, param.default);
      continue;
    }
    problems.push(`${instance.id}: parameter ${param.name} is not set`);
    return undefined;
  }
  for (const name of Object.keys(instance.set)) {
    if (!definition.params.some((param) => param.name === name)) {
      problems.push(
        `${instance.id}: parameter ${name} is not a parameter of the definition ${instance.of}`,
      );
      return undefined;
    }
  }
  return values;
};

/** Copy one definition block with a prefixed id and rewritten wires. Nested instances join prefixes. */
const copyBlock = (
  block: DrawnNode,
  prefix: string,
  innerIds: ReadonlySet<string>,
  exitWires: ReadonlyMap<string, string>,
): DrawnNode => {
  const id = prefix + block.id;
  const to = (target: string): string => rewriteTo(target, prefix, innerIds, exitWires);
  switch (block.kind) {
    case "source":
    case "gate":
    case "branch":
    case "worktree":
      return { ...block, id, next: to(block.next) };
    case "agent":
    case "check":
      return { ...block, id, exits: block.exits.map((exit) => ({ ...exit, to: to(exit.to) })) };
    case "router":
      return {
        ...block,
        id,
        routes: block.routes.map((route) => ({ ...route, to: to(route.to) })),
        else: to(block.else),
      };
    case "composite":
      return {
        ...block,
        id,
        // Prefixes join so a nested instance's blocks keep a stable expanded id.
        prefix: prefix + block.prefix,
        exits: block.exits.map((exit) => ({ ...exit, to: to(exit.to) })),
      };
    case "land":
    case "done":
    case "park":
      return { ...block, id };
  }
};

const rewriteTo = (
  target: string,
  prefix: string,
  innerIds: ReadonlySet<string>,
  exitWires: ReadonlyMap<string, string>,
): string => {
  if (target === QUEUE) return QUEUE;
  if (target.startsWith(OUT)) return exitWires.get(target.slice(OUT.length)) ?? target;
  if (innerIds.has(target)) return prefix + target;
  return target;
};

/**
 * Replace the fields each parameter sets on this definition block, before it
 * is prefixed. A value the block's schema refuses is a problem named on the
 * instance.
 */
const applyParams = (
  block: DrawnNode,
  instance: CompositeNode,
  params: ReadonlyArray<CompositeParam>,
  values: ReadonlyMap<string, ParamValue>,
  problems: Array<string>,
): DrawnNode | undefined => {
  let current: DrawnNode = block;
  for (const param of params) {
    const value = values.get(param.name);
    for (const { block: target, field } of param.sets) {
      if (target !== block.id) continue;
      const allowed = SETTABLE[current.kind];
      if (allowed === undefined || !allowed.includes(field)) {
        problems.push(
          `${instance.id}: parameter ${param.name} cannot set ${field} on ${current.kind} ${block.id}`,
        );
        return undefined;
      }
      const decoded = S.decodeUnknownResult(DrawnNodeSchema)({ ...current, [field]: value });
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

/** Retarget every wire of `node` that ran to `from` so it runs to `to`. */
const retarget = (node: DrawnNode, from: string, to: string): DrawnNode => {
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
