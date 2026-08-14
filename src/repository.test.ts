import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Repository } from "./repository.ts";

const isClean = (directory: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* Repository;
      return yield* repository.isClean(directory);
    }).pipe(Effect.provide(Repository.Default)),
  );

const directory = await mkdtemp(join(tmpdir(), "foreman-repository-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

const git = (...args: Array<string>) =>
  Bun.$`git -C ${directory} ${args}`.quiet().nothrow();

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
});
