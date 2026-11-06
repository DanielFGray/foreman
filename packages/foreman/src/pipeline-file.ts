import { Effect, FileSystem, Option, Schema as S } from "effect";
import { expand } from "./composite.ts";
import {
  Composites,
  DEFAULT_PIPELINE,
  Drawing,
  instructionProblems,
  type Pipeline,
  problemsOf,
  type SeatOffers,
} from "./pipeline.ts";
import { pipelinesPath } from "./paths.ts";
import { type Read, rewrite } from "./shared-file.ts";

/**
 * The drawings the operator made, one per project, in a file of their own
 * beside the policy.
 *
 * A project with no entry runs the default pipeline. The file sits in the
 * policy's directory, so the dispatcher's watch on that directory sees a
 * change to either file.
 */
export const Pipelines = S.Record(S.String, Drawing);
export type Pipelines = typeof Pipelines.Type;

/**
 * The file as written: the drawings and the composite definitions. A missing
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

/** Rewrites the drawings through `change`, keeping the composites as they are. */
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
 * Expansion of a project's drawing: either the engine pipeline, or the
 * expansion problems. Callers that need the drawing as written read
 * `pipelines[project]` themselves (`standardOf`, draft base).
 */
export type PipelineReading =
  | { readonly _tag: "Expanded"; readonly pipeline: Pipeline; readonly drawn: boolean }
  | { readonly _tag: "Failed"; readonly problems: ReadonlyArray<string>; readonly drawn: boolean };

/**
 * Expand the drawing `project` runs. A tagged result: never an unexpanded
 * pipeline beside problems.
 */
export const pipelineFor = (file: PipelinesFile, project: string): PipelineReading => {
  const drawn = file.pipelines[project];
  if (drawn === undefined) {
    return { _tag: "Expanded", pipeline: DEFAULT_PIPELINE, drawn: false };
  }
  const result = expand(drawn, file.composites);
  return result._tag === "Failed"
    ? { _tag: "Failed", problems: result.problems, drawn: true }
    : { _tag: "Expanded", pipeline: result.pipeline, drawn: true };
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
 * What `project` runs from one expansion reading, checked against these offers
 * and the instructions texts for its agent blocks.
 */
export const projectPipeline = (
  reading: PipelineReading,
  fileError: string | undefined,
  offers: SeatOffers,
  instructions: ReadonlyMap<string, string>,
): ProjectPipeline => {
  if (fileError !== undefined) return { _tag: "Stopped", problems: [fileError] };
  if (reading._tag === "Failed") return { _tag: "Stopped", problems: reading.problems };
  const problems = [
    ...problemsOf(reading.pipeline, offers),
    ...instructionProblems(reading.pipeline, instructions),
  ];
  return problems.length > 0
    ? { _tag: "Stopped", problems }
    : { _tag: "Runs", pipeline: reading.pipeline, drawn: reading.drawn };
};
