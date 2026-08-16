import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Repository } from "./repository.ts";

const isClean = (directory: string) =>
  Effect.runPromise(Repository.isClean(directory).pipe(Effect.provide(Repository.Default)));

const holdsWork = (directory: string) =>
  Effect.runPromise(Repository.holdsWork(directory).pipe(Effect.provide(Repository.Default)));

const merge = (directory: string, branch: string, verify?: string) =>
  Effect.runPromise(
    Repository.merge(directory, branch, verify).pipe(Effect.provide(Repository.Default)),
  );

const setup = (directory: string) =>
  Effect.runPromise(Repository.setup(directory).pipe(Effect.provide(Repository.Default)));

const branches = (directory: string) =>
  Effect.runPromise(Repository.branches(directory).pipe(Effect.provide(Repository.Default)));

const remove = (directory: string, branch: string) =>
  Effect.runPromise(Repository.remove(directory, branch).pipe(Effect.provide(Repository.Default)));

const sweep = (directory: string) =>
  Effect.runPromise(
    Repository.sweepUnpublishedMerges(directory).pipe(Effect.provide(Repository.Default)),
  );

const directory = await mkdtemp(join(tmpdir(), "foreman-repository-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

const git = (...args: Array<string>) => Bun.$`git -C ${directory} ${args}`.quiet().nothrow();

describe("Repository", () => {
  test("holds a checkout the operator is editing, and frees it again", async () => {
    await git("init", "-q");
    await git("config", "user.email", "foreman@test");
    await git("config", "user.name", "foreman");
    await writeFile(join(directory, "tracked.txt"), "committed\n");
    await git("add", "tracked.txt");
    await git("commit", "-qm", "initial");

    expect(await isClean(directory)).toBe(true);

    // Scratch files live in a repository for months. They are not somebody
    // mid-edit, and holding a project for one would hold it forever.
    await writeFile(join(directory, "scratch.md"), "notes\n");
    expect(await isClean(directory)).toBe(true);

    await writeFile(join(directory, "tracked.txt"), "being edited\n");
    expect(await isClean(directory)).toBe(false);

    await git("checkout", "--", "tracked.txt");
    expect(await isClean(directory)).toBe(true);
  });

  test("does not refresh the index while checking cleanliness", async () => {
    const tracked = join(directory, "tracked.txt");
    const index = join(directory, ".git", "index");

    // A newer worktree timestamp makes plain `git status` refresh the index.
    await utimes(tracked, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    const before = (await stat(index)).ino;

    expect(await isClean(directory)).toBe(true);
    expect((await stat(index)).ino).toBe(before);
  });

  test("merges only into a clean checkout", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "reviewed");
    await writeFile(join(directory, "reviewed.txt"), "approved\n");
    await git("add", "reviewed.txt");
    await git("commit", "-qm", "reviewed work");
    await git("checkout", "-q", base);

    await writeFile(join(directory, "tracked.txt"), "operator edit\n");
    expect(await merge(directory, "reviewed")).toEqual({ _tag: "Held", detail: undefined });
    expect((await git("branch", "--show-current")).stdout.toString().trim()).toBe(base);

    await git("checkout", "--", "tracked.txt");
    expect(await merge(directory, "reviewed")).toEqual({ _tag: "Merged", verified: false });
    expect(await Bun.file(join(directory, "reviewed.txt")).text()).toBe("approved\n");
  });

  test("undoes a merge that turns a green checkout red", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    const before = (await git("rev-parse", "HEAD")).stdout.toString().trim();

    await git("checkout", "-qb", "breaks");
    await writeFile(join(directory, "broken.txt"), "boom\n");
    await git("add", "broken.txt");
    await git("commit", "-qm", "breaks the build");
    await git("checkout", "-q", base);

    // Green until the branch's file exists, red once it does — so the same
    // command answers differently either side of the merge, which is the whole
    // signal the gate reads.
    expect(await merge(directory, "breaks", "test ! -f broken.txt")).toMatchObject({
      _tag: "Broke",
    });
    expect((await git("rev-parse", "HEAD")).stdout.toString().trim()).toBe(before);
    expect(await Bun.file(join(directory, "broken.txt")).exists()).toBe(false);
    expect(await isClean(directory)).toBe(true);
  });

  test("lands a branch that keeps the checkout green, and says it verified", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "harmless");
    await writeFile(join(directory, "harmless.txt"), "fine\n");
    await git("add", "harmless.txt");
    await git("commit", "-qm", "harmless work");
    await git("checkout", "-q", base);

    expect(await merge(directory, "harmless", "true")).toEqual({ _tag: "Merged", verified: true });
    expect(await Bun.file(join(directory, "harmless.txt")).text()).toBe("fine\n");
  });

  test("lands into a checkout that was already red, and says it did not verify", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "innocent");
    await writeFile(join(directory, "innocent.txt"), "fine\n");
    await git("add", "innocent.txt");
    await git("commit", "-qm", "innocent work");
    await git("checkout", "-q", base);

    // A branch cannot be blamed for damage that predates it, and gating on an
    // absolute pass would freeze the fleet behind one broken test forever.
    expect(await merge(directory, "innocent", "false")).toEqual({
      _tag: "Merged",
      verified: false,
    });
    expect(await Bun.file(join(directory, "innocent.txt")).text()).toBe("fine\n");
  });

  // The baseline is what the whole fleet waits out: the tick is one fiber, so
  // a verification run is a run during which nothing else is dispatched,
  // settled or landed. A merge that passes has already answered the only
  // question the baseline exists to answer, so it is never asked.
  test("pays for the baseline only when the merged checkout is red", async () => {
    const counter = join(tmpdir(), `foreman-verify-${process.pid}.count`);
    const runs = async () =>
      (await Bun.file(counter).exists()) ? (await Bun.file(counter).text()).length : 0;
    const count = (command: string) => `printf x >> ${counter}; ${command}`;

    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "counted");
    await writeFile(join(directory, "counted.txt"), "fine\n");
    await git("add", "counted.txt");
    await git("commit", "-qm", "counted work");
    await git("checkout", "-q", base);

    expect(await merge(directory, "counted", count("true"))).toEqual({
      _tag: "Merged",
      verified: true,
    });
    expect(await runs()).toBe(1);

    await git("checkout", "-qb", "counted-breaks");
    await writeFile(join(directory, "counted-broken.txt"), "boom\n");
    await git("add", "counted-broken.txt");
    await git("commit", "-qm", "breaks the build");
    await git("checkout", "-q", base);

    // Red after the merge and green before it: the second run is the branch's
    // accusation being tested, and it is only ever spent on a failure.
    expect(
      await merge(directory, "counted-breaks", count("test ! -f counted-broken.txt")),
    ).toMatchObject({ _tag: "Broke" });
    expect(await runs()).toBe(3);

    await rm(counter, { force: true });
  });

  // A landing is several steps, and only the merge is atomic. Interrupt it
  // after the merge — a stranded index.lock is enough — and the commits are in
  // while the task still reads as awaiting one, so every later tick lands the
  // same branch again. Re-merging is a no-op, but re-verifying is not: it is a
  // full suite run the whole fleet waits out, forever, for a task that is done.
  test("completes a branch the checkout already has, without merging or verifying", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "twice");
    await writeFile(join(directory, "twice.txt"), "once\n");
    await git("add", "twice.txt");
    await git("commit", "-qm", "work landed once");
    await git("checkout", "-q", base);

    expect(await merge(directory, "twice", "true")).toEqual({ _tag: "Merged", verified: true });
    const landed = (await git("rev-parse", "HEAD")).stdout.toString().trim();

    const sentinel = join(tmpdir(), `foreman-present-${process.pid}`);
    expect(await merge(directory, "twice", `touch ${sentinel}`)).toEqual({ _tag: "Present" });
    expect(await Bun.file(sentinel).exists()).toBe(false);
    expect((await git("rev-parse", "HEAD")).stdout.toString().trim()).toBe(landed);

    // Asked ahead of the clean gate, because a checkout that already has the
    // commits is not going to be written to. Holding here would strand the
    // task for as long as the operator kept editing.
    await writeFile(join(directory, "tracked.txt"), "operator edit\n");
    expect(await merge(directory, "twice", "true")).toEqual({ _tag: "Present" });
    await git("checkout", "--", "tracked.txt");
  });

  test("tells an untouched branch from one whose work already landed", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();

    // Three foreman branches, one of each kind the tick has to tell apart.
    await git("checkout", "-qb", "foreman/ts-aaaaaa");
    await writeFile(join(directory, "stranded.txt"), "abandoned\n");
    await git("add", "stranded.txt");
    await git("commit", "-qm", "work nobody landed");

    await git("checkout", "-qb", "foreman/ts-bbbbbb", base);

    await git("checkout", "-qb", "foreman/ts-cccccc", base);
    await writeFile(join(directory, "landed.txt"), "reviewed\n");
    await git("add", "landed.txt");
    await git("commit", "-qm", "work that got merged");

    await git("checkout", "-q", base);
    // Somebody's own topic branch is never foreman's to read or delete.
    await git("branch", "mine");
    expect(await merge(directory, "foreman/ts-cccccc")).toMatchObject({ _tag: "Merged" });

    // The merged branch is the one that used to read as an author who wrote
    // nothing: its commits are in the checkout, so it is not unmerged — and
    // reading that as an empty branch sent finished work back to the queue.
    expect(await branches(directory)).toEqual([
      { branch: "foreman/ts-aaaaaa", merged: false, empty: false },
      { branch: "foreman/ts-bbbbbb", merged: true, empty: true },
      { branch: "foreman/ts-cccccc", merged: true, empty: false },
    ]);
  });

  test("deletes a merged branch and refuses one holding the only copy", async () => {
    expect(await remove(directory, "foreman/ts-bbbbbb")).toBe(true);
    expect(await remove(directory, "foreman/ts-cccccc")).toBe(true);
    // git itself is the guard: --delete refuses commits the checkout lacks.
    expect(await remove(directory, "foreman/ts-aaaaaa")).toBe(false);

    const remaining = (await git("branch", "--format=%(refname:short)")).stdout.toString();
    expect(remaining).toContain("foreman/ts-aaaaaa");
    expect(remaining).toContain("mine");
    expect(remaining).not.toContain("foreman/ts-bbbbbb");
  });

  test("aborts a conflicting merge", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "conflicting");
    await writeFile(join(directory, "tracked.txt"), "branch change\n");
    await git("commit", "-qam", "branch conflict");
    await git("checkout", "-q", base);
    await writeFile(join(directory, "tracked.txt"), "target change\n");
    await git("commit", "-qam", "target conflict");

    expect(await merge(directory, "conflicting")).toMatchObject({ _tag: "Rejected" });
    expect(await isClean(directory)).toBe(true);
    expect((await git("rev-parse", "-q", "--verify", "MERGE_HEAD")).exitCode).not.toBe(0);
  });

  // Its own checkout: this is the opposite question to the one every test above
  // asks, and it must not read the untracked files they leave lying around.
  test("counts an untracked file in a worktree as work worth keeping", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "foreman-worktree-"));
    const there = (...args: Array<string>) => Bun.$`git -C ${worktree} ${args}`.quiet().nothrow();

    await there("init", "-q");
    await there("config", "user.email", "foreman@test");
    await there("config", "user.name", "foreman");
    await writeFile(join(worktree, "tracked.txt"), "committed\n");
    await there("add", "tracked.txt");
    await there("commit", "-qm", "initial");

    expect(await holdsWork(worktree)).toBe(false);

    // A new file is the most common thing an author makes and the one git says
    // least about. isClean deliberately ignores it; here it is the whole point.
    await writeFile(join(worktree, "new-test.ts"), "expect(1).toBe(1)\n");
    expect(await holdsWork(worktree)).toBe(true);
    expect(await isClean(worktree)).toBe(true);

    await rm(join(worktree, "new-test.ts"));
    await writeFile(join(worktree, "tracked.txt"), "half an edit\n");
    expect(await holdsWork(worktree)).toBe(true);

    await rm(worktree, { recursive: true, force: true });
  });

  // The branch to land on is the one HEAD names. A detached HEAD names none,
  // and git merges into it anyway: the commits land, the operator's branch
  // stays behind, and the sweep then deletes the only ref that reached them.
  test("holds a checkout whose HEAD is not on a branch", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    expect(await isClean(directory)).toBe(true);

    await git("checkout", "-q", "--detach", "HEAD");
    expect(await isClean(directory)).toBe(false);

    await git("checkout", "-q", base);
    expect(await isClean(directory)).toBe(true);
  });
});

// jj colocated with git is the shape most of these projects are in, and it is
// not a variation on the git path: jj has no checked-out branch to merge into,
// records conflicts instead of refusing them, and keeps the working copy as a
// commit rather than as loose edits.
const colocated = await mkdtemp(join(tmpdir(), "foreman-jj-"));
afterAll(() => rm(colocated, { recursive: true, force: true }));

// jj's first commands in a fresh repo snapshot the working copy and build the
// index, which intermittently runs past bun's 5s default — and a test that times
// out here kills the jj child mid-merge, so the failure reads as a merge fault.
const slowly = 30_000;

describe("Repository over a jj-colocated checkout", () => {
  const there = (...args: Array<string>) => Bun.$`git -C ${colocated} ${args}`.quiet().nothrow();
  const jj = (...args: Array<string>) =>
    Bun.$`jj ${args}`
      .cwd(colocated)
      .env({ ...process.env, JJ_USER: "foreman", JJ_EMAIL: "foreman@test" })
      .quiet()
      .nothrow();

  const bookmark = async (name: string) =>
    (await jj("log", "-r", name, "--no-graph", "-T", "commit_id")).stdout.toString().trim();

  test(
    "lands a branch by moving the bookmark the operator is standing on",
    async () => {
      await there("init", "-q");
      await there("config", "user.email", "foreman@test");
      await there("config", "user.name", "foreman");
      await writeFile(join(colocated, "tracked.txt"), "committed\n");
      await there("add", "tracked.txt");
      await there("commit", "-qm", "initial");
      await there("branch", "-M", "develop");
      await there("checkout", "-qb", "foreman/ts-aaaaaa");
      await writeFile(join(colocated, "landed.txt"), "author work\n");
      await there("add", "landed.txt");
      await there("commit", "-qm", "author work");
      await there("checkout", "-q", "develop");
      await jj("git", "init");

      const before = await bookmark("develop");
      expect(await isClean(colocated)).toBe(true);

      expect(await merge(colocated, "foreman/ts-aaaaaa", "true")).toEqual({
        _tag: "Merged",
        verified: true,
      });

      // The point of the whole path: the operator's bookmark moved, and git can
      // see the merge on it. Landing onto a commit no branch names is the bug.
      expect(await bookmark("develop")).not.toBe(before);
      expect((await there("log", "--format=%s", "-1", "develop")).stdout.toString().trim()).toBe(
        "Merge branch 'foreman/ts-aaaaaa'",
      );
      expect(await Bun.file(join(colocated, "landed.txt")).text()).toBe("author work\n");

      // A branch that landed must not read as a branch nobody committed to.
      expect(await branches(colocated)).toEqual([
        { branch: "foreman/ts-aaaaaa", merged: true, empty: false },
      ]);
    },
    slowly,
  );

  // jj does not refuse a conflicting merge; it records the conflict and writes
  // markers into the files. Backing out is foreman's job, or the operator finds
  // conflict markers in a checkout they never merged anything into.
  test(
    "backs out a conflicting merge and leaves no markers behind",
    async () => {
      // A sibling of the temp checkout, so a run that dies midway cannot leave a
      // path behind that the next run collides with.
      const side = `${colocated}-side`;
      await there("branch", "foreman/ts-bbbbbb", "develop");
      await there("worktree", "add", "-q", side, "foreman/ts-bbbbbb");
      await writeFile(join(side, "tracked.txt"), "theirs\n");
      await Bun.$`git -C ${side} commit -qam theirs`.quiet().nothrow();
      await Bun.$`git -C ${colocated} worktree remove ${side}`.quiet().nothrow();

      await writeFile(join(colocated, "tracked.txt"), "ours\n");
      await jj("bookmark", "set", "develop", "-r", "@");
      await jj("new");
      const before = await bookmark("develop");

      const rejected = await merge(colocated, "foreman/ts-bbbbbb", undefined);
      expect(rejected).toMatchObject({ _tag: "Rejected" });
      // Rejected for the right reason: jj recorded a conflict, rather than the
      // merge command itself failing to run.
      expect(rejected).toHaveProperty("detail", expect.stringContaining("conflict"));
      expect(await bookmark("develop")).toBe(before);
      expect(await Bun.file(join(colocated, "tracked.txt")).text()).toBe("ours\n");
      expect(await isClean(colocated)).toBe(true);
    },
    slowly,
  );

  // Under git this file would be untracked and ignored. Under jj it is already
  // part of the working-copy commit, and landing would carry it out of the
  // operator's directory.
  test(
    "holds a checkout whose working copy is not empty",
    async () => {
      await writeFile(join(colocated, "half-an-edit.ts"), "export const x = 1\n");
      expect(await isClean(colocated)).toBe(false);

      await rm(join(colocated, "half-an-edit.ts"));
      expect(await isClean(colocated)).toBe(true);
    },
    slowly,
  );

  // Every author's branch is cut from the trunk's tip, so until that author
  // commits its bookmark sits on the very commit the trunk names. Counting it
  // as a second candidate held the project for as long as anyone worked in it,
  // which is a fleet that stops landing the moment it starts working.
  test(
    "lands while an author's fresh branch shares the trunk's commit",
    async () => {
      await there("branch", "foreman/ts-dddddd", "develop");

      const side = `${colocated}-fresh`;
      await there("branch", "foreman/ts-eeeeee", "develop");
      await there("worktree", "add", "-q", side, "foreman/ts-eeeeee");
      await writeFile(join(side, "reviewed.txt"), "approved\n");
      await Bun.$`git -C ${side} add reviewed.txt`.quiet().nothrow();
      await Bun.$`git -C ${side} commit -qm reviewed`.quiet().nothrow();
      await Bun.$`git -C ${colocated} worktree remove ${side}`.quiet().nothrow();

      const before = await bookmark("develop");
      expect(await isClean(colocated)).toBe(true);

      expect(await merge(colocated, "foreman/ts-eeeeee", undefined)).toEqual({
        _tag: "Merged",
        verified: false,
      });
      expect(await bookmark("develop")).not.toBe(before);
      expect(await Bun.file(join(colocated, "reviewed.txt")).text()).toBe("approved\n");
    },
    slowly,
  );

  // A landing is three steps and only the last publishes. Killed between them —
  // which is exactly what `bun --watch` does when foreman lands into its own
  // checkout, because writing the merged files restarts the daemon — the merge
  // sits as an anonymous head nobody names. The retry lands the branch honestly,
  // so the leftover is swept rather than kept.
  test(
    "sweeps the merge an interrupted landing leaves, but not the one still in flight",
    async () => {
      const side = `${colocated}-sweep`;
      await there("branch", "foreman/ts-sweep", "develop");
      await there("worktree", "add", "-q", side, "foreman/ts-sweep");
      await writeFile(join(side, "swept.txt"), "work\n");
      await Bun.$`git -C ${side} add swept.txt`.quiet().nothrow();
      await Bun.$`git -C ${side} commit -qm swept`.quiet().nothrow();
      await Bun.$`git -C ${colocated} worktree remove ${side}`.quiet().nothrow();

      // The daemon dies here, between `jj new` and `bookmark set`: the merge
      // exists, the working copy is standing on it, and develop never moved.
      await jj("new", "develop", "foreman/ts-sweep", "-m", "Merge branch 'foreman/ts-sweep'");
      const inFlight = await bookmark("@");
      expect(await sweep(colocated)).toEqual([]);
      // The working copy is the one anonymous head a person may be standing on;
      // it is the next tick's landing, not litter, so the sweep leaves it.
      expect(await bookmark("@")).toBe(inFlight);

      // The retry lands: `jj new` moves the working copy off the old merge,
      // which now reads as exactly the litter the sweep exists for.
      await jj("new", "develop", "foreman/ts-sweep", "-m", "Merge branch 'foreman/ts-sweep'");
      expect(await sweep(colocated)).toEqual([inFlight]);
      const remaining = (
        await jj(
          "log",
          "-r",
          "heads(all()) & ~bookmarks() & ~working_copies()",
          "--no-graph",
          "-T",
          "commit_id",
        )
      ).stdout.toString();
      expect(remaining).not.toContain(inFlight);

      await jj("bookmark", "set", "develop", "-r", "@");
      await jj("new");
    },
    slowly,
  );

  // The guard is not about keeping work — an empty merge's content is derived
  // from its parents, so nothing would be lost — but about leaving anonymous
  // merges the operator made for themselves alone. Only the shape and the
  // description `merge` itself writes are swept.
  test(
    "leaves an anonymous merge that is not a foreman landing alone",
    async () => {
      await there("branch", "mine", "develop");

      // An operator's own merge: empty, two parents, not foreman's description.
      await jj("new", "develop", "mine", "-m", "unrelated merge");
      const unrelated = await bookmark("@");
      await jj("new", "develop");

      // Foreman's description but manual work in it — no landing writes content
      // a parent does not already hold, so this is not one either.
      await jj("new", "develop", "mine", "-m", "Merge branch 'foreman/ts-sweep'");
      await writeFile(join(colocated, "manual.txt"), "resolved by hand\n");
      const manual = await bookmark("@");
      await jj("new", "develop");

      expect(await sweep(colocated)).toEqual([]);
      const remaining = (
        await jj(
          "log",
          "-r",
          "heads(all()) & ~bookmarks() & ~working_copies()",
          "--no-graph",
          "-T",
          "commit_id",
        )
      ).stdout.toString();
      expect(remaining).toContain(unrelated);
      expect(remaining).toContain(manual);

      await jj("bookmark", "set", "develop", "-r", "@");
      await jj("new");
    },
    slowly,
  );
});

// The setup script is how a project says what a bare worktree is missing.
// Foreman runs it and reports; it never guesses the command, because the
// project is what knows how to build itself.
const fresh = await mkdtemp(join(tmpdir(), "foreman-setup-"));
afterAll(() => rm(fresh, { recursive: true, force: true }));

describe("Repository.setup", () => {
  const script = join(fresh, "scripts", "worktree-setup.sh");
  const write = (body: string) => writeFile(script, body, { mode: 0o755 });

  test("says nothing when the project keeps no script", async () => {
    expect(await setup(fresh)).toBeUndefined();
  });

  test("runs the script from the worktree it is setting up", async () => {
    await mkdir(join(fresh, "scripts"), { recursive: true });
    await write("#!/bin/sh\npwd > ran.txt\n");

    expect(await setup(fresh)).toMatchObject({ passed: true });
    expect((await Bun.file(join(fresh, "ran.txt")).text()).trim()).toBe(fresh);
  });

  // A worktree that cannot build is not the task's fault, so the output has to
  // survive: it is the only evidence of why the dispatch did not happen.
  test("reports a failing script with its output", async () => {
    await write("#!/bin/sh\necho 'no zig toolchain' >&2\nexit 1\n");

    const result = await setup(fresh);
    expect(result).toMatchObject({ passed: false });
    expect(result?.output).toContain("no zig toolchain");
  });
});
