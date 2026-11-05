import { afterEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { connectionAt, store } from "tasks";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Settings, settingsLayer } from "./config.ts";
import { Paths } from "./paths.ts";
import { seed } from "./scratch-store.ts";

const repoRoot = join(import.meta.dir, "..");

const loadLadder = (db = process.env["TASKS_DB"]) =>
  Effect.gen(function* () {
    const config = yield* Settings;
    return config.ladder;
  }).pipe(
    Effect.provide(
      Layer.fresh(settingsLayer).pipe(
        Layer.provide(Layer.fresh(Paths.layer)),
        Layer.provide(db === undefined ? Layer.fresh(store) : connectionAt(db)),
        Layer.provide(BunServices.layer),
      ),
    ),
    Effect.runPromise,
  );

describe("settings", () => {
  const savedCwd = process.cwd();
  const saved = process.env["FOREMAN_CONFIG"];
  const savedStore = process.env["TASKS_DB"];

  /** A scratch store: the migration makes the schema, the e2e rig's own SQL seeds the ladder. */
  const scratchRegistry = async () => {
    const path = join(mkdtempSync(join(tmpdir(), "foreman-registry-")), "store.db");
    await seed(readFileSync(join(repoRoot, "e2e", "registry.sql"), "utf8")).pipe(
      Effect.provide(connectionAt(path)),
      Effect.runPromise,
    );
    process.env["TASKS_DB"] = path;
    return path;
  };

  afterEach(() => {
    if (savedStore === undefined) delete process.env["TASKS_DB"];
    else process.env["TASKS_DB"] = savedStore;
    process.chdir(savedCwd);
    if (saved === undefined) delete process.env["FOREMAN_CONFIG"];
    else process.env["FOREMAN_CONFIG"] = saved;
  });

  test("resolves a relative FOREMAN_CONFIG against the working directory", async () => {
    process.chdir(repoRoot);
    await scratchRegistry();
    process.env["FOREMAN_CONFIG"] = join("e2e", "config.jsonc");
    const ladder = await loadLadder();
    expect(ladder.map((rung) => rung.name)).toContain("cheap");
  });

  test("reads an absolute FOREMAN_CONFIG from any working directory", async () => {
    await scratchRegistry();
    process.chdir("/tmp");
    process.env["FOREMAN_CONFIG"] = join(repoRoot, "e2e", "config.jsonc");
    const ladder = await loadLadder();
    expect(ladder.map((rung) => rung.name)).toContain("cheap");
  });

  test("carries a rung's unmetered flag out of the config", async () => {
    // A field the schema does not name is dropped silently, so the operator's
    // statement that a promotional model is not metered would be discarded and
    // the rung walled on a percentage that does not describe it. Decode the
    // field the way the gate reads it, rather than trusting the file.
    process.env["FOREMAN_CONFIG"] = join(repoRoot, "e2e", "config.jsonc");
    await scratchRegistry();
    const ladder = await loadLadder();
    expect(ladder.find((rung) => rung.name === "promo")?.unmetered).toBe(true);
    expect(ladder.find((rung) => rung.name === "cheap")?.unmetered).toBe(false);
  });

  test("refuses to start without a registry", async () => {
    // A store that has never held a ladder is created and migrated empty on open.
    process.env["FOREMAN_CONFIG"] = join(repoRoot, "e2e", "config.jsonc");
    const empty = join(mkdtempSync(join(tmpdir(), "foreman-registry-")), "empty.db");
    process.env["TASKS_DB"] = empty;
    await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(empty))));
    await expect(loadLadder(empty)).rejects.toThrow(/the ladder table has no rungs/);
  });
});
