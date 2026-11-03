// The changes an operator makes to a pipeline, as data an editor can send, and
// the pure step that applies one. Every change itself is `pipeline-belt`'s;
// this module names each one, so herdr-web's editor and `foreman pipeline
// edit` decode the same changes.
import { Schema as S } from "effect";
import { AgentNode, LANDINGS, type Pipeline } from "./pipeline.ts";
import {
  addRoute,
  addSource,
  configure,
  INSERTABLE,
  insertOn,
  rejoin,
  remove,
  removeRoute,
  swapEnd,
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

/** What a block does, as `configure` takes it. */
export const BlockSetting = S.Union([
  S.Struct({ filter: S.String }),
  S.Struct({ step: S.Literals(STEPS) }),
  S.Struct({
    role: S.Literals(["author", "review"]),
    model: S.String,
    slots: AgentNode.fields.slots,
  }),
  S.Struct({ route: S.Int, when: S.String }),
  S.Struct({ command: S.String }),
  S.Struct({ how: S.Literals(LANDINGS) }),
]);
export type BlockSetting = typeof BlockSetting.Type;

/** One change to a pipeline. */
export const PipelineChange = S.Union([
  S.TaggedStruct("InsertOn", { wire: WireRef, kind: S.Literals(INSERTABLE) }),
  S.TaggedStruct("Remove", { id: S.String }),
  S.TaggedStruct("AddRoute", { router: S.String, when: S.String }),
  S.TaggedStruct("RemoveRoute", { router: S.String, index: S.Int }),
  S.TaggedStruct("Rejoin", { wire: WireRef, to: S.String }),
  S.TaggedStruct("AddSource", { filter: S.String }),
  S.TaggedStruct("SwapEnd", { id: S.String }),
  S.TaggedStruct("Configure", { id: S.String, setting: BlockSetting }),
]);
export type PipelineChange = typeof PipelineChange.Type;

/**
 * The pipeline after `change`, and the id of the block it added, if any. A
 * change the pipeline cannot take answers `refused`: a rejoin that would close
 * a loop, or one that names a block the pipeline lacks. A change that names a
 * block or wire the pipeline lacks otherwise leaves it as it was.
 */
export const applyChange = (
  pipeline: Pipeline,
  change: PipelineChange,
):
  | { readonly _tag: "Changed"; readonly pipeline: Pipeline; readonly added: string | undefined }
  | { readonly _tag: "Refused"; readonly reason: string } => {
  const changed = (next: Pipeline, added?: string) =>
    ({ _tag: "Changed", pipeline: next, added: added === "" ? undefined : added }) as const;
  switch (change._tag) {
    case "InsertOn": {
      const inserted = insertOn(pipeline, change.wire, change.kind);
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
            reason: `${change.wire.from} cannot lead to ${change.to}: that would close a loop, or one of them is not in the pipeline`,
          };
    }
    case "AddSource": {
      const added = addSource(pipeline, change.filter);
      return changed(added.pipeline, added.id);
    }
    case "SwapEnd":
      return changed(swapEnd(pipeline, change.id));
    case "Configure":
      return changed(configure(pipeline, change.id, change.setting));
  }
};
