import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";

/** The namespace `labelFor` puts every branch foreman authors under. */
const ours = "foreman/";

/** Why a checkout is not free to work against. */
export type HoldReason = "dirty" | "noBranch" | "busy" | "unreadable" | "ambiguous";

/**
 * Whether a checkout is free to work against, and if not, why.
 *
 * `detail` is what the dashboard shows for a held project, and it is the same
 * verdict `Landing.Held` carries: both the dispatch gate and the landing gate
 * ask the same question of the same probes, so neither needs a word of its own.
 */
export type Hold =
  | { readonly _tag: "Clean" }
  | {
      readonly _tag: "Held";
      readonly reason: HoldReason;
      readonly detail: string;
      /**
       * For a `busy` hold, the task branch the checkout has out. The hold is
       * that task's own workspace, so it holds every task but that one.
       */
      readonly branch?: string;
    };

/** A checkout with no branch for a landing to move, so there is no branch to land on. */
const DETACHED = "no checked-out branch (detached HEAD)";

/**
 * Every path `git status --porcelain -z` names. A rename or copy is two
 * entries, the new path and then the old, and a landing that writes either
 * collides with it.
 */
const dirtyPaths = (status: string): ReadonlyArray<string> => {
  const entries = status.split("\0").filter((entry) => entry !== "");
  const paths: Array<string> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && i + 1 < entries.length) paths.push(entries[++i]!);
  }
  return paths;
};

/**
 * The script a project may keep to make a fresh worktree usable. A path rather
 * than a config field: the project is what knows how to build itself, and
 * saying it twice lets the two drift.
 */
const SETUP_SCRIPT = "scripts/worktree-setup.sh";

/** The script a project keeps to decide whether it works; see `verifyOf`. */
const VERIFY_SCRIPT = "scripts/verify.sh";

/**
 * The checkout a project's tasks branch from and merge back into.
 *
 * Foreman shares this directory with the operator, who edits in it while the
 * fleet runs. It is the one place where agents and a person can collide, so
 * foreman asks the checkout itself whether the operator is presently working
 * there, and lands through git.
 */
export class Repository extends Context.Service<Repository>()("Repository", {
  make: Effect.gen(function* () {
    const executor = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const run = (directory: string, program: string, args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.spawn(
            ChildProcess.make(program, args, {
              cwd: directory,
              // Repository reads must not refresh the shared index. If an
              // observational subprocess is interrupted while doing that,
              // Git leaves index.lock behind and later landings cannot merge.
              // Required write locks are not optional and remain enabled.
              env: { GIT_OPTIONAL_LOCKS: "0" },
              // git reads the operator's identity and config through HOME and
              // GIT_* variables, so it runs in foreman's own environment.
              extendEnv: true,
              stdout: "pipe",
              stderr: "pipe",
            }),
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

    /** The untrimmed output, for `-z` listings whose entries may begin with a space. */
    const gitRaw = (directory: string, ...args: Array<string>) =>
      git(directory, ...args).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : output(directory, "git", result, args[0] ?? ""),
        ),
      );

    const lines = (directory: string, ...args: Array<string>) =>
      gitOutput(directory, ...args).pipe(
        Effect.map((text) => text.split("\n").filter((line) => line.trim() !== "")),
      );

    /**
     * The commit `branch` was created at: the oldest entry of its reflog, or
     * undefined when git kept none.
     */
    const createdAt = (directory: string, branch: string) =>
      git(directory, "reflog", "show", "--format=%H", `refs/heads/${branch}`, "--").pipe(
        Effect.map((result) =>
          result.exitCode === 0
            ? result.stdout.trim().split("\n").filter(Boolean).at(-1)
            : undefined,
        ),
      );

    const status = (directory: string, untracked: "no" | "all") =>
      gitOutput(directory, "status", "--porcelain", `--untracked-files=${untracked}`);

    /**
     * Whether the checkout already has this branch's commits — the same fact
     * `branches` reports as `merged`, asked about one branch instead of all of
     * them.
     *
     * Always git. It reads no index and takes no lock, which is what lets it run
     * ahead of everything else in a landing.
     *
     * git exits 1 for a plain "no" and something else when it could not
     * answer — an unreadable ref is not evidence the branch is absent, and
     * treating it as one would re-land commits the checkout already has.
     */
    /**
     * The hold for a landing that would write a path the operator has not
     * committed, or undefined when it writes none.
     *
     * `changes` are `git diff` revisions naming what the landing writes. The
     * dirty side counts untracked files as well as tracked edits, because a
     * fast-forward refuses to overwrite either.
     */
    const collision = (directory: string, branch: string, ...changes: Array<string>) =>
      Effect.all([
        gitRaw(directory, "diff", "--name-only", "-z", ...changes),
        gitRaw(directory, "status", "--porcelain", "-z", "--untracked-files=all"),
      ]).pipe(
        Effect.map(([changed, dirty]) => {
          const editing = new Set(dirtyPaths(dirty));
          const overlap = changed.split("\0").filter((path) => editing.has(path));
          return overlap.length === 0
            ? undefined
            : ({
                _tag: "Held",
                reason: "dirty",
                detail: `uncommitted changes to ${overlap.join(", ")}, which ${branch} also changes`,
              } as const);
        }),
      );

    /** The short name of the branch HEAD names, or undefined for a detached HEAD. */
    const headBranch = (directory: string) =>
      git(directory, "symbolic-ref", "--quiet", "--short", "HEAD").pipe(
        Effect.map((head) => (head.exitCode === 0 ? head.stdout.trim() : undefined)),
      );

    /**
     * The revision a checkout's work lands on: HEAD, unless the checkout has a
     * task's branch out.
     *
     * A project in branch mode checks `foreman/<id>` out in the operator's
     * checkout, so for that whole run HEAD is the task's own work. Read as the
     * trunk, it makes the task's branch read as merged and empty and gives its
     * reviewer an empty diff. The branch it lands on is the task branch's
     * upstream, which `checkoutBranch` set, so git records it and foreman
     * remembers nothing. A task branch with no upstream fails here: the
     * checkout was put on it by hand, and foreman cannot say where it lands.
     */
    const trunkOf = (directory: string) =>
      Effect.gen(function* () {
        const head = yield* headBranch(directory);
        if (head === undefined || !head.startsWith(ours)) return "HEAD";
        return yield* gitOutput(directory, "rev-parse", "--abbrev-ref", `${head}@{upstream}`);
      });

    /** Whether `descendant` (HEAD when absent) already has `ancestor`. */
    const contains = (directory: string, ancestor: string, descendant = "HEAD") =>
      git(directory, "merge-base", "--is-ancestor", ancestor, descendant).pipe(
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
          const process = yield* executor.spawn(
            ChildProcess.make("sh", ["-c", command], {
              cwd: directory,
              stdout: "pipe",
              stderr: "pipe",
            }),
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

    /**
     * A verification failure's output when it reproduces, or nothing when the
     * first failure flaked.
     *
     * A suite that fails and then passes on the same tree did not find a defect;
     * it flaked. Returning a correct branch for that charges the task for the
     * project's own test, so the retry is what separates a break from a flake —
     * and only a reproducible failure is the branch's to answer for. The
     * re-run happens before the pre-merge baseline, so a branch that did break
     * the suite still costs the baseline its usual single run.
     */
    const reproduced = (directory: string, command: string, output: string) =>
      check(directory, command).pipe(Effect.map((retry) => (retry.passed ? undefined : output)));

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
     * given along with everything above it, so the parent is made before the
     * ground is added and the tool can create the rest. Doing it here means the
     * ground depends on nothing but the tool's own rules.
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
     * It is re-derived, never remembered: one git has registered is reset to
     * the commit being proved against, and any other is removed and remade.
     * What survives between landings is only what a package manager installed,
     * which is the whole reason it is not a fresh directory each time.
     *
     * A ground that will not reset is remade too. The usual cause is an
     * `index.lock` left by a git that was killed there, by a restart of the
     * process mid-proof or by a test suite under verify. Nothing but a
     * landing works in the ground, and a landing runs one at a time, so the lock
     * is stale, and holding instead would hold every landing until someone
     * looked.
     */
    const gitGround = (proving: string, directory: string, base: string) =>
      Effect.gen(function* () {
        const registered = yield* fs
          .exists(`${proving}/.git`)
          .pipe(Effect.orElseSucceed(() => false));
        const reset = registered
          ? (yield* git(proving, "reset", "--hard", base)).exitCode === 0
          : false;
        if (!reset) {
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
      message: string,
      how: How,
    ): Effect.Effect<Proof, RepositoryError> =>
      Effect.gen(function* () {
        const ready = yield* gitGround(proving, directory, base);
        if (ready) return ready;

        // A fast-forward lands the approved commit itself, so it needs the
        // trunk tip below it. A trunk that moved after the branch was cut is
        // the same finding as a conflict: the branch must take the trunk in
        // first. Foreman never rebases, because a rebase makes a commit the
        // reviewer did not read.
        if (how === "fast-forward" && !(yield* contains(proving, base, branch))) {
          return {
            _tag: "Rejected",
            detail: `the trunk moved after the branch was cut, so ${branch} does not fast-forward onto ${base}`,
          } as const;
        }
        const merged = yield* how === "fast-forward"
          ? git(proving, "merge", "--ff-only", branch)
          : git(proving, "merge", "--no-ff", "-m", message, branch);
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

        const judged = yield* judge(proving, verify, gitGround(proving, directory, base));
        switch (judged._tag) {
          case "Passed":
            return { _tag: "Proven", commit, verified: judged.verified } as const;
          case "Failed":
            return { _tag: "Broke", output: judged.output } as const;
          case "Held":
            return judged;
        }
      });

    /**
     * What `command` says about the tree the proving ground holds.
     *
     * A failure counts against the tree only when it reproduces and the
     * command passes once `baseline` resets the ground to where the tree
     * began. Red before the tree touched it, the tree is not the cause, and
     * gating on an absolute pass would freeze the fleet behind one broken test
     * forever. Such a pass is not `verified`.
     */
    const judge = (
      proving: string,
      command: string,
      baseline: Effect.Effect<
        { readonly _tag: "Held"; readonly detail: string } | undefined,
        RepositoryError
      >,
    ): Effect.Effect<Checked, RepositoryError> =>
      Effect.gen(function* () {
        const after = yield* check(proving, command);
        if (after.passed) return { _tag: "Passed", verified: true } as const;

        const broke = yield* reproduced(proving, command, after.output);
        if (broke === undefined) {
          yield* Effect.logWarning(`${command} failed then passed in ${proving}; a flake is green`);
          return { _tag: "Passed", verified: true } as const;
        }

        const restored = yield* baseline;
        if (restored) return restored;
        const before = yield* check(proving, command);
        return before.passed
          ? ({ _tag: "Failed", output: broke } as const)
          : ({ _tag: "Passed", verified: false } as const);
      });

    /**
     * Runs a check block's command on `commit` in the proving ground, so it
     * judges exactly that commit and writes to no tree a person or an agent
     * uses. Its baseline is `base`, the commit the work started from.
     */
    const gitCheck = (
      proving: string,
      directory: string,
      commit: string,
      base: string,
      command: string,
    ) =>
      Effect.gen(function* () {
        const ready = yield* gitGround(proving, directory, commit);
        if (ready) return ready;
        return yield* judge(proving, command, gitGround(proving, directory, base));
      });

    /**
     * Lands a branch onto the checkout's HEAD branch, through git.
     *
     * The branch to land on is whichever one HEAD names, which is why a
     * detached HEAD reads as held: `git merge` will happily commit onto no
     * branch at all, so the work lands, the operator's branch stays where it
     * was, and the sweep then deletes the only ref that pointed at the
     * commits. That is not a hypothetical — it happened, and the task was
     * recovered from the reflog.
     */
    const gitCheckout = {
      merge: (
        directory: string,
        branch: string,
        verify: string | undefined,
        proving: string,
        message: string,
        how: How,
      ): Effect.Effect<Landing, RepositoryError> =>
        Effect.gen(function* () {
          // Asked before the proof, which costs a run of the project's suite:
          // a branch that changes a file the operator is editing cannot land
          // until they finish, however green it is.
          const editing = yield* collision(directory, branch, `HEAD...${branch}`);
          if (editing) return editing;

          const base = yield* gitOutput(directory, "rev-parse", "HEAD");

          const proof = yield* gitProve(proving, directory, branch, verify, base, message, how);
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
            // The operator may have begun editing one of the branch's files
            // during the proof. git refused for that, and it clears itself.
            const late = yield* collision(directory, branch, "HEAD", proof.commit);
            if (late) return late;
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
    };

    /**
     * Whether the checkout is free for foreman to work against, and if not,
     * why.
     *
     * Busy means the checkout has no branch for a landing to move — a
     * detached HEAD. Uncommitted work does not hold it: tasks branch from the
     * committed tip, and a landing is a fast-forward, which git refuses only
     * when it would overwrite a dirty or untracked path. So the operator's
     * edits stop exactly the branches that change the same files, and `merge`
     * finds those per branch. `detail` names the cause, so the operator can see
     * whether the hold clears itself or needs a hand-run command.
     *
     * A checkout with a task's branch out is `busy`: that task works in the
     * checkout itself (branch mode), so no other agent starts there and no
     * other landing moves it, until its own landing checks the operator's
     * branch out again.
     */
    const isFree = (directory: string): Effect.Effect<Hold, RepositoryError> =>
      Effect.gen(function* () {
        const head = yield* headBranch(directory);
        if (head === undefined) return { _tag: "Held", reason: "noBranch", detail: DETACHED };
        if (head.startsWith(ours)) {
          return {
            _tag: "Held",
            reason: "busy",
            branch: head,
            detail: `${head} is checked out here; other work waits until its task lands or ends`,
          };
        }
        return { _tag: "Clean" };
      });

    /**
     * Whether a directory's tree is the task's: a linked worktree foreman made
     * for it, or the operator's checkout while it has the task's branch out.
     *
     * The operator's checkout is the task's only while it is on the task's
     * branch. Landing switches it back before it proves anything, and an
     * operator can switch by hand, and after either the edits there are the
     * operator's. Reading them as the agent's work would commit them.
     */
    const ownsTree = (directory: string, branch: string) =>
      Effect.gen(function* () {
        if ((yield* headBranch(directory)) === branch) return true;
        const [own, common] = yield* Effect.all([
          gitOutput(directory, "rev-parse", "--path-format=absolute", "--git-dir"),
          gitOutput(directory, "rev-parse", "--path-format=absolute", "--git-common-dir"),
        ]);
        return own !== common;
      });

    /**
     * Checks the operator's branch out again in a checkout that has `branch`
     * out, and says what it found. A checkout on any other branch, or a linked
     * worktree, is left as it is.
     *
     * `dirty` leaves it on the task's branch: git would carry the leftover
     * edits onto the operator's branch.
     */
    const leaveBranch = (directory: string, branch: string) =>
      Effect.gen(function* () {
        if ((yield* headBranch(directory)) !== branch) return "elsewhere" as const;
        if ((yield* status(directory, "all")) !== "") return "dirty" as const;
        yield* gitOutput(directory, "checkout", "--quiet", yield* trunkOf(directory));
        return "left" as const;
      });

    return {
      isFree,
      leaveBranch,

      /**
       * Whether the checkout has uncommitted changes, untracked files included.
       * A task starts in the operator's checkout only from a clean tree: git
       * carries edits across a branch switch, and an agent on the operator's
       * branch would commit them as its own.
       */
      dirty: (directory: string) =>
        status(directory, "all").pipe(Effect.map((text) => text !== "")),

      /** The commit HEAD names: the operator's branch tip, where a direct task works. */
      head: (directory: string) => gitOutput(directory, "rev-parse", "HEAD"),

      /**
       * The commit a branch points at, or nothing when the branch does not
       * exist. A reviewer reads this commit and an approval is bound to it.
       */
      tip: (directory: string, branch: string) =>
        git(directory, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : undefined)),
        ),

      /**
       * Whether a task worktree holds anything the agent that lived in it made.
       *
       * Untracked files count, unlike in the operator's checkout. That checkout
       * has collected untracked build output and scratch notes for months. A task worktree
       * was created empty minutes ago, so anything git does not follow arrived
       * with the agent: a new module it wrote, or the leavings of a test run it
       * got as far as starting. Either way the agent was working, which is the
       * question — and the two mistakes are not the same size. A worktree kept
       * for nothing costs disk; a worktree deleted wrongly costs the work.
       *
       * Always git: `addWorktree` makes these with `git worktree add`, so a worktree is
       * git's whatever the project checkout it came from is.
       */
      holdsWork: (directory: string, branch: string) =>
        Effect.gen(function* () {
          if (!(yield* ownsTree(directory, branch))) return false;
          return (yield* status(directory, "all")) !== "";
        }),

      /**
       * Commits everything a stopped agent left in its worktree onto the branch
       * the worktree holds, so the work outlives the agent and the next author
       * starts from it. Called only in a worktree foreman made: an attached
       * checkout is the operator's, and is never committed to.
       */
      commitWork: (directory: string, branch: string, message: string) =>
        Effect.gen(function* () {
          if (!(yield* ownsTree(directory, branch))) {
            return yield* new RepositoryError({
              directory,
              detail: `not committing: the checkout is not on ${branch}`,
            });
          }
          yield* git(directory, "add", "--all");
          yield* git(directory, "commit", "--quiet", "-m", message);
        }).pipe(Effect.asVoid),

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
       * Always git: worktrees are git's whatever records the project.
       */
      base: (directory: string, branch: string) =>
        trunkOf(directory).pipe(
          Effect.flatMap((trunk) => gitOutput(directory, "merge-base", trunk, branch)),
          Effect.map((sha) => (sha === "" ? undefined : sha)),
          Effect.orElseSucceed(() => undefined),
        ),

      /**
       * Every branch foreman owns in this checkout, and the three facts git
       * can prove about each one.
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
       * branch's tip arrives through a merge commit's second parent. A
       * fast-forward landing puts the branch's own commits on the first-parent
       * line, so a tip on that line is empty only when the branch's reflog
       * says it was created there.
       *
       * `stale` is the third: whether a branch the checkout has not taken
       * would still merge into the current tip. Every author cuts from the
       * trunk's tip, so a conflict means the trunk moved — the branch was
       * overtaken, and a review of it could never be applied. Asked with
       * `merge-tree`, which reads no index, takes no lock and cannot disturb
       * the operator's checkout. Only the branches with commits of their own
       * are asked: a merged one is already in, and an empty one still points
       * at a trunk commit, so both merge trivially.
       */
      branches: (directory: string) =>
        Effect.gen(function* () {
          const onto = yield* trunkOf(directory);
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
              `--merged=${onto}`,
              "--format=%(refname:short)",
              `refs/heads/${ours}`,
            ),
          );
          const trunk = new Set(yield* lines(directory, "rev-list", "--first-parent", onto));

          const overtaken = yield* Effect.forEach(
            refs.flatMap((ref) => {
              const [tip, branch] = ref.split(" ");
              return tip && branch && !merged.has(branch) && !trunk.has(tip) ? [branch] : [];
            }),
            (branch) =>
              git(directory, "merge-tree", "--write-tree", onto, branch).pipe(
                // 0 is a clean merge and 1 is conflicts; anything else means
                // merge-tree could not answer, which is not evidence the branch
                // would merge — but it is not a conflict either, so it reads as
                // clean, the same way an unreadable ref reads as absent.
                Effect.map(
                  (result) =>
                    [
                      branch,
                      result.exitCode === 1 ? conflictsOf(result.stdout) : undefined,
                    ] as const,
                ),
              ),
          );
          const staleByBranch = new Map(overtaken);

          // A tip on the first-parent line is a branch nobody committed to, or
          // one that landed by fast-forward. The commit git created the branch
          // at tells them apart: an untouched branch still points at it. A
          // branch whose reflog is gone has no such answer, and an unknown
          // creation is not evidence that nothing was committed.
          const untouched = new Set(
            yield* Effect.forEach(
              refs.flatMap((ref) => {
                const [tip, branch] = ref.split(" ");
                return tip && branch && trunk.has(tip) ? [[tip, branch] as const] : [];
              }),
              ([tip, branch]) =>
                createdAt(directory, branch).pipe(
                  Effect.map((created) => (created === tip ? [branch] : [])),
                ),
            ).pipe(Effect.map((found) => found.flat())),
          );

          return refs.flatMap((ref) => {
            const [tip, branch] = ref.split(" ");
            return tip && branch
              ? [
                  {
                    branch,
                    tip,
                    merged: merged.has(branch),
                    empty: untouched.has(branch),
                    stale: staleByBranch.get(branch),
                  } satisfies Branch,
                ]
              : [];
          });
        }),

      /**
       * Deletes a merged branch and the linked worktree still holding it, and
       * says whether the branch went.
       *
       * git refuses to delete a branch a worktree has checked out, and nothing
       * else takes that worktree down: a landing whose teardown failed leaves
       * it behind with a merged branch. So the worktree goes first, and only
       * when it is clean. The non-forced remove refuses uncommitted or untracked
       * work, which is then kept, and the refusal comes back as `false`.
       * `--delete` without `--force` still refuses commits the checkout lacks.
       * A refusal is an answer, not a failure, so it is never an error.
       */
      remove: (directory: string, branch: string) =>
        Effect.gen(function* () {
          yield* git(directory, "worktree", "prune");
          const listed = yield* gitOutput(directory, "worktree", "list", "--porcelain");
          // The main checkout is always listed first, and git refuses to
          // remove it, so only the linked worktrees after it are candidates.
          const linked = worktreesOf(listed)
            .slice(1)
            .find((worktree) => worktree.branch === branch);
          if (linked) {
            const removed = yield* git(directory, "worktree", "remove", linked.path);
            if (removed.exitCode !== 0) return false;
          }
          const deleted = yield* git(directory, "branch", "--delete", branch);
          return deleted.exitCode === 0;
        }),

      /**
       * Every worktree git has registered for the checkout, with the branch
       * each one has out.
       *
       * Always git: a task worktree is a git worktree, and this is the durable
       * record a task's work is found by once nothing is running in it.
       */
      worktrees: (directory: string) =>
        gitOutput(directory, "worktree", "list", "--porcelain").pipe(Effect.map(worktreesOf)),

      /**
       * Makes a task's worktree at `path` with `branch` out, cutting the
       * branch from HEAD when it does not exist yet.
       *
       * A branch that already exists is checked out as it is, because its
       * commits are an earlier attempt's work and the next agent is sent to
       * read them. Pruning first is what lets a path whose directory was
       * deleted by hand be made again.
       */
      addWorktree: (directory: string, branch: string, path: string) =>
        Effect.gen(function* () {
          yield* git(directory, "worktree", "prune");
          const exists = yield* git(
            directory,
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${branch}`,
          );
          yield* clearFor(path);
          yield* gitOutput(
            directory,
            ...(exists.exitCode === 0
              ? ["worktree", "add", path, branch]
              : ["worktree", "add", "-b", branch, path, "HEAD"]),
          );
        }),

      /**
       * Puts the operator's checkout itself on a task's branch, for a project
       * in branch mode, cutting the branch from HEAD when it does not exist.
       *
       * The branch HEAD was on becomes the task branch's upstream. That is how
       * every later step finds where the task lands (`trunkOf`), and how
       * landing returns the checkout to it, with nothing kept outside git.
       * Refuses a dirty tree, because git would carry the operator's edits
       * onto the task's branch and into the agent's commits.
       */
      checkoutBranch: (directory: string, branch: string) =>
        Effect.gen(function* () {
          const onto = yield* headBranch(directory);
          if (onto === undefined || onto.startsWith(ours)) {
            return yield* new RepositoryError({
              directory,
              detail: `cannot put the checkout on ${branch}: it is on ${onto ?? "no branch"}`,
            });
          }
          if ((yield* status(directory, "all")) !== "") {
            return yield* new RepositoryError({
              directory,
              detail: `cannot put the checkout on ${branch}: it has uncommitted changes`,
            });
          }
          const exists = yield* git(
            directory,
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${branch}`,
          );
          yield* gitOutput(
            directory,
            ...(exists.exitCode === 0
              ? ["checkout", "--quiet", branch]
              : ["checkout", "--quiet", "-b", branch]),
          );
          yield* gitOutput(directory, "branch", "--quiet", `--set-upstream-to=${onto}`, branch);
        }),

      /**
       * Deletes a task's worktree and its registration, uncommitted edits
       * included. The branch survives, so what was committed is kept.
       */
      removeWorktree: (directory: string, path: string) =>
        gitOutput(directory, "worktree", "remove", "--force", path).pipe(
          Effect.andThen(git(directory, "worktree", "prune")),
          Effect.asVoid,
        ),

      /**
       * Puts a task's worktree back on its branch: one at foreman's path that
       * was left detached or on another branch.
       *
       * Refuses when the worktree's HEAD holds commits the branch does not
       * have, because switching away would leave them reachable from nothing
       * but the reflog. Uncommitted edits travel with the switch, and git
       * refuses one they would conflict with.
       */
      restoreBranch: (path: string, branch: string) =>
        Effect.gen(function* () {
          const exists = yield* git(
            path,
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${branch}`,
          );
          if (exists.exitCode !== 0) {
            yield* gitOutput(path, "switch", "--create", branch);
            return;
          }
          const contained = yield* git(path, "merge-base", "--is-ancestor", "HEAD", branch);
          if (contained.exitCode !== 0) {
            return yield* new RepositoryError({
              directory: path,
              detail: `HEAD holds commits ${branch} does not; move them onto it by hand`,
            });
          }
          yield* gitOutput(path, "switch", branch);
        }),

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
       * The command that decides whether the project works, when it keeps one.
       *
       * A script in the project for the same reason as `setup`: how a project
       * is checked is a fact about the project. It is run in the proving
       * ground, so the copy that runs is the one in the merged tree.
       */
      verifyOf: (directory: string) =>
        fs.exists(`${directory}/${VERIFY_SCRIPT}`).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((present): string | undefined => (present ? `./${VERIFY_SCRIPT}` : undefined)),
        ),

      /**
       * The main checkout a folder sits in, or undefined when it is in none.
       *
       * The common git directory rather than the top level, because a folder
       * inside a linked worktree — a task's own space — belongs to the
       * project's checkout, not to a project of its own.
       */
      checkoutOf: (folder: string) =>
        git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir").pipe(
          Effect.map((result) =>
            result.exitCode === 0 ? path.dirname(result.stdout.trim()) : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        ),

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
       *
       * `message` is the subject of the merge commit. Without it git names the
       * commit after the detached HEAD the proof runs on, which reads as noise
       * in the operator's history.
       *
       * `commit` is what lands: the commit the reviewer approved, merged by its
       * id. `branch` is the task's branch, which a branch-mode checkout has out
       * and must leave first.
       */
      merge: (
        directory: string,
        branch: string,
        commit: string,
        verify: string | undefined,
        proving: string,
        message: string,
        how: How,
      ) =>
        Effect.gen(function* () {
          // A branch-mode task has its branch out in this checkout. Landing it
          // starts by checking the operator's branch out again, so every step
          // below runs against the operator's branch exactly as for a
          // worktree. The switch needs a clean tree: git would carry leftover
          // edits onto the operator's branch. The branch is left by its name;
          // only the commit is merged.
          if ((yield* leaveBranch(directory, branch)) === "dirty") {
            return {
              _tag: "Held",
              reason: "dirty",
              detail: `uncommitted changes on ${branch}, which must be checked out of this checkout to land`,
            } as const;
          }

          // Asked before the clean gate, because a checkout that already has
          // the commits is not going to be written to and its cleanliness is
          // beside the point. Holding here would strand the task exactly as
          // long as the operator kept editing.
          if (yield* contains(directory, commit)) return { _tag: "Present" } as const;

          const gate = yield* isFree(directory);
          if (gate._tag !== "Clean") return gate;
          return yield* gitCheckout.merge(directory, commit, verify, proving, message, how);
        }),

      /**
       * Runs a check block's `command` on `commit`, a commit of `directory`'s
       * repository, in the proving ground `proving` that landings use. Writes
       * nothing to `directory`. A flake and a failure the base shares do not
       * count against the commit, as at a landing. `base` is the commit the
       * work started from: a branch's fork point, or a direct task's first
       * author base.
       */
      check: (directory: string, commit: string, base: string, command: string, proving: string) =>
        gitCheck(proving, directory, commit, base, command),
    } as const;
  }),
}) {
  static readonly Default = Layer.effect(this, this.make).pipe(Layer.provide(BunServices.layer));
}

/**
 * How a landing puts the approved commit onto the trunk: a merge commit, or
 * the commit itself when it already has the trunk tip below it.
 */
export type How = "merge" | "fast-forward";

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

/** What a check block's command said about one commit. */
export type Checked =
  /** The proving ground could not be made ready, which says nothing about the commit. */
  | { readonly _tag: "Held"; readonly detail: string }
  /** `verified` is false when the command fails on the branch's base as well. */
  | { readonly _tag: "Passed"; readonly verified: boolean }
  | { readonly _tag: "Failed"; readonly output: string };

/** One of foreman's branches, as git sees it against the checkout's HEAD. */
export interface Branch {
  readonly branch: string;

  /** The commit the branch points at. */
  readonly tip: string;

  /** The checkout already has these commits, so the ref is free to delete. */
  readonly merged: boolean;

  /** Nothing was ever committed here: the tip is still a trunk commit. */
  readonly empty: boolean;

  /**
   * Whether the branch would still merge into the checkout's tip.
   *
   * undefined means it would, so the fleet is free to spend a review on it.
   * Present means the trunk moved and the branch cannot land, with the
   * conflicting paths and whether trunk deleted what the branch patches — the
   * fact the same sweep reads every tick, remembered nowhere.
   */
  readonly stale: Stale | undefined;
}

/** Why an unmerged branch would not land, and the problem that blocks it. */
export interface Stale {
  /** The paths both sides now claim, which is what a rebase would have to face. */
  readonly paths: ReadonlyArray<string>;

  /**
   * Whether any conflict is trunk having deleted what the branch patches.
   *
   * A different problem from a content conflict, and it needs a different
   * answer: the trunk's own refactor decided the file was gone, so the
   * branch's work on it is either superseded or must be re-expressed against
   * whatever replaced it.
   */
  readonly modifyDelete: boolean;
}

/**
 * What a conflicted `merge-tree --write-tree` run actually said, read from the
 * stable conflicted-file-info section rather than the human messages.
 *
 * Each conflicting file is one `<mode> <object> <stage> <path>` line per side
 * that still exists. A content conflict records all three stages, while a
 * modify/delete has the base and exactly one side — the other side deleted the
 * file — which is the structural fact that names it. The first line of the
 * output is the merged tree's object and is skipped.
 */
export const conflictsOf = (output: string): Stale => {
  const stages = new Map<string, Set<string>>();
  for (const line of output.split("\n").slice(1)) {
    const entry = /^[0-7]{6} [0-9a-f]+ ([123])\t(.*)$/.exec(line);
    if (!entry) continue;
    const present = stages.get(entry[2]!) ?? new Set<string>();
    present.add(entry[1]!);
    stages.set(entry[2]!, present);
  }
  return {
    paths: [...stages.keys()],
    modifyDelete: [...stages.values()].some((present) => present.size === 2 && present.has("1")),
  };
};

/** One worktree git has registered: where it is and which branch it has out. */
export interface Worktree {
  readonly path: string;

  /** The short branch name, absent for a detached worktree. */
  readonly branch: string | undefined;

  /** Registered at a directory that is gone: nothing to adopt or remove. */
  readonly prunable: boolean;
}

/**
 * Reads `git worktree list --porcelain`: one blank-line-separated record per
 * worktree, the main checkout first.
 */
export const worktreesOf = (output: string): ReadonlyArray<Worktree> =>
  output
    .split(/\n\s*\n/)
    .map((record) => record.split("\n"))
    .flatMap((lines) => {
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      if (path === undefined) return [];
      const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
      return [
        {
          path,
          branch: ref?.replace(/^refs\/heads\//, ""),
          prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
        },
      ];
    });

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  directory: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `${this.directory}: ${this.detail}`;
  }
}
