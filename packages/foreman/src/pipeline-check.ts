// What a pipeline must pass before it runs, shared by every command that
// writes one: `foreman pipeline` for a project, and `foreman composite` for a
// definition every project's pipeline reaches. Both read the same ladder,
// reviewers and instructions, so a save of either cannot pass what the other
// refuses.
import { Effect } from "effect";
import { expand } from "./composite.ts";
import {
  type Composites,
  type Drawing,
  instructionNames,
  instructionProblems,
  offersOf,
  type Pipeline,
  problemsOf,
} from "./pipeline.ts";
import { pipelinesPath, readPipelines } from "./pipeline-file.ts";
import { PipelineError } from "./pipeline-error.ts";
import { Prompts } from "./prompt.ts";
import { readLadder, readReviewers } from "./registry.ts";

/** The pipelines file as stored. A file that does not decode stops every project. */
export const pipelinesNow = Effect.gen(function* () {
  const read = yield* readPipelines(pipelinesPath());
  if (read.error !== undefined) return yield* new PipelineError({ detail: read.error });
  return read.value;
});

/**
 * The problems that stop `pipeline` running: against the ladder and the
 * reviewers, and in the instructions files its agent blocks read.
 */
export const problemsAgainstLadder = (pipeline: Pipeline) =>
  Effect.gen(function* () {
    const seats = { ladder: yield* readLadder, reviewers: yield* readReviewers };
    const texts = yield* (yield* Prompts).instructions(instructionNames(pipeline));
    return [...problemsOf(pipeline, offersOf(seats)), ...instructionProblems(pipeline, texts)];
  }).pipe(Effect.provide(Prompts.Default));

/** The problems that stop `drawing` running with these definitions: the expansion's, else the ladder's. */
export const problemsOfDrawing = (drawing: Drawing, composites: Composites) =>
  Effect.gen(function* () {
    const expanded = expand(drawing, composites);
    if (expanded._tag === "Failed") return [...expanded.problems];
    return yield* problemsAgainstLadder(expanded.pipeline);
  });
