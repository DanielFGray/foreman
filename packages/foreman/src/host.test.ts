import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema as S } from "effect";
import { Published } from "./published-schema.ts";

const scratch: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("foreman serve's host restart", () => {
  test("publishes setup failure, retries the loaded commit, and exits after setup passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "foreman-host-process-"));
    scratch.push(root);
    const sourcePackage = join(import.meta.dir, "..");
    const packageDirectory = join(root, "packages", "foreman");
    const configDirectory = join(root, "config");
    const stateDirectory = join(root, "state");
    const fakeBin = join(root, "bin");
    const configFile = join(configDirectory, "config.jsonc");
    const database = join(root, "tasks.db");
    const stateFile = join(stateDirectory, "serve.json");
    const setupAttempts = join(root, "setup-attempts.txt");
    const stdoutFile = join(root, "serve.stdout");
    const stderrFile = join(root, "serve.stderr");

    await mkdir(join(root, "packages"), { recursive: true });
    await cp(sourcePackage, packageDirectory, {
      recursive: true,
      filter: (source) => !source.split("/").includes("node_modules"),
    });
    await symlink(
      join(sourcePackage, "node_modules"),
      join(packageDirectory, "node_modules"),
      "dir",
    );
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    await mkdir(configDirectory, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(configFile, '{"pollSeconds":1,"otlpEndpoint":"http://127.0.0.1:9"}\n');

    // Both read methods decode their own field and ignore the other field.
    await writeFile(
      join(fakeBin, "hc"),
      `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"terminals":[],"value":null}}'
`,
      { mode: 0o755 },
    );

    const environment = {
      ...process.env,
      HOME: root,
      TASKS_DB: database,
      XDG_CONFIG_HOME: join(root, "config-home"),
      XDG_STATE_HOME: stateDirectory,
      XDG_DATA_HOME: join(root, "data"),
      FOREMAN_CONFIG: configFile,
      FOREMAN_STATE: stateFile,
      SETUP_ATTEMPTS: setupAttempts,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    };

    const initialize = Bun.spawn([process.execPath, "src/main.ts", "ladder", "list"], {
      cwd: packageDirectory,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [initializeCode, initializeOut, initializeErr] = await Promise.all([
      initialize.exited,
      new Response(initialize.stdout).text(),
      new Response(initialize.stderr).text(),
    ]);
    expect(initializeCode, `${initializeOut}\n${initializeErr}`).toBe(0);

    await Bun.$`sqlite3 ${database} < ${join(sourcePackage, "e2e", "registry.sql")}`.quiet();
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "worktree-setup"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await writeFile(join(root, "version.txt"), "loaded\n");

    const git = (...args: Array<string>) =>
      Bun.$`git -C ${root} -c user.email=foreman@test -c user.name=Foreman ${args}`
        .quiet()
        .nothrow();
    expect((await git("init", "-q", "-b", "trunk")).exitCode).toBe(0);
    expect((await git("add", "-A")).exitCode).toBe(0);
    expect((await git("commit", "-qm", "loaded code")).exitCode).toBe(0);
    const loadedCommit = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();

    const serve = Bun.spawn([process.execPath, "src/main.ts", "serve"], {
      cwd: packageDirectory,
      env: environment,
      stdout: Bun.file(stdoutFile),
      stderr: Bun.file(stderrFile),
    });

    const output = async () =>
      `${await readFile(stdoutFile, "utf8").catch(() => "")}\n${await readFile(stderrFile, "utf8").catch(() => "")}`;
    const published = async () => {
      if (!(await Bun.file(stateFile).exists())) return undefined;
      return S.decodeUnknownSync(S.fromJsonString(Published))(await readFile(stateFile, "utf8"));
    };
    const waitForPublished = async (
      predicate: (value: S.Schema.Type<typeof Published>) => boolean,
    ) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const value = await published();
        if (value !== undefined && predicate(value)) return value;
        if (serve.exitCode !== null) throw new Error(`serve exited early: ${await output()}`);
        await pause(50);
      }
      throw new Error(`serve did not publish the expected state: ${await output()}`);
    };

    try {
      const initial = await waitForPublished((value) => value.dispatcher?.state === "idle");
      expect(initial.dispatcher?.state).toBe("idle");
      expect(await Bun.file(setupAttempts).exists()).toBe(false);

      await writeFile(
        join(root, "scripts", "worktree-setup"),
        `#!/bin/sh
count=0
if [ -f "$SETUP_ATTEMPTS" ]; then count=$(cat "$SETUP_ATTEMPTS"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "$SETUP_ATTEMPTS"
if [ "$count" -eq 1 ]; then echo 'install broke' >&2; exit 1; fi
`,
        { mode: 0o755 },
      );
      await writeFile(join(root, "version.txt"), "landed\n");
      expect((await git("add", "scripts/worktree-setup", "version.txt")).exitCode).toBe(0);
      expect((await git("commit", "-qm", "landed code")).exitCode).toBe(0);

      const failed = await waitForPublished((value) => value.dispatcher?.state === "failed");
      expect(failed.dispatcher).toMatchObject({
        state: "failed",
        detail: expect.stringContaining("checkout setup failed"),
      });
      expect(serve.exitCode).toBeNull();
      expect(await readFile(setupAttempts, "utf8")).toBe("1\n");

      const exit = await Promise.race([
        serve.exited.then((exitCode) => ({ _tag: "Exited" as const, exitCode })),
        pause(15_000).then(() => ({ _tag: "TimedOut" as const })),
      ]);
      if (exit._tag === "TimedOut") {
        serve.kill();
        throw new Error(`serve did not restart after setup passed: ${await output()}`);
      }
      expect(exit.exitCode, await output()).toBe(0);
      expect(await readFile(setupAttempts, "utf8")).toBe("2\n");
      expect((await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim()).not.toBe(loadedCommit);
      expect((await published())?.dispatcher).toMatchObject({
        state: "failed",
        detail: expect.stringContaining("checkout setup failed"),
      });
    } finally {
      if (serve.exitCode === null) {
        serve.kill();
        await serve.exited;
      }
    }
  }, 30_000);
});
