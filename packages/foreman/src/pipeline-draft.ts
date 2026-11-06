// The pipelines the operator is still drawing: one draft per project, in a
// file beside the pipelines file. A draft may have problems, such as a new
// check that names no command yet, so it never goes in the pipelines file,
// which the dispatcher runs. Saving checks it and writes it there.
//
// The file also holds composite definitions being edited, each with the
// definition it began from (`base`), as a project draft does
// (`docs/composite-blocks.md`).
import { Effect, FileSystem, Option, Schema as S } from "effect";
import { draftsPath } from "./paths.ts";
import { CompositeDefinition, Composites, Drawing } from "./pipeline.ts";
import { type Read, rewrite } from "./shared-file.ts";

/**
 * A project's draft, and the drawing the operator had when it began: none when
 * the project ran the standard pipeline. Saving compares that with the drawing
 * now, so a draft never overwrites a change made since.
 *
 * `composites` holds definitions MakeComposite added with this draft, so a
 * save writes both the drawing and those definitions (`docs/composite-blocks.md`).
 *
 * `bases` is the composite definitions as the file held them when the draft
 * began. A save refuses when a definition the draft uses has changed since.
 */
export const Draft = S.Struct({
  base: S.NullOr(Drawing),
  pipeline: Drawing,
  composites: Composites.pipe(S.withDecodingDefault(Effect.succeed({}))),
  bases: Composites.pipe(S.withDecodingDefault(Effect.succeed({}))),
});
export type Draft = typeof Draft.Type;

export const Drafts = S.Record(S.String, Draft);
export type Drafts = typeof Drafts.Type;

/**
 * A composite definition draft: the definition under edit, and the one it
 * began from (`base`), none when it is new.
 *
 * `composites` holds nested definitions MakeComposite added while editing this
 * one, written beside it on save (`docs/composite-blocks.md`).
 */
export const CompositeDraft = S.Struct({
  base: S.NullOr(CompositeDefinition),
  definition: CompositeDefinition,
  composites: Composites.pipe(S.withDecodingDefault(Effect.succeed({}))),
});
export type CompositeDraft = typeof CompositeDraft.Type;

export const CompositeDrafts = S.Record(S.String, CompositeDraft);
export type CompositeDrafts = typeof CompositeDrafts.Type;

/** The file as written: the project drafts and the composite definition drafts. */
export const DraftsFile = S.Struct({
  drafts: Drafts,
  composites: CompositeDrafts.pipe(S.withDecodingDefault(Effect.succeed({}))),
});
export type DraftsFile = typeof DraftsFile.Type;

export { draftsPath };

export const readDrafts = (path: string) =>
  readFile(path).pipe(Effect.map((read): Read<Drafts> => ({ ...read, value: read.value.drafts })));

export const readDraftsFile = (path: string) => readFile(path);

/** Rewrites the project drafts through `change`, keeping composite drafts as they are. */
export const updateDrafts = (path: string, change: (drafts: Drafts) => Drafts) =>
  rewrite(path, DraftsFile, readFile, (file) => ({
    ...file,
    drafts: change(file.drafts),
  }));

/** Rewrites the composite definition drafts, keeping project drafts as they are. */
export const updateCompositeDrafts = (
  path: string,
  change: (composites: CompositeDrafts) => CompositeDrafts,
) =>
  rewrite(path, DraftsFile, readFile, (file) => ({
    ...file,
    composites: change(file.composites),
  }));

/** Whether two drawings are the same, compared as the file stores them. */
export const sameDrawing = (one: Drawing | null, other: Drawing | null): boolean =>
  JSON.stringify(one === null ? null : S.encodeSync(Drawing)(one)) ===
  JSON.stringify(other === null ? null : S.encodeSync(Drawing)(other));

/** Whether two composite definitions are the same, compared as the file stores them. */
export const sameDefinition = (
  one: CompositeDefinition | null,
  other: CompositeDefinition | null,
): boolean =>
  JSON.stringify(one === null ? null : S.encodeSync(CompositeDefinition)(one)) ===
  JSON.stringify(other === null ? null : S.encodeSync(CompositeDefinition)(other));

const NONE: DraftsFile = { drafts: {}, composites: {} };

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
