import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Repository } from "./repository.ts";

const isClean = (directory: string) =>
  Effect.runPromise(Repository.isClean(directory).pipe(Effect.provide(Repository.Default)));

/** The clean answer every assertion below that is not a hold expects. */
const clean = { _tag: "Clean" } as const;

const dirty = {
  _tag: "Held",
  reason: "dirty",
  detail: "uncommitted changes to tracked files",
} as const;

const detached = {
  _tag: "Held",
  reason: "noBranch",
  detail: "no checked-out branch (detached HEAD)",
} as const;

const dirtyJJ = {
  _tag: "Held",
  reason: "dirty",
  detail: "uncommitted changes in the working copy",
} as const;

const holdsWork = (directory: string) =>
  Effect.runPromise(Repository.holdsWork(directory).pipe(Effect.provide(Repository.Default)));

// Nested under a directory that does not exist, because the real ground lives
// at $XDG_STATE_HOME/foreman/verify/<project> and nothing makes that first.
const groundFor = (directory: string) => `${directory}.grounds/verify`;

const merge = (directory: string, branch: string, verify?: string) =>
  Effect.runPromise(
    Repository.merge(directory, branch, verify, groundFor(directory)).pipe(
      Effect.provide(Repository.Default),
    ),
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
afterAll(() =>
  Promise.all(
    [directory, `${directory}.grounds`].map((path) => rm(path, { recursive: true, force: true })),
  ),
);

const git = (...args: Array<string>) => Bun.$`git -C ${directory} ${args}`.quiet().nothrow();

describe("Repository", () => {
  test("holds a checkout the operator is editing, and frees it again", async () => {
    await git("init", "-q");
    await git("config", "user.email", "foreman@test");
    await git("config", "user.name", "foreman");
    await writeFile(join(directory, "tracked.txt"), "committed\n");
    await git("add", "tracked.txt");
    await git("commit", "-qm", "initial");

    expect(await isClean(directory)).toEqual(clean);

    // Scratch files live in a repository for months. They are not somebody
    // mid-edit, and holding a project for one would hold it forever.
    await writeFile(join(directory, "scratch.md"), "notes\n");
    expect(await isClean(directory)).toEqual(clean);

    await writeFile(join(directory, "tracked.txt"), "being edited\n");
    expect(await isClean(directory)).toEqual(dirty);

    await git("checkout", "--", "tracked.txt");
    expect(await isClean(directory)).toEqual(clean);
  });

  test("does not refresh the index while checking cleanliness", async () => {
    const tracked = join(directory, "tracked.txt");
    const index = join(directory, ".git", "index");

    // A newer worktree timestamp makes plain `git status` refresh the index.
    await utimes(tracked, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    const before = (await stat(index)).ino;

    expect(await isClean(directory)).toEqual(clean);
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
    expect(await merge(directory, "reviewed")).toEqual(dirty);
    expect((await git("branch", "--show-current")).stdout.toString().trim()).toBe(base);

    await git("checkout", "--", "tracked.txt");
    expect(await merge(directory, "reviewed")).toEqual({ _tag: "Merged", verified: false });
    expect(await Bun.file(join(directory, "reviewed.txt")).text()).toBe("approved\n");
  });

  test("never touches the checkout for a merge that turns the project red", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    const before = (await git("rev-parse", "HEAD")).stdout.toString().trim();

    await git("checkout", "-qb", "breaks");
    await writeFile(join(directory, "broken.txt"), "boom\n");
    await git("add", "broken.txt");
    await git("commit", "-qm", "breaks the build");
    await git("checkout", "-q", base);

    // Green until the branch's file exists, red once it does — so the same
    // command answers differently either side of the merge, which is the whole
    // signal the gate reads. It is answered in the proving ground, so the
    // checkout below is untouched rather than restored.
    expect(await merge(directory, "breaks", "test ! -f broken.txt")).toMatchObject({
      _tag: "Broke",
    });
    expect((await git("rev-parse", "HEAD")).stdout.toString().trim()).toBe(before);
    expect(await Bun.file(join(directory, "broken.txt")).exists()).toBe(false);
    expect(await isClean(directory)).toEqual(clean);
  });

  // The operator shares this checkout, and a suite spawning its own processes
  // in it is what strands the index.lock the landing then trips over. So the
  // command must observe the proving ground, never the directory it lands in.
  test("runs verify somewhere other than the checkout it lands in", async () => {
    const seen = join(tmpdir(), `foreman-where-${process.pid}.txt`);
    const base = (await git("branch", "--show-current")).stdout.toString().trim();

    await git("checkout", "-qb", "elsewhere");
    await writeFile(join(directory, "elsewhere.txt"), "work\n");
    await git("add", "elsewhere.txt");
    await git("commit", "-qm", "elsewhere");
    await git("checkout", "-q", base);

    expect(await merge(directory, "elsewhere", `pwd > ${seen}`)).toEqual({
      _tag: "Merged",
      verified: true,
    });
    expect((await Bun.file(seen).text()).trim()).not.toBe(directory);
    await rm(seen, { force: true });
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

    // Red after the merge and green before it: the failure is confirmed once
    // before it becomes the branch's accusation, and the baseline is only ever
    // spent on a confirmed failure.
    expect(
      await merge(directory, "counted-breaks", count("test ! -f counted-broken.txt")),
    ).toMatchObject({ _tag: "Broke" });
    expect(await runs()).toBe(4);

    await rm(counter, { force: true });
  });

  // A suite that fails and then passes on the same tree found nothing. Without
  // the retry a correct branch is returned to the queue, and the task climbs a
  // rung on evidence the project's own flaky test wrote.
  test("lands a branch whose verification failed once and then passed", async () => {
    const counter = join(tmpdir(), `foreman-flake-${process.pid}.count`);
    const runs = async () =>
      (await Bun.file(counter).exists()) ? (await Bun.file(counter).text()).length : 0;
    const flaky = `printf x >> ${counter}; test $(wc -c < ${counter}) -gt 1`;

    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "flaky");
    await writeFile(join(directory, "flaky.txt"), "fine\n");
    await git("add", "flaky.txt");
    await git("commit", "-qm", "flaky work");
    await git("checkout", "-q", base);

    expect(await merge(directory, "flaky", flaky)).toEqual({ _tag: "Merged", verified: true });
    expect(await runs()).toBe(2);
    expect(await Bun.file(join(directory, "flaky.txt")).text()).toBe("fine\n");

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
      { branch: "foreman/ts-aaaaaa", merged: false, empty: false, stale: undefined },
      { branch: "foreman/ts-bbbbbb", merged: true, empty: true, stale: undefined },
      { branch: "foreman/ts-cccccc", merged: true, empty: false, stale: undefined },
    ]);
  });

  test("says which unmerged branches the trunk has overtaken", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();

    // Two files the branches will diverge over: one the trunk deletes, one it
    // edits too.
    await writeFile(join(directory, "touched.txt"), "as committed\n");
    await writeFile(join(directory, "shared.txt"), "as committed\n");
    await git("add", "touched.txt", "shared.txt");
    await git("commit", "-qm", "files the branches will diverge over");

    // One branch patches a file the trunk will delete; the other edits a file
    // the trunk will edit too.
    await git("checkout", "-qb", "foreman/ts-stale-del", base);
    await writeFile(join(directory, "touched.txt"), "branch patches\n");
    await git("commit", "-qam", "branch patches a file");

    await git("checkout", "-qb", "foreman/ts-stale-con", base);
    await writeFile(join(directory, "shared.txt"), "branch version\n");
    await git("commit", "-qam", "branch edits a file");

    // The trunk moves: it deletes the file the first branch patches, and
    // edits the file the second branch edits, into a different shape.
    await git("checkout", "-q", base);
    await git("rm", "-q", "touched.txt");
    await writeFile(join(directory, "shared.txt"), "trunk version\n");
    await git("commit", "-qam", "trunk deletes and edits");

    const found = await branches(directory);
    const byName = (name: string) => found.find((entry) => entry.branch === name);

    // A branch patching what the trunk deleted is a modify/delete conflict,
    // which is a different problem from a content conflict: the trunk's own
    // refactor decided the file was gone.
    expect(byName("foreman/ts-stale-del")).toEqual({
      branch: "foreman/ts-stale-del",
      merged: false,
      empty: false,
      stale: { paths: ["touched.txt"], modifyDelete: true },
    });
    expect(byName("foreman/ts-stale-con")).toEqual({
      branch: "foreman/ts-stale-con",
      merged: false,
      empty: false,
      stale: { paths: ["shared.txt"], modifyDelete: false },
    });
    // A branch the trunk has not moved past still merges, and so reads as
    // not stale rather than as anything worse.
    expect(byName("foreman/ts-aaaaaa")?.stale).toBeUndefined();
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
    expect(await isClean(directory)).toEqual(clean);
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
    expect(await isClean(worktree)).toEqual(clean);

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
    expect(await isClean(directory)).toEqual(clean);

    await git("checkout", "-q", "--detach", "HEAD");
    expect(await isClean(directory)).toEqual(detached);

    await git("checkout", "-q", base);
    expect(await isClean(directory)).toEqual(clean);
  });

  // The litter sweep exists for jj's three-step landing, whose middle is
  // interruptible. A git merge is one atomic command, so there is nothing for
  // the sweep to find in a checkout git alone is keeping.
  test("sweeps nothing in a git-only checkout", async () => {
    expect(await sweep(directory)).toEqual([]);
  });
});

// jj colocated with git is the shape most of these projects are in, and it is
// not a variation on the git path: jj has no checked-out branch to merge into,
// records conflicts instead of refusing them, and keeps the working copy as a
// commit rather than as loose edits.
const colocated = await mkdtemp(join(tmpdir(), "foreman-jj-"));
afterAll(() =>
  Promise.all(
    [colocated, `${colocated}.grounds`].map((path) => rm(path, { recursive: true, force: true })),
  ),
);

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
      expect(await isClean(colocated)).toEqual(clean);

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

      // A landing must never hold the project it just landed in. The trunk is
      // the nearest bookmark behind `@`, so a working copy left behind the
      // bookmark it moved has no trunk to find, and no later tick can recover.
      expect(await isClean(colocated)).toEqual(clean);

      // A branch that landed must not read as a branch nobody committed to.
      expect(await branches(colocated)).toEqual([
        { branch: "foreman/ts-aaaaaa", merged: true, empty: false, stale: undefined },
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
      expect(await isClean(colocated)).toEqual(clean);
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
      expect(await isClean(colocated)).toEqual(dirtyJJ);

      await rm(join(colocated, "half-an-edit.ts"));
      expect(await isClean(colocated)).toEqual(clean);
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
      expect(await isClean(colocated)).toEqual(clean);

      expect(await merge(colocated, "foreman/ts-eeeeee", undefined)).toEqual({
        _tag: "Merged",
        verified: false,
      });
      expect(await bookmark("develop")).not.toBe(before);
      expect(await Bun.file(join(colocated, "reviewed.txt")).text()).toBe("approved\n");
    },
    slowly,
  );

  // The incident behind the trunk filter: an author's branch sat ahead of
  // develop and the operator's working copy came to rest on it. heads() dropped
  // develop as already-merged, the filter removed the only name left, and a
  // checkout jj reported as clean stayed held forever. The trunk is still
  // nameable — it is the non-foreman bookmark that is the head behind the
  // working copy — so filtering happens before heads computes candidates.
  test(
    "frees a checkout parked on a foreman bookmark and lands past it",
    async () => {
      const parked = await mkdtemp(join(tmpdir(), "foreman-parked-"));
      try {
        const here = (...args: Array<string>) => Bun.$`git -C ${parked} ${args}`.quiet().nothrow();
        const jjHere = (...args: Array<string>) =>
          Bun.$`jj ${args}`
            .cwd(parked)
            .env({ ...process.env, JJ_USER: "foreman", JJ_EMAIL: "foreman@test" })
            .quiet();
        const bookmarkHere = async (name: string) =>
          (await jjHere("log", "-r", name, "--no-graph", "-T", "commit_id")).stdout
            .toString()
            .trim();

        await here("init", "-q");
        await here("config", "user.email", "foreman@test");
        await here("config", "user.name", "foreman");
        await writeFile(join(parked, "tracked.txt"), "committed\n");
        await here("add", "tracked.txt");
        await here("commit", "-qm", "initial");
        await here("branch", "-M", "develop");
        await jjHere("git", "init");

        // An author's branch twelve commits ahead of develop, cut from its tip.
        await here("checkout", "-qb", "foreman/ts-cccccc", "develop");
        for (let i = 0; i < 12; i++) {
          await writeFile(join(parked, `step-${i}.txt`), `${i}\n`);
          await here("add", "-A");
          await here("commit", "-qm", `step ${i}`);
        }
        await here("checkout", "-q", "develop");

        // A sibling branch to land, so the merge gate runs rather than
        // answering "already merged" first.
        const side = `${parked}-side`;
        await here("branch", "foreman/ts-merge", "develop");
        await here("worktree", "add", "-q", side, "foreman/ts-merge");
        await writeFile(join(side, "landed.txt"), "approved\n");
        await Bun.$`git -C ${side} add landed.txt`.quiet().nothrow();
        await Bun.$`git -C ${side} commit -qm approved`.quiet().nothrow();
        await Bun.$`git -C ${parked} worktree remove ${side}`.quiet().nothrow();

        // The working copy comes to rest on the foreman bookmark: an empty
        // commit whose parent carries it, the state jj reports as no changes.
        await jjHere("new", "foreman/ts-cccccc");

        expect(await isClean(parked)).toEqual(clean);

        const before = await bookmarkHere("develop");
        expect(await merge(parked, "foreman/ts-merge", undefined)).toEqual({
          _tag: "Merged",
          verified: false,
        });
        expect(await bookmarkHere("develop")).not.toBe(before);
        expect(await Bun.file(join(parked, "landed.txt")).text()).toBe("approved\n");

        // The landing moved the working copy off the parked bookmark; the
        // project is clean again, with the landed merge as its trunk.
        expect(await isClean(parked)).toEqual(clean);
      } finally {
        await rm(parked, { recursive: true, force: true });
        await rm(`${parked}.grounds`, { recursive: true, force: true });
      }
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
      // Not toEqual([]): earlier landings in this repo left their own proving
      // ground's merges behind, and those are litter the sweep is right to take.
      expect(await sweep(colocated)).not.toContain(inFlight);
      // The working copy is the one anonymous head a person may be standing on;
      // it is the next tick's landing, not litter, so the sweep leaves it.
      expect(await bookmark("@")).toBe(inFlight);

      // The retry lands: `jj new` moves the working copy off the old merge,
      // which now reads as exactly the litter the sweep exists for.
      await jj("new", "develop", "foreman/ts-sweep", "-m", "Merge branch 'foreman/ts-sweep'");
      expect(await sweep(colocated)).toContain(inFlight);
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

      const swept = await sweep(colocated);
      expect(swept).not.toContain(unrelated);
      expect(swept).not.toContain(manual);
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

  // The reported incident: a stray bookmark left on the trunk's own commit
  // puts two names behind the working copy. The project is held — correctly,
  // a landing must not guess which name to advance — and the hold says which,
  // so the operator sees the fix instead of a clean checkout that never
  // clears.
  test(
    "names the candidate bookmarks when more than one sits behind the working copy",
    async () => {
      const isolated = await mkdtemp(join(tmpdir(), "foreman-ambiguous-"));
      try {
        const here = (...args: Array<string>) =>
          Bun.$`git -C ${isolated} ${args}`.quiet().nothrow();
        const jjHere = (...args: Array<string>) =>
          Bun.$`jj ${args}`
            .cwd(isolated)
            .env({ ...process.env, JJ_USER: "foreman", JJ_EMAIL: "foreman@test" })
            .quiet();

        await here("init", "-q");
        await here("config", "user.email", "foreman@test");
        await here("config", "user.name", "foreman");
        await writeFile(join(isolated, "tracked.txt"), "committed\n");
        await here("add", "tracked.txt");
        await here("commit", "-qm", "initial");
        await here("branch", "-M", "develop");
        await jjHere("git", "init");

        // A branch holding work a landing could take, so the merge gate runs
        // rather than answering "already merged" first.
        const side = `${isolated}-side`;
        await here("branch", "foreman/ts-merge", "develop");
        await here("worktree", "add", "-q", side, "foreman/ts-merge");
        await writeFile(join(side, "work.txt"), "work\n");
        await Bun.$`git -C ${side} add work.txt`.quiet().nothrow();
        await Bun.$`git -C ${side} commit -qm work`.quiet().nothrow();
        await Bun.$`git -C ${isolated} worktree remove ${side}`.quiet().nothrow();

        await here("branch", "test-setup", "develop");
        expect(await isClean(isolated)).toEqual({
          _tag: "Held",
          reason: "noBranch",
          detail: "2 bookmark candidates behind the working copy: develop, test-setup",
        });

        // The same verdict the landing carries, from the same probe: neither
        // the gate nor a landing may guess which of two bookmarks to advance.
        expect(await merge(isolated, "foreman/ts-merge")).toMatchObject({
          _tag: "Held",
          detail: expect.stringContaining("bookmark candidates"),
        });

        await here("branch", "-D", "test-setup");
        expect(await isClean(isolated)).toEqual(clean);
      } finally {
        await rm(isolated, { recursive: true, force: true });
        await rm(`${isolated}.grounds`, { recursive: true, force: true });
      }
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
