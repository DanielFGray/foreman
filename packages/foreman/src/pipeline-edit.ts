// The changes an operator makes to a pipeline, as data an editor can send, and
// the pure step that applies one. Every change itself is `pipeline-belt`'s;
// this module names each one, so the pane's editor and `foreman pipeline
// edit` decode the same changes.
import { Schema as S } from "effect";
import {
  AgentNode,
  type CompositeDefinition,
  type Composites,
  type Drawing,
  Exit,
  LandNode,
  LANDINGS,
  ParamValue,
} from "./pipeline.ts";
import {
  addExit,
  addParam,
  addRoute,
  addSource,
  chargeExit,
  configure,
  INSERTABLE,
  insertOn,
  makeComposite,
  rejoin,
  remove,
  removeExit,
  removeParam,
  removeRoute,
  renameCompositeExit,
  renameExit,
  setEmpty,
  setEntry,
  setParam,
  swapEnd,
  unpack,
} from "./pipeline-belt.ts";
import { STEPS } from "./policy.ts";

/** One way out of a block, as `pipeline-belt` names it: `next`, a router's `else`, route `n`, or an agent's or check's `exit:<name>`. */
export const WirePort = S.Union([
  S.Literals(["next", "else"]),
  S.Int,
  S.TemplateLiteral(["exit:", S.String]),
]);

export const WireRef = S.Struct({ from: S.String, port: WirePort });
export type WireRef = typeof WireRef.Type;

/**
 * What a block does, as `configure` takes it, named by the kind of block it is
 * for. The kind lets a decoder say which setting failed and why, and lets
 * `applyChange` refuse a setting sent to another kind of block.
 */
export const BlockSetting = S.Union([
  S.Struct({ kind: S.Literal("source"), filter: S.String }),
  S.Struct({ kind: S.Literal("gate"), step: S.Literals(STEPS) }),
  S.Struct({
    kind: S.Literal("agent"),
    role: AgentNode.fields.role,
    model: S.String,
    slots: AgentNode.fields.slots,
  }),
  S.Struct({ kind: S.Literal("router"), route: S.Int, when: S.String }),
  S.Struct({ kind: S.Literal("check"), command: S.String }),
  S.Struct({ kind: S.Literal("land"), how: S.Literals(LANDINGS), onto: LandNode.fields.onto }),
]);
export type BlockSetting = typeof BlockSetting.Type;

/** One change to a pipeline. */
export const PipelineChange = S.Union([
  S.TaggedStruct("InsertOn", {
    wire: WireRef,
    kind: S.Literals(INSERTABLE),
    of: S.optional(S.String),
  }),
  S.TaggedStruct("Remove", { id: S.String }),
  S.TaggedStruct("AddRoute", { router: S.String, when: S.String }),
  S.TaggedStruct("RemoveRoute", { router: S.String, index: S.Int }),
  S.TaggedStruct("Rejoin", { wire: WireRef, to: S.String }),
  S.TaggedStruct("AddSource", { filter: S.String }),
  S.TaggedStruct("SwapEnd", { id: S.String }),
  S.TaggedStruct("Configure", { id: S.String, setting: BlockSetting }),
  S.TaggedStruct("AddExit", { id: S.String, name: S.String }),
  S.TaggedStruct("RenameExit", { id: S.String, name: S.String, to: S.String }),
  S.TaggedStruct("RemoveExit", { id: S.String, name: S.String }),
  S.TaggedStruct("ChargeExit", { id: S.String, name: S.String, fails: Exit.fields.fails }),
  S.TaggedStruct("SetEmpty", { id: S.String, name: S.String, empty: Exit.fields.empty }),
  S.TaggedStruct("MakeComposite", { ids: S.Array(S.String), name: S.String }),
  S.TaggedStruct("Unpack", { id: S.String }),
  S.TaggedStruct("SetParam", { id: S.String, name: S.String, value: ParamValue }),
]);
export type PipelineChange = typeof PipelineChange.Type;

/** Definition-only verbs: parameters, exit names and the entry (`docs/composite-blocks.md`). */
export const DefinitionChange = S.Union([
  S.TaggedStruct("AddParam", {
    name: S.String,
    default: S.optional(ParamValue),
    sets: S.Array(S.Struct({ block: S.String, field: S.String })),
  }),
  S.TaggedStruct("RemoveParam", { name: S.String }),
  S.TaggedStruct("RenameCompositeExit", { id: S.String, name: S.String }),
  S.TaggedStruct("SetEntry", { entry: S.String }),
]);
export type DefinitionChange = typeof DefinitionChange.Type;

/** A change to a composite definition draft: pipeline verbs on its blocks, or a definition verb. */
export const CompositeChange = S.Union([PipelineChange, DefinitionChange]);
export type CompositeChange = typeof CompositeChange.Type;

export type ApplyResult =
  | {
      readonly _tag: "Changed";
      readonly pipeline: Drawing;
      readonly added: string | undefined;
      /** Definitions the change created, for the draft to carry. Empty when it created none. */
      readonly composites: Composites;
    }
  | { readonly _tag: "Refused"; readonly reason: string };

export type ApplyDefinitionResult =
  | {
      readonly _tag: "Changed";
      readonly definition: CompositeDefinition;
      readonly added: string | undefined;
      readonly composites: Composites;
    }
  | { readonly _tag: "Refused"; readonly reason: string };

/**
 * The pipeline after `change`, and the id of the block an insert or a new source
 * added, which an editor selects. The id of a gate that a land's `how` brings
 * is not returned. A change the pipeline cannot take answers `refused`: a
 * rejoin that names a
 * block the pipeline lacks, a setting for another kind of block, a new exit
 * name the block already has, an exit added, renamed or removed on a check,
 * whose exits are passed and failed, or a claim on a block that is no author.
 * A change that names a block, wire or exit
 * the pipeline lacks otherwise leaves it as it was.
 *
 * `composites` are the definitions the drawing may use: InsertOn of a
 * composite, Unpack and landing-gate placement read them; MakeComposite
 * refuses a name that is already among them and returns the new definition.
 *
 * `outs` are exit ids a definition draft may wire to as `out:<id>`.
 */
export const applyChange = (
  pipeline: Drawing,
  change: PipelineChange,
  composites: Composites = {},
  outs: ReadonlySet<string> = new Set(),
): ApplyResult => {
  const changed = (next: Drawing, added?: string, created: Composites = {}) =>
    ({
      _tag: "Changed",
      pipeline: next,
      added: added === "" ? undefined : added,
      composites: created,
    }) as const;
  switch (change._tag) {
    case "InsertOn": {
      if (change.kind === "composite") {
        if (change.of === undefined) {
          return { _tag: "Refused", reason: "InsertOn of a composite needs of" };
        }
        if (composites[change.of] === undefined) {
          return {
            _tag: "Refused",
            reason: `the definition ${change.of} is unknown`,
          };
        }
      }
      const inserted = insertOn(pipeline, change.wire, change.kind, change.of, composites);
      return changed(inserted.pipeline, inserted.id);
    }
    case "Remove":
      return changed(remove(pipeline, change.id));
    case "AddRoute":
      return changed(addRoute(pipeline, change.router, change.when));
    case "RemoveRoute":
      return changed(removeRoute(pipeline, change.router, change.index));
    case "Rejoin": {
      const rejoined = rejoin(pipeline, change.wire, change.to, outs);
      return rejoined._tag === "Some"
        ? changed(rejoined.value)
        : {
            _tag: "Refused",
            reason: `${change.wire.from} cannot lead to ${change.to}: one of them is not in the pipeline`,
          };
    }
    case "AddSource": {
      const added = addSource(pipeline, change.filter);
      return changed(added.pipeline, added.id);
    }
    case "SwapEnd":
      return changed(swapEnd(pipeline, change.id));
    case "Configure": {
      const node = pipeline.nodes.find((one) => one.id === change.id);
      return node !== undefined && node.kind !== change.setting.kind
        ? {
            _tag: "Refused",
            reason: `${change.id} is a ${node.kind}, so it takes no ${change.setting.kind} setting`,
          }
        : changed(configure(pipeline, change.id, change.setting, composites));
    }
    case "AddExit":
    case "RenameExit": {
      const name = change._tag === "AddExit" ? change.name : change.to;
      const refusal = exitRefusal(pipeline, change.id, name);
      if (refusal !== undefined) return { _tag: "Refused", reason: refusal };
      return changed(
        change._tag === "AddExit"
          ? addExit(pipeline, change.id, change.name)
          : renameExit(pipeline, change.id, change.name, change.to),
      );
    }
    case "RemoveExit": {
      const refusal = exitRefusal(pipeline, change.id, undefined);
      return refusal !== undefined
        ? { _tag: "Refused", reason: refusal }
        : changed(removeExit(pipeline, change.id, change.name));
    }
    case "ChargeExit":
      return changed(chargeExit(pipeline, change.id, change.name, change.fails));
    case "SetEmpty": {
      const node = pipeline.nodes.find((one) => one.id === change.id);
      return change.empty !== undefined && (node?.kind !== "agent" || node.role !== "author")
        ? { _tag: "Refused", reason: `${change.id} is no author, and only an author claims` }
        : changed(setEmpty(pipeline, change.id, change.name, change.empty));
    }
    case "MakeComposite": {
      const made = madeComposite(pipeline, change, composites);
      return made._tag === "Refused" ? made : changed(made.pipeline, made.id, made.composites);
    }
    case "Unpack": {
      const unpacked = unpack(pipeline, change.id, composites);
      return unpacked._tag === "Refused" ? unpacked : changed(unpacked.pipeline);
    }
    case "SetParam": {
      const node = pipeline.nodes.find((one) => one.id === change.id);
      return node?.kind !== "composite"
        ? { _tag: "Refused", reason: `${change.id} is not a composite instance` }
        : changed(setParam(pipeline, change.id, change.name, change.value));
    }
  }
};

/**
 * The definition after `change`. Pipeline verbs act on its blocks, with each
 * of its exits valid as `out:<id>`. A definition holds no source.
 */
export const applyDefinitionChange = (
  definition: CompositeDefinition,
  change: CompositeChange,
  composites: Composites = {},
): ApplyDefinitionResult => {
  switch (change._tag) {
    case "MakeComposite": {
      const made = madeComposite(
        { nodes: definition.blocks },
        change,
        composites,
        definition.entry,
      );
      if (made._tag === "Refused") return made;
      return {
        _tag: "Changed",
        definition: {
          ...definition,
          blocks: made.pipeline.nodes,
          entry: change.ids.includes(definition.entry) ? made.id : definition.entry,
        },
        added: made.id,
        composites: made.composites,
      };
    }
    case "Unpack": {
      const unpacked = unpack({ nodes: definition.blocks }, change.id, composites);
      if (unpacked._tag === "Refused") return unpacked;
      return {
        _tag: "Changed",
        definition: {
          ...definition,
          blocks: unpacked.pipeline.nodes,
          entry: definition.entry === change.id ? unpacked.entry : definition.entry,
        },
        added: undefined,
        composites: {},
      };
    }
    case "AddParam": {
      const added = addParam(definition, change);
      return added._tag === "Refused"
        ? added
        : { _tag: "Changed", definition: added.definition, added: undefined, composites: {} };
    }
    case "RemoveParam":
      return {
        _tag: "Changed",
        definition: removeParam(definition, change.name),
        added: undefined,
        composites: {},
      };
    case "RenameCompositeExit": {
      const renamed = renameCompositeExit(definition, change.id, change.name);
      return renamed._tag === "Refused"
        ? renamed
        : { _tag: "Changed", definition: renamed.definition, added: undefined, composites: {} };
    }
    case "SetEntry": {
      const set = setEntry(definition, change.entry);
      return set._tag === "Refused"
        ? set
        : { _tag: "Changed", definition: set.definition, added: undefined, composites: {} };
    }
    case "AddSource":
      return { _tag: "Refused", reason: "a composite definition holds no source" };
    default: {
      const outs = new Set(definition.exits.map((exit) => exit.id));
      const result = applyChange({ nodes: definition.blocks }, change, composites, outs);
      if (result._tag === "Refused") return result;
      return {
        _tag: "Changed",
        definition: { ...definition, blocks: result.pipeline.nodes },
        added: result.added,
        composites: result.composites,
      };
    }
  }
};

/**
 * Packs the selected blocks into a new definition named `change.name`. A
 * definition draft passes its entry, which no wire in the drawing names.
 */
const madeComposite = (
  pipeline: Drawing,
  change: { readonly ids: ReadonlyArray<string>; readonly name: string },
  composites: Composites,
  definitionEntry?: string,
):
  | {
      readonly _tag: "Changed";
      readonly pipeline: Drawing;
      readonly id: string;
      readonly composites: Composites;
    }
  | { readonly _tag: "Refused"; readonly reason: string } => {
  if (composites[change.name] !== undefined) {
    return { _tag: "Refused", reason: `a composite named ${change.name} already exists` };
  }
  const made = makeComposite(pipeline, change.ids, change.name, composites, definitionEntry);
  return made._tag === "Refused"
    ? made
    : {
        _tag: "Changed",
        pipeline: made.pipeline,
        id: made.id,
        composites: { [change.name]: made.definition },
      };
};

/**
 * Why an exit cannot be added, renamed to `name`, or (with no name) removed on
 * block `id`: a check's exits are fixed, and two exits of one block may not
 * share a name, since a port names its exit by name.
 */
const exitRefusal = (pipeline: Drawing, id: string, name: string | undefined) => {
  const node = pipeline.nodes.find((one) => one.id === id);
  if (node?.kind === "check") return `${id} is a check, and a check's exits are passed and failed`;
  if (node?.kind === "agent" && node.exits.some((exit) => exit.name === name)) {
    return `${id} already has an exit named ${name}`;
  }
  return undefined;
};
