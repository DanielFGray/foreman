// The changes an operator makes to a pipeline, as data an editor can send, and
// the pure step that applies one. Every change itself is `pipeline-belt`'s;
// this module names each one, so the pane's editor and `foreman pipeline
// edit` decode the same changes.
import { Schema as S } from "effect";
import {
  AgentNode,
  type Composites,
  Exit,
  LandNode,
  LANDINGS,
  ParamValue,
  type Drawing,
} from "./pipeline.ts";
import {
  addExit,
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
  removeRoute,
  renameExit,
  setEmpty,
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

export type ApplyResult =
  | {
      readonly _tag: "Changed";
      readonly pipeline: Drawing;
      readonly added: string | undefined;
      /** Definitions the change created, for the draft to carry. Empty when it created none. */
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
 */
export const applyChange = (
  pipeline: Drawing,
  change: PipelineChange,
  composites: Composites = {},
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
      const rejoined = rejoin(pipeline, change.wire, change.to);
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
      if (composites[change.name] !== undefined) {
        return {
          _tag: "Refused",
          reason: `a composite named ${change.name} already exists`,
        };
      }
      const made = makeComposite(pipeline, change.ids, change.name, composites);
      return made._tag === "Refused"
        ? made
        : changed(made.pipeline, made.id, { [change.name]: made.definition });
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
