import { Effect, FileSystem, Option, Schema as S } from "effect";
import { expand } from "./composite.ts";
import {
  Composites,
  DEFAULT_PIPELINE,
  instructionProblems,
  Pipeline,
  problemsOf,
  type SeatOffers,
} from "./pipeline.ts";
import { pipelinesPath } from "./paths.ts";
import { type Read, rewrite } from "./shared-file.ts";

/**
 * The pipelines the operator drew, one per project, in a file of their own
 * beside the policy.
 *
 * A project with no entry runs the default pipeline. The file sits in the
 * policy's directory, so the dispatcher's watch on that directory sees a
 * change to either file.
 */
export const Pipelines = S.Record(S.String, Pipeline);
export type Pipelines = typeof Pipelines.Type;

/**
 * The file as written: the pipelines and the composite definitions. A missing
 * `composites` key decodes as none, so older files keep reading.
 */
export const PipelinesFile = S.Struct({
  pipelines: Pipelines,
  composites: Composites.pipe(S.withDecodingDefault(Effect.succeed({}))),
});
export type PipelinesFile = typeof PipelinesFile.Type;

export { pipelinesPath };

/**
 * The pipelines file as stored: each project's drawing and the composite
 * definitions beside them.
 *
 * A missing file holds none, so every project runs the standard pipeline. A
 * file that does not decode holds none either, with the reason: what reads it
 * decides what an unreadable drawing stops.
 */
export const readPipelines = (path: string) =>
  readFile(path).pipe(
    Effect.map((read): Read<PipelinesFile> => ({
      ...read,
      value: read.value,
    })),
  );

/** Rewrites the pipelines through `change`, keeping the composites as they are. */
export const updatePipelines = (path: string, change: (pipelines: Pipelines) => Pipelines) =>
  rewrite(path, PipelinesFile, readFile, (file) => ({
    ...file,
    pipelines: change(file.pipelines),
  }));

const NONE: PipelinesFile = { pipelines: {}, composites: {} };

/** The file as stored. */
const readFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return { value: NONE, error: undefined, text: undefined };
    return yield* S.decodeEffect(S.fromJsonString(PipelinesFile))(text.value).pipe(
      Effect.map((value): Read<PipelinesFile> => ({ value, error: undefined, text: text.value })),
      Effect.catch((error) =>
        Effect.succeed<Read<PipelinesFile>>({
          value: NONE,
          error: `${path} does not decode: ${error.message}`,
          text: text.value,
        }),
      ),
    );
  });

/**
 * The pipeline `project` runs after expansion, whether the operator drew it,
 * and any expansion problems. Callers that need the drawing as written read
 * `pipelines[project]` themselves (`standardOf`, draft base).
 */
export const pipelineFor = (
  file: PipelinesFile,
  project: string,
): {
  readonly pipeline: Pipeline;
  readonly drawn: boolean;
  readonly problems: ReadonlyArray<string>;
} => {
  const drawn = file.pipelines[project];
  if (drawn === undefined) {
    return { pipeline: DEFAULT_PIPELINE, drawn: false, problems: [] };
  }
  const result = expand(drawn, file.composites);
  return result._tag === "Failed"
    ? { pipeline: drawn, drawn: true, problems: result.problems }
    : { pipeline: result.pipeline, drawn: true, problems: [] };
};

/**
 * A project's pipeline as one reading found it.
 *
 * A stopped project takes no step, and `problems` says why: its drawing fails
 * validation, or the file does not decode. It never runs the standard pipeline
 * instead, because a flow the operator did not draw is worse than stopping.
 * A definition that decodes but fails expansion stops only the projects that
 * use it.
 */
export type ProjectPipeline =
  | { readonly _tag: "Runs"; readonly pipeline: Pipeline; readonly drawn: boolean }
  | { readonly _tag: "Stopped"; readonly problems: ReadonlyArray<string> };

/**
 * What `project` runs, from one reading of the file, expanded, then checked
 * against these offers and the instructions texts read for its agent blocks.
 */
export const projectPipeline = (
  read: { readonly value: PipelinesFile; readonly error: string | undefined },
  project: string,
  offers: SeatOffers,
  instructions: ReadonlyMap<string, string>,
): ProjectPipeline => {
  if (read.error !== undefined) return { _tag: "Stopped", problems: [read.error] };
  const { pipeline, drawn, problems: expandProblems } = pipelineFor(read.value, project);
  if (expandProblems.length > 0) return { _tag: "Stopped", problems: expandProblems };
  const problems = [
    ...problemsOf(pipeline, offers),
    ...instructionProblems(pipeline, instructions),
  ];
  return problems.length > 0 ? { _tag: "Stopped", problems } : { _tag: "Runs", pipeline, drawn };
};
