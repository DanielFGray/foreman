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
  accessors: true,
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

    const status = (directory: string, untracked: "no" | "all") =>
      exec(directory, "status", "--porcelain", `--untracked-files=${untracked}`).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(
                new RepositoryError({
                  directory,
                  detail: result.stderr.trim() || `git status exited ${result.exitCode}`,
                }),
              ),
        ),
      );

    /** A git command whose answer is a list, and whose failure is an error. */
    const lines = (directory: string, ...args: Array<string>) =>
      exec(directory, ...args).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.split("\n").filter((line) => line.trim() !== ""))
            : Effect.fail(
                new RepositoryError({
                  directory,
                  detail: result.stderr.trim() || `git ${args[0]} exited ${result.exitCode}`,
                }),
              ),
        ),
      );

    const isClean = (directory: string) =>
      status(directory, "no").pipe(Effect.map((changes) => changes === ""));

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
       * Whether a task worktree holds anything the agent that lived in it made.
       *
       * The same command as isClean, counting untracked files, because the two
       * ask about opposite kinds of directory. A shared checkout has collected
       * untracked build output and scratch notes for months. A task worktree
       * was created empty minutes ago, so anything git does not follow arrived
       * with the agent: a new module it wrote, or the leavings of a test run it
       * got as far as starting. Either way the agent was working, which is the
       * question — and the two mistakes are not the same size. A worktree kept
       * for nothing costs disk; a worktree deleted wrongly costs the work.
       *
       * This is what an agent leaves behind when it dies without committing,
       * and it is the difference between a worktree to resume in and one to
       * delete.
       */
      holdsWork: (directory: string) =>
        status(directory, "all").pipe(Effect.map((changes) => changes !== "")),

      /**
       * Every branch foreman owns in this checkout, and the two facts git can
       * prove about each one.
       *
       * The branches are the only record that survives everything else. A
       * workspace can be closed, a claim reclaimed, a task marked done or
       * deleted outright, and the commits are still sitting on the branch — so
       * git, not prog, is what foreman asks to find work it has lost track of.
       *
       * `empty` is the fact that cannot be inferred from `merged`, and getting
       * it wrong once cost a landed task. A branch nobody committed to and a
       * branch whose commits are already in the checkout are both reachable
       * from `HEAD`, so "not unmerged" says nothing about whether an author
       * wrote anything. What separates them is where the tip sits: an untouched
       * branch still points at the trunk commit it was cut from, while a merged
       * branch's tip arrives through a merge commit's second parent. Foreman
       * merges `--no-ff`, so the first-parent line is exactly the set of
       * commits the checkout had before any branch landed.
       */
      branches: (directory: string) =>
        Effect.gen(function* () {
          const refs = yield* lines(
            directory,
            "for-each-ref",
            "--format=%(objectname) %(refname:short)",
            "refs/heads/foreman/",
          );
          const merged = new Set(
            yield* lines(
              directory,
              "for-each-ref",
              "--merged=HEAD",
              "--format=%(refname:short)",
              "refs/heads/foreman/",
            ),
          );
          const trunk = new Set(yield* lines(directory, "rev-list", "--first-parent", "HEAD"));
          return refs.flatMap((ref) => {
            const [tip, branch] = ref.split(" ");
            return tip && branch
              ? [{ branch, merged: merged.has(branch), empty: trunk.has(tip) } satisfies Branch]
              : [];
          });
        }),

      /**
       * Deletes a branch, and says whether git let it go.
       *
       * `--delete` without `--force` is what makes the sweep above it safe:
       * git refuses a branch holding commits the checkout does not have, and
       * refuses one a worktree still has checked out — which is picked up on a
       * later tick, once that workspace closes. A refusal is an answer, not a
       * failure, so it comes back as `false` rather than as an error.
       */
      remove: (directory: string, branch: string) =>
        exec(directory, "branch", "--delete", branch).pipe(
          Effect.map((result) => result.exitCode === 0),
        ),

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

/** One of foreman's branches, as git sees it against the checkout's HEAD. */
export interface Branch {
  readonly branch: string;

  /** The checkout already has these commits, so the ref is free to delete. */
  readonly merged: boolean;

  /** Nothing was ever committed here: the tip is still a trunk commit. */
  readonly empty: boolean;
}

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  directory: Schema.String,
  detail: Schema.String,
}) {}
