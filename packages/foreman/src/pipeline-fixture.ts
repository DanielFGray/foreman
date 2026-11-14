import { expand } from "./composite.ts";
import type { Drawing, Pipeline } from "./pipeline.ts";
import { insertOn } from "./pipeline-belt.ts";

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
