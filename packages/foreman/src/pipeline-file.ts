import { Effect, FileSystem, Option, Schema as S } from "effect";
import {
  DEFAULT_PIPELINE,
  instructionProblems,
  Pipeline,
  problemsOf,
  type SeatOffers,
} from "./pipeline.ts";
import { configDirectory, type Read, rewrite } from "./shared-file.ts";

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
 * The file as written: the pipelines under the format's version. A file in an
 * older form does not decode, and so stops every project: `foreman cutover
 * exit-ids` (`src/cutover-exits.ts`) converts it once, and nothing else reads
 * the older forms.
 */
export const PipelinesFile = S.Struct({ version: S.Literal(5), pipelines: Pipelines });
export type PipelinesFile = typeof PipelinesFile.Type;

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
  readFile(path).pipe(
    Effect.map((read): Read<Pipelines> => ({ ...read, value: read.value.pipelines })),
  );

/** Rewrites the pipelines through `change`, the one way anything writes them. */
export const updatePipelines = (path: string, change: (pipelines: Pipelines) => Pipelines) =>
  rewrite(path, PipelinesFile, readFile, (file) => ({
    version: 5 as const,
    pipelines: change(file.pipelines),
  }));

const NONE: PipelinesFile = { version: 5, pipelines: {} };

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
/** The pipeline `project` runs, and whether the operator drew it. */
export const pipelineFor = (
  pipelines: Pipelines,
  project: string,
): { readonly pipeline: Pipeline; readonly drawn: boolean } => {
  const drawn = pipelines[project];
  return drawn === undefined
    ? { pipeline: DEFAULT_PIPELINE, drawn: false }
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

/**
 * What `project` runs, from one reading of the file, checked against these
 * offers and the instructions texts read for its agent blocks.
 */
export const projectPipeline = (
  read: { readonly value: Pipelines; readonly error: string | undefined },
  project: string,
  offers: SeatOffers,
  instructions: ReadonlyMap<string, string>,
): ProjectPipeline => {
  if (read.error !== undefined) return { _tag: "Stopped", problems: [read.error] };
  const { pipeline, drawn } = pipelineFor(read.value, project);
  const problems = [
    ...problemsOf(pipeline, offers),
    ...instructionProblems(pipeline, instructions),
  ];
  return problems.length > 0 ? { _tag: "Stopped", problems } : { _tag: "Runs", pipeline, drawn };
};
