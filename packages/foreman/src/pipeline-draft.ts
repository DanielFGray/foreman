// The pipelines the operator is still drawing: one draft per project, in a
// file beside the pipelines file. A draft may have problems, such as a new
// check that names no command yet, so it never goes in the pipelines file,
// which the dispatcher runs. Saving checks it and writes it there.
import { Effect, FileSystem, Option, Schema as S } from "effect";
import { draftsPath } from "./paths.ts";
import { Pipeline } from "./pipeline.ts";
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

/** The file as written: the drafts under one key. */
export const DraftsFile = S.Struct({ drafts: Drafts });
export type DraftsFile = typeof DraftsFile.Type;

export { draftsPath };

export const readDrafts = (path: string) =>
  readFile(path).pipe(Effect.map((read): Read<Drafts> => ({ ...read, value: read.value.drafts })));

/** Rewrites the drafts through `change`, the one way anything writes them. */
export const updateDrafts = (path: string, change: (drafts: Drafts) => Drafts) =>
  rewrite(path, DraftsFile, readFile, (file) => ({ drafts: change(file.drafts) }));

/** Whether two pipelines are the same drawing, compared as the file stores them. */
export const sameDrawing = (one: Pipeline | null, other: Pipeline | null): boolean =>
  JSON.stringify(one === null ? null : S.encodeSync(Pipeline)(one)) ===
  JSON.stringify(other === null ? null : S.encodeSync(Pipeline)(other));

const NONE: DraftsFile = { drafts: {} };

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
