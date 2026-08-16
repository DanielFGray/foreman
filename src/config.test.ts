import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { join } from "node:path";
import { Settings, settings } from "./config.ts";

const repoRoot = join(import.meta.dir, "..");

const load = () =>
  Effect.gen(function* () {
    const config = yield* Settings;
    return config.projects;
  }).pipe(Effect.provide(settings({ slots: Option.none(), running: false })), Effect.runPromise);

describe("settings", () => {
  const savedCwd = process.cwd();
  const saved = process.env["FOREMAN_CONFIG"];

  afterEach(() => {
    process.chdir(savedCwd);
    if (saved === undefined) delete process.env["FOREMAN_CONFIG"];
    else process.env["FOREMAN_CONFIG"] = saved;
  });

  test("resolves a relative FOREMAN_CONFIG against the working directory", async () => {
    process.chdir(repoRoot);
    process.env["FOREMAN_CONFIG"] = join("e2e", "config.jsonc");
    const projects = await load();
    expect(projects.map((project) => project.name)).toContain("foreman-e2e-probe");
  });

  test("reads an absolute FOREMAN_CONFIG from any working directory", async () => {
    process.chdir("/tmp");
    process.env["FOREMAN_CONFIG"] = join(repoRoot, "e2e", "config.jsonc");
    const projects = await load();
    expect(projects.map((project) => project.name)).toContain("foreman-e2e-probe");
  });
});
