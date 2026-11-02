import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { Repository } from "./repository.ts";

const run = <A, E>(f: (repository: Repository["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Repository.use(f).pipe(Effect.provide(Repository.Default)));

const isFree = (directory: string) => run((repository) => repository.isFree(directory));
/** The clean answer every assertion below that is not a hold expects. */
const clean = { _tag: "Clean" } as const;

const detached = {
  _tag: "Held",
  reason: "noBranch",
  detail: "no checked-out branch (detached HEAD)",
} as const;

const holdsWork = (directory: string) => run((repository) => repository.holdsWork(directory));

// Nested under a directory that does not exist, because the real ground lives
// at $XDG_STATE_HOME/foreman/verify/<project> and nothing makes that first.
const groundFor = (directory: string) => `${directory}.grounds/verify`;

const merge = (directory: string, branch: string, verify?: string, message = `Merge ${branch}`) =>
  run((repository) => repository.merge(directory, branch, verify, groundFor(directory), message));

const setup = (directory: string) => run((repository) => repository.setup(directory));

const branches = (directory: string) => run((repository) => repository.branches(directory));

const remove = (directory: string, branch: string) =>
  run((repository) => repository.remove(directory, branch));

const directory = await mkdtemp(join(tmpdir(), "foreman-repository-"));
afterAll(() =>
  Promise.all(
    [directory, `${directory}.grounds`].map((path) => rm(path, { recursive: true, force: true })),
  ),
);

const git = (...args: Array<string>) => Bun.$`git -C ${directory} ${args}`.quiet().nothrow();

describe("Repository", () => {
  test("leaves a git checkout free while the operator edits in it", async () => {
    await git("init", "-q");
    await git("config", "user.email", "foreman@test");
    await git("config", "user.name", "foreman");
    await writeFile(join(directory, "tracked.txt"), "committed\n");
    await git("add", "tracked.txt");
    await git("commit", "-qm", "initial");

    // Tasks branch from the committed tip, so an edit in progress holds only
    // the landings that would write the same file.
    await writeFile(join(directory, "scratch.md"), "notes\n");
    await writeFile(join(directory, "tracked.txt"), "being edited\n");
    expect(await isFree(directory)).toEqual(clean);

    await git("checkout", "--", "tracked.txt");
  });

  test("does not refresh the index while checking cleanliness", async () => {
    const tracked = join(directory, "tracked.txt");
    const index = join(directory, ".git", "index");

    // A newer worktree timestamp makes plain `git status` refresh the index.
    await utimes(tracked, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
    const before = (await stat(index)).ino;

    expect(await isFree(directory)).toEqual(clean);
    expect((await stat(index)).ino).toBe(before);
  });

  test("holds a landing only on the paths the operator is editing", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    const before = (await git("rev-parse", "HEAD")).stdout.toString().trim();
    await git("checkout", "-qb", "reviewed");
    await writeFile(join(directory, "reviewed.txt"), "approved\n");
    await writeFile(join(directory, "tracked.txt"), "branch edit\n");
    await git("add", "reviewed.txt", "tracked.txt");
    await git("commit", "-qm", "reviewed work");
    await git("checkout", "-q", base);

    // A leading space in porcelain output (" M") is part of the entry, so a
    // trimmed read would misname the path and miss the collision.
    await writeFile(join(directory, "tracked.txt"), "operator edit\n");
    expect(await merge(directory, "reviewed")).toEqual({
      _tag: "Held",
      reason: "dirty",
      detail: "uncommitted changes to tracked.txt, which reviewed also changes",
    });
    expect((await git("rev-parse", "HEAD")).stdout.toString().trim()).toBe(before);

    // An untracked file in the branch's way collides the same way.
    await git("checkout", "--", "tracked.txt");
    await writeFile(join(directory, "reviewed.txt"), "operator's own\n");
    expect(await merge(directory, "reviewed")).toMatchObject({ _tag: "Held", reason: "dirty" });
    await rm(join(directory, "reviewed.txt"));

    // An edit elsewhere is the operator's business, and it survives the landing.
    await writeFile(join(directory, "scratch.md"), "still editing\n");
    expect(await merge(directory, "reviewed")).toEqual({ _tag: "Merged", verified: false });
    expect(await Bun.file(join(directory, "reviewed.txt")).text()).toBe("approved\n");
    expect(await Bun.file(join(directory, "scratch.md")).text()).toBe("still editing\n");
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
    expect(await isFree(directory)).toEqual(clean);
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

  // The host process can restart at any point of a landing. The proof runs in
  // foreman's own ground, so a landing cut off there has touched nothing of the
  // operator's, and the next landing must start the proof over.
  test("lands on the next try after a landing is cut off during verify", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "cut-off");
    await writeFile(join(directory, "cut-off.txt"), "fine\n");
    await git("add", "cut-off.txt");
    await git("commit", "-qm", "cut-off work");
    await git("checkout", "-q", base);
    const before = (await git("rev-parse", "HEAD")).stdout.toString().trim();

    const cut = await Effect.runPromise(
      Repository.use((repository) =>
        repository.merge(directory, "cut-off", "sleep 30", groundFor(directory), "Merge cut-off"),
      ).pipe(Effect.timeoutOption("500 millis"), Effect.provide(Repository.Default)),
    );
    expect(cut).toEqual(Option.none());
    expect((await git("rev-parse", "HEAD")).stdout.toString().trim()).toBe(before);

    expect(await merge(directory, "cut-off", "true")).toEqual({ _tag: "Merged", verified: true });
    expect(await Bun.file(join(directory, "cut-off.txt")).text()).toBe("fine\n");
  });

  // A git killed mid-command leaves its index.lock, and every later git in that
  // worktree refuses to start. The ground is foreman's own, so foreman makes
  // it again rather than holding every landing until someone looks.
  test("makes the ground again when a killed git left its lock there", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "locked-ground");
    await writeFile(join(directory, "locked-ground.txt"), "fine\n");
    await git("add", "locked-ground.txt");
    await git("commit", "-qm", "locked-ground work");
    await git("checkout", "-q", base);

    // The landings above made the ground. Its .git file names the folder
    // where git keeps that worktree's index, and so its lock.
    const pointer = await Bun.file(join(groundFor(directory), ".git")).text();
    const admin = pointer.replace(/^gitdir: /, "").trim();
    await writeFile(join(admin, "index.lock"), "");

    expect(await merge(directory, "locked-ground", "true")).toEqual({
      _tag: "Merged",
      verified: true,
    });
  });

  // The fast-forward is the one write to the operator's checkout. A lock there
  // may be the operator's own git at work, so foreman never removes it: the
  // landing holds, says why, and lands once the lock is gone.
  test("holds a landing on a lock in the checkout, and lands once it is gone", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "locked-checkout");
    await writeFile(join(directory, "locked-checkout.txt"), "fine\n");
    await git("add", "locked-checkout.txt");
    await git("commit", "-qm", "locked-checkout work");
    await git("checkout", "-q", base);

    const lock = join(directory, ".git", "index.lock");
    await writeFile(lock, "");
    expect(await merge(directory, "locked-checkout", "true")).toMatchObject({
      _tag: "Held",
      detail: expect.stringContaining("index.lock"),
    });

    await rm(lock);
    expect(await merge(directory, "locked-checkout", "true")).toEqual({
      _tag: "Merged",
      verified: true,
    });
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

    // The merge commit is what `git log` shows an operator, so it must name
    // the task rather than the detached HEAD the proof was made on.
    await git("branch", "foreman/ts-subject", base);
    await git("checkout", "-q", "foreman/ts-subject");
    await writeFile(join(directory, "subject.txt"), "work\n");
    await git("add", "subject.txt");
    await git("commit", "-qm", "work for the subject");
    await git("checkout", "-q", base);
    const message = "Merge foreman/ts-subject: name the landing merge commit";
    expect(await merge(directory, "foreman/ts-subject", undefined, message)).toEqual({
      _tag: "Merged",
      verified: false,
    });
    expect((await git("log", "-1", "--format=%s").text()).trim()).toBe(message);
    // Left behind, the branch would join the listing the next assertions make.
    await git("branch", "-D", "foreman/ts-subject");

    // The merged branch is the one that used to read as an author who wrote
    // nothing: its commits are in the checkout, so it is not unmerged — and
    // reading that as an empty branch sent finished work back to the queue.
    expect(await branches(directory)).toEqual([
      {
        branch: "foreman/ts-aaaaaa",
        merged: false,
        empty: false,
        stale: undefined,
        tip: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
      {
        branch: "foreman/ts-bbbbbb",
        merged: true,
        empty: true,
        stale: undefined,
        tip: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
      {
        branch: "foreman/ts-cccccc",
        merged: true,
        empty: false,
        stale: undefined,
        tip: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
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
      tip: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(byName("foreman/ts-stale-con")).toEqual({
      branch: "foreman/ts-stale-con",
      merged: false,
      empty: false,
      stale: { paths: ["shared.txt"], modifyDelete: false },
      tip: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    // A branch the trunk has not moved past still merges, and so reads as
    // not stale rather than as anything worse.
    expect(byName("foreman/ts-aaaaaa")?.stale).toBeUndefined();
  });

  test("reads a branch's tip as the commit id git names", async () => {
    const expected = (await git("rev-parse", "foreman/ts-aaaaaa")).stdout.toString().trim();

    expect(await run((repository) => repository.tip(directory, "foreman/ts-aaaaaa"))).toBe(
      expected,
    );
    expect(
      await run((repository) => repository.tip(directory, "foreman/ts-nowhere")),
    ).toBeUndefined();
  });

  // A check judges one commit of a branch that has not landed, so it must see
  // that commit's tree and leave the operator's checkout as it was.
  test("checks a branch's commit in the proving ground, against where it was cut", async () => {
    const check = (commit: string, command: string) =>
      run((repository) => repository.check(directory, commit, command, groundFor(directory)));
    const head = (await git("rev-parse", "HEAD")).stdout.toString().trim();
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "checked");
    await writeFile(join(directory, "checked.txt"), "work\n");
    await git("add", "checked.txt");
    await git("commit", "-qm", "checked work");
    const tip = (await git("rev-parse", "HEAD")).stdout.toString().trim();
    await git("checkout", "-q", base);
    const seen = join(tmpdir(), `foreman-check-${process.pid}.txt`);

    expect(await check(tip, `pwd > ${seen}; test -f checked.txt`)).toEqual({
      _tag: "Passed",
      verified: true,
    });
    expect((await Bun.file(seen).text()).trim()).not.toBe(directory);
    expect(await check(tip, "test ! -f checked.txt")).toMatchObject({ _tag: "Failed" });
    // Red where the branch was cut as well: the branch is not the cause.
    expect(await check(tip, "false")).toEqual({ _tag: "Passed", verified: false });

    expect((await git("rev-parse", "HEAD")).stdout.toString().trim()).toBe(head);
    expect(await Bun.file(join(directory, "checked.txt")).exists()).toBe(false);
    await rm(seen, { force: true });
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
    expect(await isFree(directory)).toEqual(clean);
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
    // least about. isFree deliberately ignores it; here it is the whole point.
    await writeFile(join(worktree, "new-test.ts"), "expect(1).toBe(1)\n");
    expect(await holdsWork(worktree)).toBe(true);
    expect(await isFree(worktree)).toEqual(clean);

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
    expect(await isFree(directory)).toEqual(clean);

    await git("checkout", "-q", "--detach", "HEAD");
    expect(await isFree(directory)).toEqual(detached);

    await git("checkout", "-q", base);
    expect(await isFree(directory)).toEqual(clean);
  });
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

// A task's worktree is the durable record of its work once nothing runs in it,
// so making, finding and removing one is asked of git itself.
const project = await mkdtemp(join(tmpdir(), "foreman-worktrees-"));
afterAll(() =>
  Promise.all(
    [project, `${project}.tasks`].map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("Repository worktrees", () => {
  const branch = "foreman/ts-1";
  // Nested under a directory that does not exist, like the real
  // $XDG_STATE_HOME/foreman/worktrees/<project>/<task>.
  const path = `${project}.tasks/proj/ts-1`;
  const worktrees = () => run((repository) => repository.worktrees(project));

  test("cuts a new branch from HEAD into a worktree, and finds it again", async () => {
    await Bun.$`git -C ${project} init -q && git -C ${project} -c user.email=f@t -c user.name=f commit -q --allow-empty -m initial`.quiet();
    await run((repository) => repository.addWorktree(project, branch, path));

    expect(await worktrees()).toContainEqual({ path, branch, prunable: false });
  });

  test("checks out a branch that already exists, keeping its commits", async () => {
    await Bun.$`git -C ${path} -c user.email=f@t -c user.name=f commit -q --allow-empty -m work`.quiet();
    await run((repository) => repository.removeWorktree(project, path));
    expect((await worktrees()).map((worktree) => worktree.path)).not.toContain(path);

    await run((repository) => repository.addWorktree(project, branch, path));
    const log = await Bun.$`git -C ${path} log -1 --format=%s`.text();
    expect(log.trim()).toBe("work");
  });

  test("makes a worktree again where its directory was deleted by hand", async () => {
    await rm(path, { recursive: true, force: true });
    expect(await worktrees()).toContainEqual({ path, branch, prunable: true });

    await run((repository) => repository.addWorktree(project, branch, path));
    expect(await worktrees()).toContainEqual({ path, branch, prunable: false });
  });

  test("puts a worktree left detached back on its branch", async () => {
    await Bun.$`git -C ${path} switch -q --detach`.quiet();
    expect(await worktrees()).toContainEqual({ path, branch: undefined, prunable: false });

    await run((repository) => repository.restoreBranch(path, branch));
    expect(await worktrees()).toContainEqual({ path, branch, prunable: false });
  });

  test("refuses to switch away from commits the branch does not have", async () => {
    await Bun.$`git -C ${path} switch -q --detach && git -C ${path} -c user.email=f@t -c user.name=f commit -q --allow-empty -m stray`.quiet();

    const refused = await Effect.runPromise(
      Repository.use((repository) => repository.restoreBranch(path, branch)).pipe(
        Effect.flip,
        Effect.provide(Repository.Default),
      ),
    );
    expect(refused.detail).toContain("holds commits");
    // Still detached on the stray commit, so nothing was lost.
    expect((await Bun.$`git -C ${path} log -1 --format=%s`.text()).trim()).toBe("stray");
  });
});

describe("Repository's git", () => {
  // A host process gives git no identity of its own: the operator's comes from
  // the environment foreman runs in, ~/.gitconfig or GIT_* variables.
  test("commits a landing as the identity foreman's own environment names", async () => {
    const here = await mkdtemp(join(tmpdir(), "foreman-identity-"));
    const at = (...args: Array<string>) => Bun.$`git -C ${here} ${args}`.quiet().nothrow();
    const identity = {
      GIT_AUTHOR_NAME: "operator",
      GIT_AUTHOR_EMAIL: "operator@test",
      GIT_COMMITTER_NAME: "operator",
      GIT_COMMITTER_EMAIL: "operator@test",
    };
    const saved = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
    Object.assign(process.env, identity);
    try {
      await at("init", "-q", "-b", "main");
      await writeFile(join(here, "a.txt"), "a\n");
      await at("add", "a.txt");
      await at("commit", "-qm", "initial");
      await at("checkout", "-qb", "work");
      await writeFile(join(here, "b.txt"), "b\n");
      await at("add", "b.txt");
      await at("commit", "-qm", "work");
      await at("checkout", "-q", "main");

      expect(await merge(here, "work")).toEqual({ _tag: "Merged", verified: false });
      expect((await at("log", "-1", "--format=%ce")).stdout.toString().trim()).toBe(
        "operator@test",
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(here, { recursive: true, force: true });
      await rm(`${here}.grounds`, { recursive: true, force: true });
    }
  });
});

describe("Repository.remove on a branch with a worktree", () => {
  let root = "";
  let checkout = "";
  let worktree = "";
  const branch = "foreman/ts-1";
  const sh = (cwd: string, script: string) => Bun.$`sh -c ${script}`.cwd(cwd).quiet().nothrow();
  const branchExists = async () =>
    (
      await Bun.$`git -C ${checkout} rev-parse --verify --quiet refs/heads/${branch}`
        .quiet()
        .nothrow()
    ).exitCode === 0;
  const worktreeExists = async () =>
    (await run((repository) => repository.worktrees(checkout))).some(
      (entry) => entry.path === worktree,
    );
  const remove = () => run((repository) => repository.remove(checkout, branch));

  // A branch merged into the checkout whose worktree is still registered, with
  // a gitignored directory in it the way a bun install leaves one.
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "foreman-remove-"));
    checkout = join(root, "checkout");
    worktree = join(root, "tasks", "ts-1");
    await mkdir(checkout, { recursive: true });
    await sh(
      checkout,
      "git init -q && printf 'node_modules/\\n' > .gitignore && printf 'tracked\\n' > tracked.txt && " +
        "git add . && git -c user.email=f@t -c user.name=f commit -q -m base",
    );
    await run((repository) => repository.addWorktree(checkout, branch, worktree));
    await sh(
      worktree,
      "printf 'work\\n' > work.txt && git add work.txt && " +
        "git -c user.email=f@t -c user.name=f commit -q -m work && " +
        "mkdir -p node_modules/pkg && printf 'x\\n' > node_modules/pkg/index.js",
    );
    await sh(checkout, `git -c user.email=f@t -c user.name=f merge -q --no-ff ${branch} -m merge`);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  test("takes a clean merged worktree down with its branch", async () => {
    expect(await remove()).toBe(true);
    expect(await worktreeExists()).toBe(false);
    expect(await branchExists()).toBe(false);
  });

  test("keeps a merged worktree holding an uncommitted edit", async () => {
    await sh(worktree, "printf 'edit\\n' >> tracked.txt");

    expect(await remove()).toBe(false);
    expect(await worktreeExists()).toBe(true);
    expect(await branchExists()).toBe(true);
  });

  test("keeps a merged worktree holding an untracked file", async () => {
    await sh(worktree, "printf 'new\\n' > untracked.txt");

    expect(await remove()).toBe(false);
    expect(await worktreeExists()).toBe(true);
    expect(await branchExists()).toBe(true);
  });
});
