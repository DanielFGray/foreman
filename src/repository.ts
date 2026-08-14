import { Command, CommandExecutor } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Schema, Stream } from "effect";

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

    const exec = (directory: string, ...args: Array<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(
            Command.make("git", "-C", directory, ...args).pipe(
              Command.stdout("pipe"),
              Command.stderr("pipe"),
            ),
          );
          const [exitCode, stdout, stderr] = yield* Effect.all(
            [
              process.exitCode,
              Stream.decodeText(process.stdout).pipe(Stream.mkString),
              Stream.decodeText(process.stderr).pipe(Stream.mkString),
            ],
            { concurrency: 3 },
          );
          return { exitCode: Number(exitCode), stdout, stderr };
        }),
      ).pipe(Effect.mapError((cause) => new RepositoryError({ directory, detail: String(cause) })));

    const isClean = (directory: string) =>
      exec(directory, "status", "--porcelain", "--untracked-files=no").pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.trim() === "")
            : Effect.fail(
                new RepositoryError({
                  directory,
                  detail: result.stderr.trim() || `git status exited ${result.exitCode}`,
                }),
              ),
        ),
      );

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
      isClean,

      /**
       * Lands a reviewed branch without trusting the reviewer with the shared
       * checkout. A failed merge is always aborted before control returns.
       */
      merge: (directory: string, branch: string) =>
        Effect.gen(function* () {
          if (!(yield* isClean(directory))) return { _tag: "Held" } as const;

          const result = yield* exec(directory, "merge", "--no-ff", branch);
          if (result.exitCode === 0) return { _tag: "Merged" } as const;

          yield* exec(directory, "merge", "--abort").pipe(Effect.ignore);
          return {
            _tag: "Rejected",
            detail:
              result.stderr.trim() || result.stdout.trim() || `git merge exited ${result.exitCode}`,
          } as const;
        }),
    } as const;
  }),
}) {}

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  directory: Schema.String,
  detail: Schema.String,
}) {}
