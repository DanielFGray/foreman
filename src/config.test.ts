import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Settings, settings } from "./config.ts";

const repoRoot = join(import.meta.dir, "..");

const load = () =>
  Effect.gen(function* () {
    const config = yield* Settings;
    return config.projects;
  }).pipe(Effect.provide(settings({ slots: Option.none(), running: false })), Effect.runPromise);

/** The whole Settings, for the fields `projects` alone does not carry. */
const loadLadder = () =>
  Effect.gen(function* () {
    const config = yield* Settings;
    return config.ladder;
  }).pipe(Effect.provide(settings({ slots: Option.none(), running: false })), Effect.runPromise);

describe("settings", () => {
  const savedCwd = process.cwd();
  const saved = process.env["FOREMAN_CONFIG"];
  const savedRegistry = process.env["FOREMAN_REGISTRY"];

  /** A scratch registry built from the e2e rig's own SQL. */
  const scratchRegistry = () => {
    const path = join(mkdtempSync(join(tmpdir(), "foreman-registry-")), "registry.db");
    const db = new Database(path);
    db.exec(readFileSync(join(repoRoot, "e2e", "registry.sql"), "utf8"));
    db.close();
    process.env["FOREMAN_REGISTRY"] = path;
    return path;
  };

  afterEach(() => {
    if (savedRegistry === undefined) delete process.env["FOREMAN_REGISTRY"];
    else process.env["FOREMAN_REGISTRY"] = savedRegistry;
    process.chdir(savedCwd);
    if (saved === undefined) delete process.env["FOREMAN_CONFIG"];
    else process.env["FOREMAN_CONFIG"] = saved;
  });

  test("resolves a relative FOREMAN_CONFIG against the working directory", async () => {
    process.chdir(repoRoot);
    scratchRegistry();
    process.env["FOREMAN_CONFIG"] = join("e2e", "config.jsonc");
    const projects = await load();
    expect(projects.map((project) => project.name)).toContain("foreman-e2e-probe");
  });

  test("reads an absolute FOREMAN_CONFIG from any working directory", async () => {
    scratchRegistry();
    process.chdir("/tmp");
    process.env["FOREMAN_CONFIG"] = join(repoRoot, "e2e", "config.jsonc");
    const projects = await load();
    expect(projects.map((project) => project.name)).toContain("foreman-e2e-probe");
  });

  test("carries a rung's unmetered flag out of the config", async () => {
    // A field the schema does not name is dropped silently, so the operator's
    // statement that a promotional model is not metered would be discarded and
    // the rung walled on a percentage that does not describe it. Decode the
    // field the way the gate reads it, rather than trusting the file.
    process.env["FOREMAN_CONFIG"] = join(repoRoot, "e2e", "config.jsonc");
    scratchRegistry();
    const ladder = await loadLadder();
    expect(ladder.find((rung) => rung.name === "promo")?.unmetered).toBe(true);
    expect(ladder.find((rung) => rung.name === "cheap")?.unmetered).toBeUndefined();
  });

  test("refuses to start without a registry", async () => {
    process.env["FOREMAN_CONFIG"] = join(repoRoot, "e2e", "config.jsonc");
    process.env["FOREMAN_REGISTRY"] = join(tmpdir(), "foreman-no-such-registry.db");
    expect(loadLadder()).rejects.toThrow(/no model registry at/);
  });
});
