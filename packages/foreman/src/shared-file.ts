import { Effect, FileSystem, Option, Path, Schema as S } from "effect";

/** A file as read: its value, why it could not be read when it could not, and its text. */
export interface Read<A> {
  readonly value: A;
  readonly error: string | undefined;
  readonly text: string | undefined;
}

/**
 * Rewrites a file that foreman and the operator both write, through `change`.
 *
 * The dispatcher and the operator's commands write the same file from
 * different processes. So the file is read again just before the rename, and a
 * write that finds it changed since its own read starts over from the new
 * contents instead of overwriting them. That narrows the race to the moment
 * between the second read and the rename; it does not close it, and nothing
 * here holds a lock. Losing it loses one write, which the next reading shows
 * did not happen. A file that does not decode is refused: the operator's broken
 * edit is theirs to fix, not foreman's to replace.
 */
export const rewrite = <A, I, E, R>(
  path: string,
  schema: S.Codec<A, I>,
  read: (path: string) => Effect.Effect<Read<A>, E, R>,
  change: (value: A) => A,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    // One temporary per write: several processes write this file, and two
    // sharing a name would rename each other's text into place.
    const temporary = paths.join(
      paths.dirname(path),
      `.${paths.basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = yield* read(path);
      if (before.error !== undefined) return yield* new RewriteError({ detail: before.error });
      const next = change(before.value);
      const text = `${JSON.stringify(yield* S.encodeEffect(schema)(next), null, 2)}\n`;
      if (text === before.text) return next;
      yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
      yield* fs.writeFileString(temporary, text);
      const now = yield* fs.readFileString(path).pipe(Effect.option);
      if (Option.getOrUndefined(now) !== before.text) {
        yield* fs.remove(temporary);
        continue;
      }
      yield* fs.rename(temporary, path);
      return next;
    }
    return yield* new RewriteError({ detail: `${path} kept changing under the write` });
  });

export class RewriteError extends S.TaggedError<RewriteError>()("RewriteError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

export { configDirectory } from "./paths.ts";
