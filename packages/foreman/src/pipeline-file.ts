import { Effect, FileSystem, Option, Schema as S } from "effect";
import { Pipeline, problemsOf, STANDARD_PIPELINE } from "./pipeline.ts";
import { configDirectory, rewrite } from "./shared-file.ts";

/**
 * The pipelines the operator drew, one per project, in a file of their own
 * beside the policy.
 *
 * A project with no entry runs the standard pipeline. The file sits in the
 * policy's directory, so the dispatcher's watch on that directory sees a
 * change to either file.
 */
export const Pipelines = S.Record(S.String, Pipeline);
export type Pipelines = typeof Pipelines.Type;

/** Where the pipelines live: `$FOREMAN_PIPELINES`, else beside the policy. */
export const pipelinesPath = (): string =>
  process.env["FOREMAN_PIPELINES"] ?? `${configDirectory()}/pipelines.json`;

/**
 * The pipelines as the file states them.
 *
 * A missing file holds none, so every project runs the standard pipeline. A
 * file that does not decode holds none either, with the reason: what reads it
 * decides what an unreadable drawing stops.
 */
export const readPipelines = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return { value: {}, error: undefined, text: undefined };
    return yield* S.decodeEffect(S.fromJsonString(Pipelines))(text.value).pipe(
      Effect.map((value) => ({ value, error: undefined, text: text.value })),
      Effect.catch((error) =>
        Effect.succeed({
          value: {},
          error: `${path} does not decode: ${error.message}`,
          text: text.value,
        }),
      ),
    );
  });

/** Rewrites the pipelines through `change`, the one way anything writes them. */
export const updatePipelines = (path: string, change: (pipelines: Pipelines) => Pipelines) =>
  rewrite(path, Pipelines, readPipelines, change);

/** The pipeline `project` runs, and whether the operator drew it. */
export const pipelineFor = (
  pipelines: Pipelines,
  project: string,
): { readonly pipeline: Pipeline; readonly drawn: boolean } => {
  const drawn = pipelines[project];
  return drawn === undefined
    ? { pipeline: STANDARD_PIPELINE, drawn: false }
    : { pipeline: drawn, drawn: true };
};

/**
 * A project's pipeline as one reading found it.
 *
 * A stopped project takes no step, and `problems` says why: its drawing fails
 * validation, or the file does not decode. It never runs the standard pipeline
 * instead, because a flow the operator did not draw is worse than stopping.
 */
export type ProjectPipeline =
  | { readonly _tag: "Runs"; readonly pipeline: Pipeline; readonly drawn: boolean }
  | { readonly _tag: "Stopped"; readonly problems: ReadonlyArray<string> };

/** What `project` runs, from one reading of the file, checked against these rungs. */
export const projectPipeline = (
  read: { readonly value: Pipelines; readonly error: string | undefined },
  project: string,
  rungs: ReadonlyArray<string>,
): ProjectPipeline => {
  if (read.error !== undefined) return { _tag: "Stopped", problems: [read.error] };
  const { pipeline, drawn } = pipelineFor(read.value, project);
  const problems = problemsOf(pipeline, rungs);
  return problems.length > 0 ? { _tag: "Stopped", problems } : { _tag: "Runs", pipeline, drawn };
};
