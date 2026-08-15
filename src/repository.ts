import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Schema, Stream } from "effect";

/** The namespace `labelFor` puts every branch foreman authors under. */
const ours = "foreman/";

/**
 * The checkout a project's tasks branch from and merge back into.
 *
 * Foreman shares this directory with the operator, who edits in it while the
 * fleet runs. It is the one place where agents and a person can collide, so
 * foreman asks the checkout itself whether the operator is presently working
 * there, and lands through whichever tool records that checkout's history.
 */
export class Repository extends Effect.Service<Repository>()("Repository", {
  dependencies: [BunContext.layer],
  accessors: true,
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const fs = yield* FileSystem.FileSystem;

    const run = (directory: string, program: string, args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(
            Command.make(program, ...args).pipe(
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
          return { exitCode: Number(exitCode), stdout, stderr };
        }),
      ).pipe(Effect.mapError((cause) => new RepositoryError({ directory, detail: String(cause) })));

    const git = (directory: string, ...args: Array<string>) => run(directory, "git", args);
    const jj = (directory: string, ...args: Array<string>) => run(directory, "jj", args);

    /** The trimmed output of a command that must succeed. */
    const output = (
      directory: string,
      program: string,
      result: { exitCode: number; stdout: string; stderr: string },
      what: string,
    ) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.fail(
            new RepositoryError({
              directory,
              detail: result.stderr.trim() || `${program} ${what} exited ${result.exitCode}`,
            }),
          );

    const gitOutput = (directory: string, ...args: Array<string>) =>
      git(directory, ...args).pipe(
        Effect.flatMap((result) => output(directory, "git", result, args[0] ?? "")),
      );

    const jjOutput = (directory: string, ...args: Array<string>) =>
      jj(directory, ...args).pipe(
        Effect.flatMap((result) => output(directory, "jj", result, args[0] ?? "")),
      );

    const lines = (directory: string, ...args: Array<string>) =>
      gitOutput(directory, ...args).pipe(
        Effect.map((text) => text.split("\n").filter((line) => line.trim() !== "")),
      );

    const status = (directory: string, untracked: "no" | "all") =>
      gitOutput(directory, "status", "--porcelain", `--untracked-files=${untracked}`);

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

    /** One value per revision, on its own line and nothing else. */
    const template = (expression: string) => ["--no-graph", "-T", `${expression} ++ "\\n"`];

    const revision = (directory: string, revset: string) =>
      jjOutput(directory, "log", "-r", revset, ...template("commit_id"));

    /**
     * The bookmark foreman would land on, or undefined when there is not
     * exactly one. Zero means the operator is standing somewhere no bookmark
     * names; more than one means foreman would have to guess which.
     */
    const trunkOf = (directory: string) =>
      jjOutput(directory, "log", "-r", "heads(::@ & bookmarks())", ...template("bookmarks")).pipe(
        Effect.map((text) => {
          const names = text
            .split(/\s+/)
            .filter((name) => name !== "")
            // jj suffixes a bookmark whose git ref has drifted from it.
            .map((name) => name.replace(/\*$/, ""))
            // Foreman's own branches are cut from the trunk's tip, so an author
            // that has not committed yet leaves its bookmark on the very commit
            // being asked about. It is never a landing target, and counting it
            // would hold the project for as long as anyone is working in it.
            .filter((name) => !name.startsWith(ours));
          return names.length === 1 ? names[0] : undefined;
        }),
      );

    /**
     * Landing through git, in a checkout git alone is keeping.
     *
     * The branch to land on is whichever one HEAD names, which is why a
     * detached HEAD reads as held: `git merge` will happily commit onto no
     * branch at all, so the work lands, the operator's branch stays where it
     * was, and the sweep then deletes the only ref that pointed at the
     * commits. That is not a hypothetical — it happened, and the task was
     * recovered from the reflog.
     */
    const gitCheckout = {
      isClean: (directory: string) =>
        Effect.all([
          git(directory, "symbolic-ref", "--quiet", "HEAD"),
          status(directory, "no"),
        ]).pipe(Effect.map(([head, changes]) => head.exitCode === 0 && changes === "")),

      merge: (
        directory: string,
        branch: string,
        verify: string | undefined,
      ): Effect.Effect<Landing, RepositoryError> =>
        Effect.gen(function* () {
          const before = verify ? yield* check(directory, verify) : undefined;
          const restore = yield* gitOutput(directory, "rev-parse", "HEAD");

          const merged = yield* git(directory, "merge", "--no-ff", branch);
          if (merged.exitCode !== 0) {
            yield* git(directory, "merge", "--abort").pipe(Effect.ignore);
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

          yield* gitOutput(directory, "reset", "--hard", restore);
          return { _tag: "Broke", output: after.output } as const;
        }),
    };

    /**
     * Landing through jj, in a checkout jj is colocated with git.
     *
     * jj has no checked-out branch, so the bookmark to land on is derived the
     * same way git derives it — the branch the operator is standing on, which
     * here means the nearest bookmark behind the working copy. `heads` drops
     * the ones already merged into it, including foreman's own.
     *
     * The working copy is a commit, so "clean" is `@` being empty. That counts
     * a new file git would call untracked, unlike the git checkout above,
     * because under jj it is not untracked: it is part of the working-copy
     * commit, and landing would carry it out of the operator's directory.
     *
     * jj never refuses a merge — a conflict becomes a recorded state with
     * markers written into the files — so the conflict check is not an error
     * path but the ordinary one, and backing out is `edit` then `abandon`
     * rather than an abort.
     */
    const jjCheckout = {
      isClean: (directory: string) =>
        Effect.all([
          trunkOf(directory),
          jjOutput(directory, "log", "-r", "@", ...template("empty")),
        ]).pipe(Effect.map(([trunk, empty]) => trunk !== undefined && empty === "true")),

      merge: (
        directory: string,
        branch: string,
        verify: string | undefined,
      ): Effect.Effect<Landing, RepositoryError> =>
        Effect.gen(function* () {
          const trunk = yield* trunkOf(directory);
          if (!trunk) return { _tag: "Held" } as const;

          const before = verify ? yield* check(directory, verify) : undefined;
          const restore = yield* revision(directory, "@");

          const merged = yield* jj(
            directory,
            "new",
            trunk,
            branch,
            "-m",
            `Merge branch '${branch}'`,
          );
          if (merged.exitCode !== 0) {
            return { _tag: "Rejected", detail: merged.stderr.trim() || "jj new failed" } as const;
          }

          const merge = yield* revision(directory, "@");
          const backOut = jjOutput(directory, "edit", restore).pipe(
            Effect.andThen(jjOutput(directory, "abandon", merge)),
          );

          const conflicts = yield* jjOutput(directory, "log", "-r", "@", ...template("conflict"));
          if (conflicts === "true") {
            yield* backOut;
            return {
              _tag: "Rejected",
              detail: merged.stderr.trim() || `merging ${branch} into ${trunk} conflicts`,
            } as const;
          }

          const land = jjOutput(directory, "bookmark", "set", trunk, "-r", "@").pipe(
            // A fresh empty child, so the operator's next edit amends their own
            // working copy rather than the merge that was just published.
            Effect.andThen(jjOutput(directory, "new")),
          );

          if (!verify || !before?.passed) {
            yield* land;
            return { _tag: "Merged", verified: false } as const;
          }

          const after = yield* check(directory, verify);
          if (!after.passed) {
            yield* backOut;
            return { _tag: "Broke", output: after.output } as const;
          }

          yield* land;
          return { _tag: "Merged", verified: true } as const;
        }),
    };

    /**
     * Which tool is keeping this checkout's history, read from the directory
     * rather than configured.
     *
     * A colocated repository has both, and the difference is not cosmetic: git
     * commands still read it correctly — the refs and worktrees are real — but
     * a `git merge` into it commits onto a HEAD jj detaches, leaving the
     * operator's bookmark behind. So the reads stay on git and only the two
     * questions that depend on where the operator is standing change hands.
     */
    const checkoutAt = (directory: string) =>
      fs.exists(`${directory}/.jj`).pipe(
        Effect.map((colocated) => (colocated ? jjCheckout : gitCheckout)),
        Effect.mapError((cause) => new RepositoryError({ directory, detail: String(cause) })),
      );

    return {
      /**
       * Whether the checkout is free for foreman to work against.
       *
       * Two ways to be busy. The operator is mid-edit — under git a staged or
       * unstaged change to a tracked file, under jj a non-empty working-copy
       * commit — or the checkout has no branch for a landing to move, which
       * under git means a detached HEAD and under jj means no bookmark behind
       * the working copy.
       *
       * Under git, untracked files do not count. Scratch notes, build output
       * and editor leavings sit in a repository for months, and holding a
       * project for one would hold it forever.
       */
      isClean: (directory: string) =>
        checkoutAt(directory).pipe(Effect.flatMap((checkout) => checkout.isClean(directory))),

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
       * Always git: herdr makes these with `git worktree add`, so a worktree is
       * git's whatever the project checkout it came from is.
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
       * merges without fast-forwarding either way, so the first-parent line is
       * exactly the set of commits the checkout had before any branch landed.
       */
      branches: (directory: string) =>
        Effect.gen(function* () {
          const refs = yield* lines(
            directory,
            "for-each-ref",
            "--format=%(objectname) %(refname:short)",
            `refs/heads/${ours}`,
          );
          const merged = new Set(
            yield* lines(
              directory,
              "for-each-ref",
              "--merged=HEAD",
              "--format=%(refname:short)",
              `refs/heads/${ours}`,
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
       *
       * A colocated jj imports git's refs at the start of every command, so a
       * branch deleted here is a bookmark gone there; it is not resurrected.
       */
      remove: (directory: string, branch: string) =>
        git(directory, "branch", "--delete", branch).pipe(
          Effect.map((result) => result.exitCode === 0),
        ),

      /**
       * Lands a reviewed branch without trusting the reviewer with the shared
       * checkout. A failed merge is always backed out before control returns.
       *
       * `verify` is the project's own command for deciding whether it works —
       * its test suite, typically. It runs twice: once before the merge to
       * learn what the checkout was already doing, and once after. A project
       * that was green and is now red is a branch that broke it, and the merge
       * is undone. A project that was already red stays landable, because a
       * branch cannot be blamed for damage that predates it, and gating on an
       * absolute pass would freeze the fleet behind one broken test forever.
       *
       * The undo lives in here rather than beside it. Backing out is the one
       * operation in foreman that discards commits, and it is only ever safe
       * against a revision this function captured after proving the checkout
       * clean — so it is never handed out as a capability of its own.
       */
      merge: (directory: string, branch: string, verify: string | undefined) =>
        Effect.gen(function* () {
          const checkout = yield* checkoutAt(directory);
          if (!(yield* checkout.isClean(directory))) return { _tag: "Held" } as const;
          return yield* checkout.merge(directory, branch, verify);
        }),
    } as const;
  }),
}) {}

/** What became of a branch foreman tried to put into the operator's checkout. */
export type Landing =
  | { readonly _tag: "Held" }
  | { readonly _tag: "Rejected"; readonly detail: string }
  | { readonly _tag: "Merged"; readonly verified: boolean }
  | { readonly _tag: "Broke"; readonly output: string };

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
