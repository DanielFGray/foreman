// The pipelines the operator is still drawing: one draft per project, in a
// file beside the pipelines file. A draft may have problems, such as a new
// check that names no command yet, so it never goes in the pipelines file,
// which the dispatcher runs. Saving checks it and writes it there.
import { Effect, FileSystem, Option, Schema as S } from "effect";
import { Pipeline } from "./pipeline.ts";
import { pipelinesPath } from "./pipeline-file.ts";
import { type Read, rewrite } from "./shared-file.ts";

/**
 * A project's draft, and the pipeline the operator had drawn when it began:
 * none when the project ran the standard pipeline. Saving compares that with
 * the pipeline drawn now, so a draft never overwrites a change made since.
 */
export const Draft = S.Struct({ base: S.NullOr(Pipeline), pipeline: Pipeline });
export type Draft = typeof Draft.Type;

export const Drafts = S.Record(S.String, Draft);
export type Drafts = typeof Drafts.Type;

const DraftsFile = S.Struct({ version: S.Literal(1), drafts: Drafts });
type DraftsFile = typeof DraftsFile.Type;

/** Where the drafts live: beside the pipelines file, named after it. */
export const draftsPath = (): string => pipelinesPath().replace(/(\.json)?$/, ".draft.json");

export const readDrafts = (path: string) =>
  readFile(path).pipe(Effect.map((read): Read<Drafts> => ({ ...read, value: read.value.drafts })));

/** Rewrites the drafts through `change`, the one way anything writes them. */
export const updateDrafts = (path: string, change: (drafts: Drafts) => Drafts) =>
  rewrite(path, DraftsFile, readFile, (file) => ({
    version: 1 as const,
    drafts: change(file.drafts),
  }));

/** Whether two pipelines are the same drawing, compared as the file stores them. */
export const sameDrawing = (one: Pipeline | null, other: Pipeline | null): boolean =>
  JSON.stringify(one === null ? null : S.encodeSync(Pipeline)(one)) ===
  JSON.stringify(other === null ? null : S.encodeSync(Pipeline)(other));

const NONE: DraftsFile = { version: 1, drafts: {} };

const readFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return { value: NONE, error: undefined, text: undefined };
    return yield* S.decodeEffect(S.fromJsonString(DraftsFile))(text.value).pipe(
      Effect.map((value): Read<DraftsFile> => ({ value, error: undefined, text: text.value })),
      Effect.catch((error) =>
        Effect.succeed<Read<DraftsFile>>({
          value: NONE,
          error: `${path} does not decode: ${error.message}`,
          text: text.value,
        }),
      ),
    );
  });
