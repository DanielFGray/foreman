// The pipelines the operator is still drawing: one draft per project, in a
// file beside the pipelines file. A draft may have problems, such as a new
// check that names no command yet, so it never goes in the pipelines file,
// which the dispatcher runs. Saving checks it and writes it there.
import { Effect, FileSystem, Option, Schema as S } from "effect";
import { Pipeline } from "./pipeline.ts";
import { pipelinesPath, withReviewers } from "./pipeline-file.ts";
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

/**
 * The file as written. Version 1 drew the review rule `above`; it reads as
 * `reviewers` (`withReviewers`), as the pipelines file does, so a draft's base
 * still matches the drawn pipeline it began from.
 */
const DraftsFile = S.Struct({ version: S.Literal(2), drafts: Drafts });
type DraftsFile = typeof DraftsFile.Type;
const V1File = S.Struct({ version: S.Literal(1), drafts: Drafts });

/** Where the drafts live: beside the pipelines file, named after it. */
export const draftsPath = (): string => pipelinesPath().replace(/(\.json)?$/, ".draft.json");

export const readDrafts = (path: string) =>
  readFile(path).pipe(Effect.map((read): Read<Drafts> => ({ ...read, value: read.value.drafts })));

/** Rewrites the drafts through `change`, the one way anything writes them. */
export const updateDrafts = (path: string, change: (drafts: Drafts) => Drafts) =>
  rewrite(path, DraftsFile, readFile, (file) => ({
    version: 2 as const,
    drafts: change(file.drafts),
  }));

/** Whether two pipelines are the same drawing, compared as the file stores them. */
export const sameDrawing = (one: Pipeline | null, other: Pipeline | null): boolean =>
  JSON.stringify(one === null ? null : S.encodeSync(Pipeline)(one)) ===
  JSON.stringify(other === null ? null : S.encodeSync(Pipeline)(other));

const NONE: DraftsFile = { version: 2, drafts: {} };

const readFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return { value: NONE, error: undefined, text: undefined };
    return yield* S.decodeEffect(S.fromJsonString(DraftsFile))(text.value).pipe(
      Effect.catch((current) =>
        S.decodeEffect(S.fromJsonString(V1File))(text.value).pipe(
          Effect.map((old): DraftsFile => ({
            version: 2,
            drafts: Object.fromEntries(
              Object.entries(old.drafts).map(([project, draft]) => [
                project,
                {
                  base: draft.base === null ? null : withReviewers(draft.base),
                  pipeline: withReviewers(draft.pipeline),
                },
              ]),
            ),
          })),
          Effect.mapError(() => current),
        ),
      ),
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
