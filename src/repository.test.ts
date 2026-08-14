import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const branches = (directory: string) =>
  Effect.runPromise(Repository.branches(directory).pipe(Effect.provide(Repository.Default)));

const remove = (directory: string, branch: string) =>
  Effect.runPromise(Repository.remove(directory, branch).pipe(Effect.provide(Repository.Default)));

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

  test("merges only into a clean checkout", async () => {
    const base = (await git("branch", "--show-current")).stdout.toString().trim();
    await git("checkout", "-qb", "reviewed");
    await writeFile(join(directory, "reviewed.txt"), "approved\n");
    await git("add", "reviewed.txt");
    await git("commit", "-qm", "reviewed work");
    await git("checkout", "-q", base);

    await writeFile(join(directory, "tracked.txt"), "operator edit\n");
    expect(await merge(directory, "reviewed")).toEqual({ _tag: "Held" });
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
});
