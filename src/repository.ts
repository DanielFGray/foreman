import { Command, CommandExecutor, FileSystem, Path } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Schema, Stream } from "effect";

/** The namespace `labelFor` puts every branch foreman authors under. */
const ours = "foreman/";

/** Why a checkout is not free to work against. */
export type HoldReason = "dirty" | "noBranch" | "unreadable";

/**
 * Whether a checkout is free to work against, and if not, why.
 *
 * `detail` is what the dashboard shows for a held project, and it is the same
 * verdict `Landing.Held` carries: both the dispatch gate and the landing gate
 * ask the same question of the same probes, so neither needs a word of its own.
 */
export type Hold =
  | { readonly _tag: "Clean" }
  | { readonly _tag: "Held"; readonly reason: HoldReason; readonly detail: string };

/** The dirty-tree holds, one per tool, because git and jj count different files. */
const DIRTY = "uncommitted changes to tracked files";
const DIRTY_JJ = "uncommitted changes in the working copy";

/** A checkout with no branch for a landing to move, under git. */
const DETACHED = "no checked-out branch (detached HEAD)";

/**
 * The script a project may keep to make a fresh worktree usable. A path rather
 * than a config field: the project is what knows how to build itself, and
 * saying it twice lets the two drift.
 */
const SETUP_SCRIPT = "scripts/worktree-setup.sh";

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
    const path = yield* Path.Path;

    const run = (directory: string, program: string, args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(
            Command.make(program, ...args).pipe(
              Command.workingDirectory(directory),
              // Repository reads must not refresh the shared index. If an
              // observational subprocess is interrupted while doing that,
              // Git leaves index.lock behind and later landings cannot merge.
              // Required write locks are not optional and remain enabled.
              Command.env({ GIT_OPTIONAL_LOCKS: "0" }),
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
     * Whether the checkout already has this branch's commits — the same fact
     * `branches` reports as `merged`, asked about one branch instead of all of
     * them.
     *
     * Always git, as `branches` is: a colocated jj keeps real git refs, and
     * git's HEAD follows the working copy's parent, so this is what the
     * checkout holds under either tool. It reads no index and takes no lock,
     * which is what lets it run ahead of everything else in a landing.
     *
     * git exits 1 for a plain "no" and something else when it could not
     * answer — an unreadable ref is not evidence the branch is absent, and
     * treating it as one would re-land commits the checkout already has.
     */
    const contains = (directory: string, branch: string) =>
      git(directory, "merge-base", "--is-ancestor", branch, "HEAD").pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0 || result.exitCode === 1
            ? Effect.succeed(result.exitCode === 0)
            : Effect.fail(
                new RepositoryError({
                  directory,
                  detail: result.stderr.trim() || `git merge-base exited ${result.exitCode}`,
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

    /** One value per revision, on its own line and nothing else. */
    const template = (expression: string) => ["--no-graph", "-T", `${expression} ++ "\\n"`];

    const revision = (directory: string, revset: string) =>
      jjOutput(directory, "log", "-r", revset, ...template("commit_id"));

    /**
     * The bookmark foreman would land on, or why there is not exactly one.
     *
     * Zero means the operator is standing somewhere no bookmark names; more
     * than one means foreman would have to guess which. The candidates are
     * kept even when there is not exactly one, because they are the fix:
     * deleting the stray bookmark is what unholds the project.
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
          return names.length === 1
            ? ({ _tag: "One", name: names[0] as string } as const)
            : ({ _tag: "None", names } as const);
        }),
      );

    const noTrunk = (names: ReadonlyArray<string>): string =>
      names.length === 0
        ? "no bookmark behind the working copy"
        : `${names.length} bookmark candidates behind the working copy: ${names.join(", ")}`;

    /**
     * What proving a landing somewhere disposable concluded.
     *
     * `Proven` is the only outcome that reaches the operator's checkout, and it
     * carries the one thing the proof learned that the merge itself cannot say:
     * whether the project's own command passed on the merged tree. Every other
     * outcome is a `Landing` verdict already and passes straight through.
     */
    type Proof =
      | { readonly _tag: "Proven"; readonly commit: string; readonly verified: boolean }
      | { readonly _tag: "Held"; readonly detail: string }
      | { readonly _tag: "Rejected"; readonly detail: string }
      | { readonly _tag: "Broke"; readonly output: string };

    /**
     * Makes the directory a proving ground is about to be created in, leaving
     * the ground's own path free for the tool to create.
     *
     * Foreman's job, not the tool's: `git worktree add` makes the path it is
     * given along with everything above it, and `jj workspace add` refuses one
     * whose parent is missing. Doing it here means neither ground depends on
     * which of the two it got.
     */
    const clearFor = (proving: string) =>
      fs.makeDirectory(path.dirname(proving), { recursive: true }).pipe(Effect.ignore);

    /**
     * Installs a proving ground's dependencies, the same way a task worktree
     * gets them.
     *
     * A checkout of source alone cannot run a test suite, and a verification
     * that could not run must never read as green — that is the one gate the
     * whole landing rests on. So a failed setup holds the project: it is the
     * machine's fault or the project's, never the branch's.
     */
    const prepare = (proving: string) =>
      Effect.gen(function* () {
        const script = `${proving}/${SETUP_SCRIPT}`;
        const present = yield* fs.exists(script).pipe(Effect.orElseSucceed(() => false));
        if (!present) return undefined;
        const result = yield* check(proving, `./${SETUP_SCRIPT}`);
        return result.passed
          ? undefined
          : ({ _tag: "Held", detail: `proving ground setup failed:\n${result.output}` } as const);
      });

    /**
     * A worktree of the project kept for proving landings in, held at `base`.
     *
     * It is re-derived, never remembered: a directory git has no worktree
     * registered for is removed and remade, and one it does have is reset to
     * the commit being proved against. What survives between landings is only
     * what a package manager installed, which is the whole reason it is not a
     * fresh directory each time.
     */
    const gitGround = (proving: string, directory: string, base: string) =>
      Effect.gen(function* () {
        const registered = yield* fs
          .exists(`${proving}/.git`)
          .pipe(Effect.orElseSucceed(() => false));
        if (!registered) {
          yield* fs.remove(proving, { recursive: true, force: true }).pipe(Effect.ignore);
          yield* clearFor(proving);
          // A worktree git still lists at a path that is gone would make `add`
          // refuse; pruning is what makes remaking it the honest repair.
          yield* git(directory, "worktree", "prune");
          const added = yield* git(directory, "worktree", "add", "--detach", proving, base);
          if (added.exitCode !== 0) {
            return {
              _tag: "Held",
              detail: added.stderr.trim() || `git worktree add exited ${added.exitCode}`,
            } as const;
          }
          return yield* prepare(proving);
        }

        const reset = yield* git(proving, "reset", "--hard", base);
        if (reset.exitCode !== 0) {
          return {
            _tag: "Held",
            detail: reset.stderr.trim() || `git reset exited ${reset.exitCode}`,
          } as const;
        }
        return yield* prepare(proving);
      });

    /**
     * Answers the whole landing question without writing to the shared
     * checkout: would this branch merge, and does the project still work if it
     * does.
     *
     * Everything that used to make the operator's checkout the proving ground
     * follows from moving it here. Verification no longer runs in a directory a
     * person is using, so the test suites that spawn their own processes there
     * — and strand an `index.lock` that the landing's own git then trips over —
     * have nothing of the operator's to touch. The undo disappears with it:
     * backing a merge out was only ever needed because the merge had already
     * been applied to prove it, and a `reset --hard` that fails in the shared
     * checkout leaves an unverified merge sitting in it.
     *
     * The lazy baseline survives unchanged, and for the same reason: a merge
     * that passes has already answered the only question the baseline exists to
     * answer, so it is asked only after a failure. It is just half the price of
     * a failure now, because resetting the ground costs nothing.
     */
    const gitProve = (
      proving: string,
      directory: string,
      branch: string,
      verify: string | undefined,
      base: string,
    ): Effect.Effect<Proof, RepositoryError> =>
      Effect.gen(function* () {
        const ready = yield* gitGround(proving, directory, base);
        if (ready) return ready;

        const merged = yield* git(proving, "merge", "--no-ff", branch);
        if (merged.exitCode !== 0) {
          // A conflict is asked about rather than inferred. git reports a lock
          // it could not take through the same non-zero codes as content it
          // will not reconcile, and only the diagnostic text separates them —
          // but an unmerged index entry is a fact, written once per conflicting
          // path and by nothing else. Unreadable means unknown, and unknown
          // holds rather than climbs a rung.
          const conflicts = yield* lines(proving, "ls-files", "--unmerged").pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          );
          const detail =
            merged.stderr.trim() || merged.stdout.trim() || `git merge exited ${merged.exitCode}`;
          return conflicts.length > 0
            ? ({ _tag: "Rejected", detail } as const)
            : ({ _tag: "Held", detail } as const);
        }

        // What gets published is this commit, not a merge re-derived later, so
        // the checkout takes exactly the tree that was verified.
        const commit = yield* gitOutput(proving, "rev-parse", "HEAD");

        if (!verify) return { _tag: "Proven", commit, verified: false } as const;

        const after = yield* check(proving, verify);
        if (after.passed) return { _tag: "Proven", commit, verified: true } as const;

        const restored = yield* gitGround(proving, directory, base);
        if (restored) return restored;
        const before = yield* check(proving, verify);
        // Red before the branch touched it, so the branch is not the cause.
        // Gating on an absolute pass would freeze the fleet behind one broken
        // test forever.
        return before.passed
          ? ({ _tag: "Broke", output: after.output } as const)
          : ({ _tag: "Proven", commit, verified: false } as const);
      });

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
      isClean: (directory: string): Effect.Effect<Hold, RepositoryError> =>
        Effect.all([
          git(directory, "symbolic-ref", "--quiet", "HEAD"),
          status(directory, "no"),
        ]).pipe(
          Effect.map(([head, changes]) =>
            head.exitCode === 0
              ? changes === ""
                ? ({ _tag: "Clean" } as const)
                : ({ _tag: "Held", reason: "dirty", detail: DIRTY } as const)
              : ({ _tag: "Held", reason: "noBranch", detail: DETACHED } as const),
          ),
        ),

      merge: (
        directory: string,
        branch: string,
        verify: string | undefined,
        proving: string,
      ): Effect.Effect<Landing, RepositoryError> =>
        Effect.gen(function* () {
          const base = yield* gitOutput(directory, "rev-parse", "HEAD");

          const proof = yield* gitProve(proving, directory, branch, verify, base);
          if (proof._tag !== "Proven") return proof;

          // The proof took as long as the project's suite takes, and the
          // operator shares this checkout. A merge proved against a tip that
          // has since moved is not the merge that would go in, so the landing
          // waits for a tick that can prove and apply the same one.
          const tip = yield* gitOutput(directory, "rev-parse", "HEAD");
          if (tip !== base) {
            return {
              _tag: "Held",
              detail: `${directory} moved while ${branch} was being verified`,
            } as const;
          }

          // The merge already exists, in the ground, and the ground shares this
          // repository's objects — so landing is moving the checkout onto it.
          // A fast-forward cannot reconcile anything, which is the point: every
          // question about content was answered before this line, and a refusal
          // here can only be the machine.
          const applied = yield* git(directory, "merge", "--ff-only", proof.commit);
          if (applied.exitCode !== 0) {
            return {
              _tag: "Held",
              detail:
                applied.stderr.trim() ||
                applied.stdout.trim() ||
                `git merge exited ${applied.exitCode}`,
            } as const;
          }
          return { _tag: "Merged", verified: proof.verified } as const;
        }),

      /**
       * The git path has no landing litter: `git merge` commits onto the
       * checked-out branch in one atomic command, so an interruption either
       * happens before anything or after everything.
       */
      sweepUnpublishedMerges: (_directory: string) => Effect.succeed<ReadonlyArray<string>>([]),
    };

    const messageFor = (branch: string) => `Merge branch '${branch}'`;

    /**
     * The name jj knows the proving ground's workspace by. A workspace is
     * named in the repository, not by its path, so recreating one at a path
     * that was removed means forgetting the old name first.
     */
    const GROUND = "foreman-verify";

    /**
     * A jj workspace of the project kept for proving landings in, sitting on
     * `base`.
     *
     * Re-derived like the git one. Resetting is `jj new <base>` followed by
     * abandoning the working copy it left, which is always a merge foreman
     * itself made and has already finished with. The tick sweep leaves it
     * alone in the meantime, because it excludes every workspace's working
     * copy — including this one.
     */
    const jjGround = (proving: string, directory: string, base: string) =>
      Effect.gen(function* () {
        const registered = yield* fs
          .exists(`${proving}/.jj`)
          .pipe(Effect.orElseSucceed(() => false));
        if (!registered) {
          yield* fs.remove(proving, { recursive: true, force: true }).pipe(Effect.ignore);
          yield* clearFor(proving);
          yield* jj(directory, "workspace", "forget", GROUND).pipe(Effect.ignore);
          const added = yield* jj(
            directory,
            "workspace",
            "add",
            "--name",
            GROUND,
            "--revision",
            base,
            proving,
          );
          if (added.exitCode !== 0) {
            return {
              _tag: "Held",
              detail: added.stderr.trim() || `jj workspace add exited ${added.exitCode}`,
            } as const;
          }
          return yield* prepare(proving);
        }

        const moved = yield* jj(proving, "new", base);
        if (moved.exitCode !== 0) {
          return {
            _tag: "Held",
            detail: moved.stderr.trim() || `jj new exited ${moved.exitCode}`,
          } as const;
        }
        // The commit just stepped off is not abandoned here. A proof that was
        // applied is what the trunk now points at, and one that was not is
        // ordinary unpublished litter — which is exactly what the tick sweep
        // already knows how to tell apart.
        return yield* prepare(proving);
      });

    /**
     * The jj half of proving a landing, and the shape is the same as git's.
     *
     * The one difference is that jj never refuses a merge: it records the
     * conflict and writes markers into the files, so asking `@` whether it is
     * conflicted is the whole verdict, and a non-zero exit can only be the
     * machine.
     */
    const jjProve = (
      proving: string,
      directory: string,
      branch: string,
      verify: string | undefined,
      base: string,
    ): Effect.Effect<Proof, RepositoryError> =>
      Effect.gen(function* () {
        const ready = yield* jjGround(proving, directory, base);
        if (ready) return ready;

        const merged = yield* jj(proving, "new", base, branch, "-m", messageFor(branch));
        if (merged.exitCode !== 0) {
          return { _tag: "Held", detail: merged.stderr.trim() || "jj new failed" } as const;
        }

        const conflicts = yield* jjOutput(proving, "log", "-r", "@", ...template("conflict"));
        if (conflicts === "true") {
          return {
            _tag: "Rejected",
            detail: `merging ${branch} into ${base} conflicts`,
          } as const;
        }

        const commit = yield* revision(proving, "@");

        if (!verify) return { _tag: "Proven", commit, verified: false } as const;

        const after = yield* check(proving, verify);
        if (after.passed) return { _tag: "Proven", commit, verified: true } as const;

        const restored = yield* jjGround(proving, directory, base);
        if (restored) return restored;
        const before = yield* check(proving, verify);
        return before.passed
          ? ({ _tag: "Broke", output: after.output } as const)
          : ({ _tag: "Proven", commit, verified: false } as const);
      });

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
     * because under jj it is not untracked: it is already part of the
     * working-copy commit, and a project somebody is mid-edit in is held for
     * the same reason it is under git.
     *
     * Landing publishes the commit the proving ground already built and
     * verified: the working copy steps onto it, and then the bookmark names
     * it. Never the other way round — a working copy stranded behind its own
     * trunk has no trunk to find, and holds the project with nothing in the
     * fleet able to clear it.
     */
    const jjCheckout = {
      isClean: (directory: string): Effect.Effect<Hold, RepositoryError> =>
        Effect.all([
          trunkOf(directory),
          jjOutput(directory, "log", "-r", "@", ...template("empty")),
        ]).pipe(
          Effect.map(([trunk, empty]) =>
            trunk._tag === "None"
              ? ({ _tag: "Held", reason: "noBranch", detail: noTrunk(trunk.names) } as const)
              : empty === "true"
                ? ({ _tag: "Clean" } as const)
                : ({ _tag: "Held", reason: "dirty", detail: DIRTY_JJ } as const),
          ),
        ),

      merge: (
        directory: string,
        branch: string,
        verify: string | undefined,
        proving: string,
      ): Effect.Effect<Landing, RepositoryError> =>
        Effect.gen(function* () {
          const trunk = yield* trunkOf(directory);
          if (trunk._tag === "None") {
            return { _tag: "Held", reason: "noBranch", detail: noTrunk(trunk.names) } as const;
          }

          // The bookmark names a moving target; the proof is about one commit.
          const base = yield* revision(directory, trunk.name);

          const proof = yield* jjProve(proving, directory, branch, verify, base);
          if (proof._tag !== "Proven") return proof;

          const tip = yield* revision(directory, trunk.name);
          if (tip !== base) {
            return {
              _tag: "Held",
              detail: `${trunk.name} moved while ${branch} was being verified`,
            } as const;
          }

          // Asked again, and here rather than only at the gate, because `jj new`
          // below rewrites the operator's directory unconditionally. Their work
          // is a commit and survives, but it leaves their screen — and a proof
          // takes as long as the project's suite, which is long enough to start
          // typing in. The git path needs no such recheck: a fast-forward
          // refuses rather than overwrites.
          const gate = yield* jjCheckout.isClean(directory);
          if (gate._tag !== "Clean") return gate;

          // The merge already exists, in the ground, and a jj workspace shares
          // the repository — so both of these only ever name it.
          //
          // The working copy moves first, and that order is the whole safety of
          // the step. `trunkOf` reads the nearest bookmark behind `@`, so a
          // working copy left behind a bookmark that moved past it has no trunk
          // at all: the project holds, every later tick asks the same question,
          // and nothing in the fleet can undo it. Publishing second cannot
          // reach that state. An interruption between the two leaves `@` on an
          // unpublished merge whose ancestors still include the trunk, which
          // holds nothing up — the next tick lands the branch again and the
          // sweep takes the merge nobody named.
          const moved = yield* jj(directory, "new", proof.commit);
          if (moved.exitCode !== 0) {
            return {
              _tag: "Held",
              detail: moved.stderr.trim() || `jj new exited ${moved.exitCode}`,
            } as const;
          }

          const applied = yield* jj(directory, "bookmark", "set", trunk.name, "-r", proof.commit);
          if (applied.exitCode !== 0) {
            return {
              _tag: "Held",
              detail: applied.stderr.trim() || `jj bookmark set exited ${applied.exitCode}`,
            } as const;
          }
          return { _tag: "Merged", verified: proof.verified } as const;
        }),

      /**
       * Abandons the merges a landing killed mid-flight leaves behind.
       *
       * A jj landing is three steps — `jj new` creates the merge and moves the
       * working copy onto it, verify runs, and only then does `bookmark set`
       * publish it. Killed between the first and the last — which is exactly
       * what happens when the daemon lands into its own checkout under
       * `bun --watch`, where writing the merged files restarts the process —
       * the merge sits as an anonymous head whose parents are the trunk and a
       * foreman branch, and nothing ever names it. The retry lands the branch
       * honestly, so the leftover commit is pure litter.
       *
       * Only that shape is touched: an anonymous head that is a clean merge of
       * exactly two parents and whose description is the one `merge` writes.
       * Abandoning it loses nothing — an empty merge's tree is derived from its
       * parents, and the branch still holds the work — so the guard is about
       * leaving the operator's own anonymous merges alone, not about keeping
       * anything that would be lost. The working copy is excluded outright: it
       * is the one anonymous head a person may be standing on, and abandoning
       * it would move the ground under their checkout.
       */
      sweepUnpublishedMerges: (directory: string) =>
        Effect.gen(function* () {
          const heads = yield* jjOutput(
            directory,
            "log",
            "-r",
            "heads(all()) & ~bookmarks() & ~working_copies()",
            ...template(
              'commit_id ++ "|" ++ parents.len() ++ "|" ++ empty ++ "|" ++ description.first_line()',
            ),
          );
          const litter = heads.split("\n").flatMap((line) => {
            const [id, parents, empty, description] = line.split("|");
            return id &&
              parents === "2" &&
              empty === "true" &&
              description?.startsWith("Merge branch 'foreman/")
              ? [id]
              : [];
          });

          yield* Effect.forEach(
            litter,
            (id) =>
              jj(directory, "abandon", id).pipe(
                Effect.flatMap((result) =>
                  result.exitCode === 0
                    ? Effect.void
                    : Effect.fail(
                        new RepositoryError({
                          directory,
                          detail:
                            result.stderr.trim() || `jj abandon ${id} exited ${result.exitCode}`,
                        }),
                      ),
                ),
              ),
            { discard: true },
          );
          return litter;
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
       * Whether the checkout is free for foreman to work against, and if not,
       * why.
       *
       * Two ways to be busy. The operator is mid-edit — under git a staged or
       * unstaged change to a tracked file, under jj a non-empty working-copy
       * commit — or the checkout has no branch for a landing to move, which
       * under git means a detached HEAD and under jj means no bookmark behind
       * the working copy. `detail` names which, so the operator can see whether
       * the hold clears itself or needs a hand-run command.
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
       * The commit a task's branch was cut from, so a reviewer can read the
       * author's work without going near the operator's checkout.
       *
       * A reviewer used to be told to run `git -C <repository> diff
       * HEAD...<branch>`, because naming the author's work needs both ends of
       * it and only the checkout knew where the branch forked. That put an
       * agent's git process in the one directory foreman claims no agent
       * writes to, and `git diff` refreshes the index: it collided with a
       * landing mid-merge, left `index.lock` behind, and the failed merge was
       * charged to the branch — a task climbed a rung for foreman's own
       * concurrency. Resolving the fork point here instead leaves the reviewer
       * one revision it can diff entirely inside its own worktree.
       *
       * A commit rather than the trunk's name, because the operator's branch
       * moves while a review runs, and the question is what this author wrote.
       * Always git: worktrees are git's whatever records the project, and a
       * colocated jj keeps real git refs for its bookmarks.
       */
      base: (directory: string, branch: string) =>
        gitOutput(directory, "merge-base", "HEAD", branch).pipe(
          Effect.map((sha) => (sha === "" ? undefined : sha)),
          Effect.orElseSucceed(() => undefined),
        ),

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
       * Makes a fresh worktree usable, and says whether it worked.
       *
       * A worktree does not share the checkout's installed dependencies, so
       * something has to install them. That used to be a paragraph in the
       * author and reviewer prompts, which is the wrong place for a step with
       * one right answer: it spent tokens on it every dispatch, a cheap model
       * could skip it and misread the resulting failure as the task's, and it
       * was prose in two files that had to stay in sync.
       *
       * The project records the command, not foreman's config — a checked-in
       * script is a fact about the project that foreman reads back like every
       * other, and a project that gains one is picked up with no config edit.
       * Absent is a valid answer: most projects need nothing.
       *
       * Run before every dispatch rather than only into a worktree foreman just
       * made, because nothing in the world says "this directory is already set
       * up" and foreman remembers nothing. So the script must be safe to re-run
       * — which is what a package manager's install already is, and what a
       * clone needs a guard to become. Re-running is also what repairs a
       * worktree whose dependencies were removed or half-written.
       */
      setup: (directory: string) =>
        Effect.gen(function* () {
          const script = `${directory}/${SETUP_SCRIPT}`;
          const present = yield* fs.exists(script).pipe(Effect.orElseSucceed(() => false));
          return present ? yield* check(directory, `./${SETUP_SCRIPT}`) : undefined;
        }),

      /**
       * Lands a reviewed branch without trusting the reviewer with the shared
       * checkout, and without testing anything in it.
       *
       * `proving` is a scratch checkout of the same project — see
       * `verifyDirectoryFor`. The merge is made there and `verify`, the
       * project's own command for deciding whether it works, is run there;
       * only a clean answer is applied to `directory`, and only if its tip has
       * not moved in the meantime. So the shared checkout is written exactly
       * once per landing, by one command, and there is nothing to undo when a
       * branch turns out to break the project.
       *
       * A project that was already red stays landable, because a branch cannot
       * be blamed for damage that predates it, and gating on an absolute pass
       * would freeze the fleet behind one broken test forever.
       */
      merge: (directory: string, branch: string, verify: string | undefined, proving: string) =>
        Effect.gen(function* () {
          // Asked before the clean gate, because a checkout that already has
          // the commits is not going to be written to and its cleanliness is
          // beside the point. Holding here would strand the task exactly as
          // long as the operator kept editing.
          if (yield* contains(directory, branch)) return { _tag: "Present" } as const;

          const checkout = yield* checkoutAt(directory);
          const gate = yield* checkout.isClean(directory);
          if (gate._tag !== "Clean") return gate;
          return yield* checkout.merge(directory, branch, verify, proving);
        }),

      /**
       * Clears the jj commits a landing interrupted before publishing left
       * behind, in every colocated checkout. Nothing to do in a checkout git
       * is keeping: its merge is atomic, so no landing ever leaves an orphan
       * there. Called every tick, like the branch sweep — the litter appears
       * whenever a restart kills the daemon mid-merge, and only the world
       * records where.
       */
      sweepUnpublishedMerges: (directory: string) =>
        checkoutAt(directory).pipe(
          Effect.flatMap((checkout) => checkout.sweepUnpublishedMerges(directory)),
        ),
    } as const;
  }),
}) {}

/** What became of a branch foreman tried to put into the operator's checkout. */
export type Landing =
  /**
   * Not now. The checkout was not in a state to land into, which says nothing
   * about the branch — so the verdict stays on the task and a later tick tries
   * again. `reason` is present when the cleanliness gate itself said no, and
   * `detail` names the obstacle when it was not simply the operator working
   * there.
   */
  | { readonly _tag: "Held"; readonly reason?: HoldReason; readonly detail: string | undefined }
  /**
   * The checkout already had the commits, so nothing was merged and nothing
   * was verified. Distinct from `Merged` because no write happened: foreman
   * cannot claim to have landed the branch, and cannot claim the checkout was
   * green either. What it can do is finish the task, which is the step a
   * landing interrupted after its merge would otherwise never reach.
   */
  | { readonly _tag: "Present" }
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
