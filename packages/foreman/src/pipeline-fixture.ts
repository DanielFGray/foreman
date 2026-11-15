import { expand } from "./composite.ts";
import { type Drawing, EMPTY_PIPELINE, type Pipeline } from "./pipeline.ts";
import { insertOn } from "./pipeline-belt.ts";
import { applyChange, type PipelineChange } from "./pipeline-edit.ts";

/**
 * The engine pipeline of a drawing that holds no composite instance, for
 * tests of the engine. A drawing that fails to expand is a broken fixture, so
 * it throws rather than returning a pipeline that hides the problems.
 */
export const pipelineOf = (drawing: Drawing): Pipeline => {
  const result = expand(drawing, {});
  if (result._tag === "Failed") throw new Error(result.problems.join("; "));
  return result.pipeline;
};

/** `insertOn` for a wire the fixture has, so a test reads the result directly. */
export const insertedOn = (...args: Parameters<typeof insertOn>) => {
  const inserted = insertOn(...args);
  if (inserted === undefined) throw new Error(`no way out ${args[1].from} ${args[1].port}`);
  return inserted;
};

/**
 * The standard checkout pipeline, built from nothing the way an operator
 * builds one: place each block by name, set it, then wire it.
 */
export const CHECKOUT_BUILD: ReadonlyArray<PipelineChange> = [
  { _tag: "Place", kind: "source", id: "queue" },
  { _tag: "Place", kind: "branch", id: "branch" },
  { _tag: "Rejoin", wire: { from: "queue", port: "next" }, to: "branch" },
  { _tag: "Place", kind: "router", id: "retry" },
  { _tag: "Rejoin", wire: { from: "branch", port: "next" }, to: "retry" },
  { _tag: "Place", kind: "gate", id: "start" },
  { _tag: "Place", kind: "gate", id: "climb" },
  { _tag: "Configure", id: "climb", setting: { kind: "gate", step: "climb" } },
  { _tag: "Rejoin", wire: { from: "retry", port: "else" }, to: "start" },
  { _tag: "AddRoute", router: "retry", when: "failed" },
  { _tag: "AddRoute", router: "retry", when: "attempts>=1" },
  { _tag: "Rejoin", wire: { from: "retry", port: 0 }, to: "climb" },
  { _tag: "Rejoin", wire: { from: "retry", port: 1 }, to: "climb" },
  { _tag: "Place", kind: "agent", id: "author" },
  { _tag: "Rejoin", wire: { from: "start", port: "next" }, to: "author" },
  { _tag: "Rejoin", wire: { from: "climb", port: "next" }, to: "author" },
  { _tag: "Place", kind: "gate", id: "review-gate" },
  { _tag: "Configure", id: "review-gate", setting: { kind: "gate", step: "review" } },
  { _tag: "Rejoin", wire: { from: "author", port: "exit:done" }, to: "review-gate" },
  { _tag: "Rejoin", wire: { from: "author", port: "exit:already-done" }, to: "review-gate" },
  { _tag: "Place", kind: "agent", id: "review" },
  {
    _tag: "Configure",
    id: "review",
    setting: { kind: "agent", role: "review", model: "reviewers" },
  },
  { _tag: "RenameExit", id: "review", name: "done", to: "approved" },
  { _tag: "RenameExit", id: "review", name: "already-done", to: "returned" },
  { _tag: "ChargeExit", id: "review", name: "returned", fails: "author" },
  { _tag: "Rejoin", wire: { from: "review-gate", port: "next" }, to: "review" },
  { _tag: "Rejoin", wire: { from: "review", port: "exit:returned" }, to: "climb" },
  { _tag: "Place", kind: "gate", id: "land-gate" },
  { _tag: "Configure", id: "land-gate", setting: { kind: "gate", step: "land" } },
  { _tag: "Rejoin", wire: { from: "review", port: "exit:approved" }, to: "land-gate" },
  { _tag: "Place", kind: "land", id: "land" },
  { _tag: "Configure", id: "land", setting: { kind: "land", how: "merge", onto: undefined } },
  { _tag: "Rejoin", wire: { from: "land-gate", port: "next" }, to: "land" },
];

/** Each drawing the build passes through, the empty one first. */
export const stagesOf = (changes: ReadonlyArray<PipelineChange>): ReadonlyArray<Drawing> =>
  changes.reduce<ReadonlyArray<Drawing>>(
    (stages, change) => {
      const result = applyChange(stages.at(-1)!, change);
      if (result._tag === "Refused") throw new Error(`${change._tag}: ${result.reason}`);
      return [...stages, result.pipeline];
    },
    [EMPTY_PIPELINE],
  );

/** The drawings `CHECKOUT_BUILD` passes through, the empty one first. */
export const CHECKOUT_STAGES = stagesOf(CHECKOUT_BUILD);
