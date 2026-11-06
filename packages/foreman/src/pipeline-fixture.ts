import { expand } from "./composite.ts";
import type { Drawing, Pipeline } from "./pipeline.ts";

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
