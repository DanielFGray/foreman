import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { codeMovedFrom } from "./host.ts";
import { Repository, RepositoryError } from "./repository.ts";

const scratch: Array<string> = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A checkout whose first commit is what the process loaded, and whose second
 * commit is what a landing moved HEAD to. `setupScript` is the setup script
 * that second commit carries.
 */
const checkoutAfterLanding = async (setupScript: string) => {
  const here = await mkdtemp(join(tmpdir(), "foreman-code-moved-"));
  scratch.push(here);
  const git = (...args: Array<string>) =>
    Bun.$`git -C ${here} -c user.email=f@t -c user.name=f ${args}`.quiet().nothrow();
  await git("init", "-q", "-b", "trunk");
  await mkdir(join(here, "scripts"), { recursive: true });
  await writeFile(join(here, "scripts", "worktree-setup.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await git("add", "scripts");
  await git("commit", "-qm", "loaded");
  const loaded = (await Bun.$`git -C ${here} rev-parse HEAD`.text()).trim();
  // The landing always adds a file, so its commit exists even when the setup
  // script it carries is the same as the loaded one.
  await writeFile(join(here, "landed.txt"), "landed\n");
  await writeFile(join(here, "scripts", "worktree-setup.sh"), setupScript, { mode: 0o755 });
  await git("add", "scripts", "landed.txt");
  await git("commit", "-qm", "landed");
  return { here, loaded };
};

/** The answer `codeMovedFrom` gives, or the error it fails with. */
const answer = (directory: string, loaded: string | undefined) =>
  Effect.runPromise(
    Repository.use((repository) => codeMovedFrom(repository, loaded, directory)).pipe(
      Effect.map((moved): { moved: boolean } | { error: unknown } => ({ moved })),
      Effect.catch((error) => Effect.succeed({ error })),
      Effect.provide(Repository.Default),
    ),
  );

describe("codeMovedFrom", () => {
  test("is false while the checkout is still at the commit the process loaded", async () => {
    const { here, loaded } = await checkoutAfterLanding("#!/bin/sh\n");
    await Bun.$`git -C ${here} reset -q --hard ${loaded}`.quiet();

    expect(await answer(here, loaded)).toEqual({ moved: false });
  });

  test("is true once the checkout moved and its setup passes on the new commit", async () => {
    const { here, loaded } = await checkoutAfterLanding("#!/bin/sh\n");

    expect(await answer(here, loaded)).toEqual({ moved: true });
  });

  test("fails with the setup output when the checkout moved and its setup fails, so serve keeps the loaded code", async () => {
    const { here, loaded } = await checkoutAfterLanding(
      "#!/bin/sh\necho 'install broke' >&2\nexit 1\n",
    );

    const result = await answer(here, loaded);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBeInstanceOf(RepositoryError);
    const detail = (result.error as RepositoryError).detail;
    expect(detail).toContain("checkout setup failed");
    expect(detail).toContain("install broke");
  });
});
