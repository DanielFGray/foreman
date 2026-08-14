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

    /**
     * Runs a project's verification command and says only whether it passed.
     *
     * Through a shell because the command comes from the config as a line the
     * operator would type. Failure to launch counts as a failure to pass: a
     * command that cannot run tells foreman nothing about the code, and
     * treating "no answer" as "green" is how an ungated merge would sneak
     * through the one gate built to stop it.
     */
    const check = (directory: string, command: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(
            Command.make("sh", "-c", command).pipe(
              Command.workingDirectory(directory),
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
          return { passed: Number(exitCode) === 0, output: `${stdout}${stderr}`.trim() };
        }),
      ).pipe(Effect.orElseSucceed(() => ({ passed: false, output: `could not run: ${command}` })));

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
       *
       * `verify` is the project's own command for deciding whether it works —
       * its test suite, typically. It runs twice: once before the merge to
       * learn what the checkout was already doing, and once after. A project
       * that was green and is now red is a branch that broke it, and the merge
       * is undone. A project that was already red stays landable, because a
       * branch cannot be blamed for damage that predates it, and gating on an
       * absolute pass would freeze the fleet behind one broken test forever.
       *
       * The undo lives in here rather than beside it. Reverting is the one
       * operation in foreman that discards commits, and it is only ever safe
       * against a revision this function captured after proving the tree clean
       * — so it is never handed out as a capability of its own.
       */
      merge: (directory: string, branch: string, verify: string | undefined) =>
        Effect.gen(function* () {
          if (!(yield* isClean(directory))) return { _tag: "Held" } as const;

          const before = verify ? yield* check(directory, verify) : undefined;
          const restore = yield* exec(directory, "rev-parse", "HEAD");

          const merged = yield* exec(directory, "merge", "--no-ff", branch);
          if (merged.exitCode !== 0) {
            yield* exec(directory, "merge", "--abort").pipe(Effect.ignore);
            return {
              _tag: "Rejected",
              detail:
                merged.stderr.trim() ||
                merged.stdout.trim() ||
                `git merge exited ${merged.exitCode}`,
            } as const;
          }

          if (!verify || !before?.passed) return { _tag: "Merged", verified: false } as const;

          const after = yield* check(directory, verify);
          if (after.passed) return { _tag: "Merged", verified: true } as const;

          yield* exec(directory, "reset", "--hard", restore.stdout.trim());
          return { _tag: "Broke", output: after.output } as const;
        }),
    } as const;
  }),
}) {}

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  directory: Schema.String,
  detail: Schema.String,
}) {}
