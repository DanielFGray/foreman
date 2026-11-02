import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STANDARD_PIPELINE } from "./pipeline.ts";
import { Dispatcher } from "./dispatcher.ts";
import { pipelineCommand as pipelineCommandWith } from "./pipeline-command.ts";
import { readPipelines, withWorkspace } from "./pipeline-file.ts";
import { scratchStore, seed } from "./scratch-store.ts";

const folder = mkdtempSync(join(tmpdir(), "foreman-pipeline-command-"));
const path = join(folder, "pipelines.json");
process.env["FOREMAN_PIPELINES"] = path;
const store = scratchStore();
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
  store.cleanup();
});
beforeEach(() => rmSync(path, { force: true }));

// `place` reads the dispatcher, and no test here runs it. The dispatcher's own
// tests cover `place`.
const pipelineCommand = pipelineCommandWith(
  Layer.effect(Dispatcher, Effect.die("these tests do not run pipeline place")),
);

await Effect.runPromise(
  seed(`
    INSERT INTO pools (pool, harness, provider_default) VALUES ('Pool', 'pi', 'prov');
    INSERT INTO models (model, provider, pool, harness, tier, limit_scope) VALUES ('m1', 'prov', 'Pool', 'pi', 'free', 'pool');
    INSERT INTO ladder (rank, rung, model) VALUES (1, 'cheap', 'm1');
  `).pipe(Effect.provide(store.layer)),
);

const run = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(pipelineCommand, { version: "test" })(args).pipe(
      Effect.provide(Layer.merge(BunServices.layer, store.layer)),
    ),
  );

/** The detail of the error a refused command fails with. */
const refusal = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(pipelineCommand, { version: "test" })(args).pipe(
      Effect.flip,
      Effect.map((error) => ("detail" in error ? String(error.detail) : String(error))),
      Effect.provide(Layer.merge(BunServices.layer, store.layer)),
    ),
  );

const fileWith = (pipeline: unknown) => {
  const file = join(folder, `drawn-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(pipeline));
  return file;
};

const pinned = {
  nodes: STANDARD_PIPELINE.nodes.map((node) =>
    node.id === "author" ? { ...node, model: "cheap" } : node,
  ),
};

describe("foreman pipeline", () => {
  test("set writes a pipeline that can run, and clear drops it", async () => {
    await run("set", "amux", fileWith(pinned));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 2,
      pipelines: { amux: pinned },
    });

    await run("clear", "amux");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2, pipelines: {} });
  });

  test("set refuses a pipeline the ladder cannot run, and writes nothing", async () => {
    const gone = {
      nodes: STANDARD_PIPELINE.nodes.map((node) =>
        node.id === "author" ? { ...node, model: "strong" } : node,
      ),
    };
    expect(await refusal("set", "amux", fileWith(gone))).toMatch(/strong is no rung/);
    expect(existsSync(path)).toBe(false);
  });

  test("set refuses a file that is no pipeline", async () => {
    expect(await refusal("set", "amux", fileWith({ nodes: [{ kind: "teleport" }] }))).toMatch(
      /is no pipeline/,
    );
    expect(existsSync(path)).toBe(false);
  });

  test("check writes nothing", async () => {
    await run("check", fileWith(pinned));
    expect(existsSync(path)).toBe(false);
  });
});

describe("a pipelines file from before the workspace blocks", () => {
  const old = {
    nodes: [
      { kind: "source", id: "queue", filter: "", next: "author" },
      { kind: "agent", id: "author", role: "author", model: "ladder", next: "review" },
      { kind: "agent", id: "review", role: "review", model: "above", next: "land" },
      { kind: "land", id: "land" },
    ],
  };
  const read = () => JSON.parse(readFileSync(path, "utf8"));

  test("reads with a branch and a worktree after each source, and is stored that way once written", async () => {
    writeFileSync(path, JSON.stringify({ amux: old }));
    await run("set", "other", fileWith(pinned));

    expect(read().version).toBe(2);
    expect(read().pipelines.amux.nodes.slice(0, 3)).toEqual([
      { kind: "source", id: "queue", filter: "", next: "branch" },
      { kind: "branch", id: "branch", next: "worktree" },
      { kind: "worktree", id: "worktree", next: "author" },
    ]);
  });

  test("a pipeline later drawn direct stays direct", async () => {
    writeFileSync(path, JSON.stringify({ amux: old }));
    const direct = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "start" },
        { kind: "gate", id: "start", step: "author", next: "author" },
        { kind: "agent", id: "author", role: "author", model: "ladder", next: "review-gate" },
        { kind: "gate", id: "review-gate", step: "review", next: "review" },
        { kind: "agent", id: "review", role: "review", model: "above", next: "land-gate" },
        { kind: "gate", id: "land-gate", step: "land", next: "done" },
        { kind: "done", id: "done" },
      ],
    };
    await run("set", "amux", fileWith(direct));
    await run("set", "other", fileWith(pinned));

    expect(read().pipelines.amux).toEqual(direct);
  });
});

describe("migrating and reading the pipelines file", () => {
  test("two sources each get a branch and a worktree with ids of their own", () => {
    const migrated = withWorkspace({
      nodes: [
        { kind: "source", id: "bugs", filter: "label:bug", next: "author" },
        { kind: "source", id: "rest", filter: "", next: "author" },
        { kind: "agent", id: "author", role: "author", model: "ladder", next: "land" },
        { kind: "land", id: "land" },
      ],
    });
    expect(migrated.nodes.map((node) => node.id)).toEqual([
      "bugs",
      "branch",
      "worktree",
      "rest",
      "branch-2",
      "worktree-2",
      "author",
      "land",
    ]);
  });

  test("a file that does not decode reports its path and why", async () => {
    writeFileSync(path, "{ not json");
    const read = await Effect.runPromise(
      readPipelines(path).pipe(Effect.provide(BunServices.layer)),
    );
    expect(read.error).toStartWith(`${path} does not decode: `);
    expect(read.error?.length).toBeGreaterThan(`${path} does not decode: `.length);
  });
});
