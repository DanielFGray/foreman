import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { Settings, settingsLayer } from "./config.ts";
import { Paths } from "./paths.ts";

const repoRoot = join(import.meta.dir, "..");

const loadPollInterval = () =>
  Effect.gen(function* () {
    const config = yield* Settings;
    return config.pollInterval;
  }).pipe(
    Effect.provide(Layer.fresh(settingsLayer).pipe(Layer.provide(Layer.fresh(Paths.layer)))),
    Effect.runPromise,
  );

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
    expect(await loadPollInterval()).toBe(5);
  });

  test("reads an absolute FOREMAN_CONFIG from any working directory", async () => {
    process.chdir("/tmp");
    process.env["FOREMAN_CONFIG"] = join(repoRoot, "e2e", "config.jsonc");
    expect(await loadPollInterval()).toBe(5);
  });
});
