import { Command, CommandExecutor } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Schema } from "effect";

/**
 * The git checkout a project's tasks branch from and merge back into.
 *
 * Foreman shares this directory with the operator, who edits in it while the
 * fleet runs. It is the one place where agents and a person can collide, so
 * foreman asks git whether the operator is presently working there.
 */
export class Repository extends Effect.Service<Repository>()("Repository", {
  dependencies: [BunContext.layer],
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;

    return {
      /**
       * Whether the checkout is free for foreman to work against.
       *
       * Tracked changes only. Untracked files are scratch notes, build output
       * and editor leavings that sit in a repository for months; counting them
       * would hold a project back forever. A staged or unstaged change to a
       * file git already follows is the operator mid-edit, and is exactly what
       * a merge into this checkout would collide with.
       */
      isClean: (directory: string) =>
        executor
          .string(
            Command.make("git", "-C", directory, "status", "--porcelain", "--untracked-files=no"),
          )
          .pipe(
            Effect.map((out) => out.trim() === ""),
            Effect.mapError(
              (cause) => new RepositoryError({ directory, detail: String(cause) }),
            ),
          ),
    } as const;
  }),
}) {}

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  directory: Schema.String,
  detail: Schema.String,
}) {}
