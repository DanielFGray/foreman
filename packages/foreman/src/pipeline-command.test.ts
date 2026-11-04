import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STANDARD_PIPELINES, standardExits, WORKSPACE_CHOICES } from "./pipeline.ts";
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
const drafts = join(folder, "pipelines.draft.json");
beforeEach(() => {
  rmSync(path, { force: true });
  rmSync(drafts, { force: true });
});

// `place` reads the dispatcher, and no test here runs it. The dispatcher's own
// tests cover `place`.
const pipelineCommand = pipelineCommandWith(
  Layer.effect(Dispatcher, Effect.die("these tests do not run pipeline place")),
);

await Effect.runPromise(
  seed(`
    INSERT INTO pools (pool, harness, provider_default) VALUES ('Pool', 'pi', 'prov');
    INSERT INTO models (model, provider, pool, harness, limit_scope) VALUES ('m1', 'prov', 'Pool', 'pi', 'pool');
    INSERT INTO ladder (rank, level, rung, model) VALUES (1, 1, 'cheap', 'm1');
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
  nodes: STANDARD_PIPELINES.worktree.nodes.map((node) =>
    node.id === "author" ? { ...node, model: "cheap" } : node,
  ),
};

describe("foreman pipeline", () => {
  test("set writes a pipeline that can run, and clear drops it", async () => {
    await run("set", "amux", fileWith(pinned));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 4,
      pipelines: { amux: pinned },
    });

    await run("clear", "amux");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 4, pipelines: {} });
  });

  test("set refuses a pipeline the ladder cannot run, and writes nothing", async () => {
    const gone = {
      nodes: STANDARD_PIPELINES.worktree.nodes.map((node) =>
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

describe("foreman pipeline use", () => {
  test("draws each standard choice, which reads back from the file as drawn", async () => {
    for (const choice of WORKSPACE_CHOICES) {
      await run("use", choice, "--project", "amux");
      const read = await Effect.runPromise(
        readPipelines(path).pipe(Effect.provide(BunServices.layer)),
      );
      expect(read.error).toBeUndefined();
      expect(read.value["amux"]).toEqual(STANDARD_PIPELINES[choice]);
    }
  });

  test("refuses over a drawing that is no standard choice, and leaves it as it is", async () => {
    await run("set", "amux", fileWith(pinned));
    expect(await refusal("use", "worktree", "--project", "amux")).toMatch(
      /amux runs its own drawn pipeline/,
    );
    expect(JSON.parse(readFileSync(path, "utf8")).pipelines.amux).toEqual(pinned);
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

    expect(read().version).toBe(4);
    expect(read().pipelines.amux.nodes.slice(0, 3)).toEqual([
      { kind: "source", id: "queue", filter: "", next: "branch" },
      { kind: "branch", id: "branch", next: "worktree" },
      { kind: "worktree", id: "worktree", next: "author" },
    ]);
    expect(read().pipelines.amux.nodes.slice(3)).toEqual([
      {
        kind: "agent",
        id: "author",
        role: "author",
        model: "ladder",
        exits: standardExits({ kind: "agent", role: "author" }, "review"),
      },
      {
        kind: "agent",
        id: "review",
        role: "review",
        model: "reviewers",
        exits: standardExits({ kind: "agent", role: "review" }, "land"),
      },
      { kind: "land", id: "land" },
    ]);
  });

  test("a pipeline later drawn direct stays direct", async () => {
    writeFileSync(path, JSON.stringify({ amux: old }));
    const direct = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "start" },
        { kind: "gate", id: "start", step: "author", next: "author" },
        {
          kind: "agent",
          id: "author",
          role: "author",
          model: "ladder",
          exits: [
            { name: "done", to: "review-gate" },
            { name: "already-done", to: "review-gate" },
          ],
        },
        { kind: "gate", id: "review-gate", step: "review", next: "review" },
        {
          kind: "agent",
          id: "review",
          role: "review",
          model: "reviewers",
          exits: [
            { name: "approved", to: "land-gate" },
            { name: "returned", to: "queue", fails: "author" },
          ],
        },
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
        {
          kind: "agent",
          id: "author",
          role: "author",
          model: "ladder",
          exits: [
            { name: "done", to: "land" },
            { name: "already-done", to: "land" },
          ],
        },
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

describe("a pipelines file from before the reviewers", () => {
  test("reads a review block's above as reviewers, and is stored that way once written", async () => {
    const pipeline = {
      nodes: STANDARD_PIPELINES.worktree.nodes.map((node) =>
        node.kind === "agent" && node.role === "review" ? { ...node, model: "above" } : node,
      ),
    };
    writeFileSync(path, JSON.stringify({ version: 3, pipelines: { amux: pipeline } }));
    await run("set", "other", fileWith(pinned));

    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.version).toBe(4);
    expect(stored.pipelines.amux).toEqual(STANDARD_PIPELINES.worktree);
  });
});

describe("a pipelines file from before the exits", () => {
  test("gives each agent and check the standard exits for its role, and is stored that way once written", async () => {
    const drawn = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "branch" },
        { kind: "branch", id: "branch", next: "worktree" },
        { kind: "worktree", id: "worktree", next: "start" },
        { kind: "gate", id: "start", step: "author", next: "author" },
        { kind: "agent", id: "author", role: "author", model: "ladder", next: "lint-gate" },
        { kind: "gate", id: "lint-gate", step: "review", next: "lint" },
        { kind: "check", id: "lint", command: "bun run lint", next: "review-gate" },
        { kind: "gate", id: "review-gate", step: "review", next: "review" },
        { kind: "agent", id: "review", role: "review", model: "above", next: "land-gate" },
        { kind: "gate", id: "land-gate", step: "land", next: "land" },
        { kind: "land", id: "land" },
      ],
    };
    writeFileSync(path, JSON.stringify({ version: 2, pipelines: { amux: drawn } }));
    await run("set", "other", fileWith(pinned));

    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.version).toBe(4);
    const byId = new Map(
      stored.pipelines.amux.nodes.map((node: { readonly id: string }) => [node.id, node]),
    );
    expect(byId.get("author")).toEqual({
      kind: "agent",
      id: "author",
      role: "author",
      model: "ladder",
      exits: [
        { name: "done", to: "lint-gate" },
        { name: "already-done", to: "lint-gate" },
      ],
    });
    expect(byId.get("lint")).toEqual({
      kind: "check",
      id: "lint",
      command: "bun run lint",
      exits: [
        { name: "passed", to: "review-gate" },
        { name: "failed", to: "queue", fails: "author" },
      ],
    });
    expect(byId.get("review")).toEqual({
      kind: "agent",
      id: "review",
      role: "review",
      model: "reviewers",
      exits: [
        { name: "approved", to: "land-gate" },
        { name: "returned", to: "queue", fails: "author" },
      ],
    });
  });
});

describe("drawing a draft", () => {
  const change = (value: unknown) => JSON.stringify(value);
  const draftOf = () => JSON.parse(readFileSync(drafts, "utf8")).drafts.amux;

  test("edit starts a draft from the pipeline the project runs, and leaves that pipeline as it is", async () => {
    await run("edit", "amux", change({ _tag: "Remove", id: "climb" }));
    expect(existsSync(path)).toBe(false);
    expect(draftOf().base).toBeNull();
    expect(draftOf().pipeline.nodes.some((node: { id: string }) => node.id === "climb")).toBe(
      false,
    );
  });

  test("a version 1 draft reads its review rule above as reviewers", async () => {
    const old = {
      nodes: STANDARD_PIPELINES.worktree.nodes.map((node) =>
        node.kind === "agent" && node.role === "review" ? { ...node, model: "above" } : node,
      ),
    };
    writeFileSync(
      drafts,
      JSON.stringify({ version: 1, drafts: { amux: { base: null, pipeline: old } } }),
    );
    await run("save", "amux");
    expect(JSON.parse(readFileSync(path, "utf8")).pipelines.amux).toEqual(
      STANDARD_PIPELINES.worktree,
    );
  });

  test("save checks the draft, then writes it as the pipeline the project runs", async () => {
    await run("set", "amux", fileWith(pinned));
    await run(
      "edit",
      "amux",
      change({ _tag: "Configure", id: "land", setting: { kind: "land", how: "fast-forward" } }),
    );
    await run("save", "amux");
    const saved = JSON.parse(readFileSync(path, "utf8")).pipelines.amux;
    expect(saved.nodes.find((node: { id: string }) => node.id === "land").how).toBe("fast-forward");
    expect(JSON.parse(readFileSync(drafts, "utf8")).drafts).toEqual({});
  });

  test("save refuses a draft that cannot run, and keeps it", async () => {
    await run(
      "edit",
      "amux",
      change({ _tag: "InsertOn", wire: { from: "queue", port: "next" }, kind: "check" }),
    );
    expect(await refusal("save", "amux")).toMatch(/cannot run/);
    expect(existsSync(path)).toBe(false);
    expect(draftOf()).toBeDefined();
  });

  test("removing the only source keeps the rest of the draft, and save refuses until a source is added", async () => {
    await run("edit", "amux", change({ _tag: "Remove", id: "queue" }));
    expect(draftOf().pipeline.nodes.map((node: { id: string }) => node.id)).toContain("author");
    expect(await refusal("save", "amux")).toMatch(/no source supplied/);
    await run("edit", "amux", change({ _tag: "AddSource", filter: "" }));
    await run("save", "amux");
    expect(existsSync(path)).toBe(true);
  });

  test("save refuses when the pipeline changed since the draft began", async () => {
    await run("edit", "amux", change({ _tag: "SwapEnd", id: "land" }));
    await run("set", "amux", fileWith(pinned));
    expect(await refusal("save", "amux")).toMatch(/changed since this draft began/);
  });

  test("a rejoin that would close a loop is refused, and the draft is not written", async () => {
    expect(
      await refusal(
        "edit",
        "amux",
        change({ _tag: "Rejoin", wire: { from: "land-gate", port: "next" }, to: "queue" }),
      ),
    ).toMatch(/would close a loop/);
    expect(existsSync(drafts)).toBe(false);
  });

  test("an agent setting takes the slots the block itself allows", async () => {
    const setting = (slots: number) =>
      change({
        _tag: "Configure",
        id: "author",
        setting: { kind: "agent", role: "author", model: "ladder", slots },
      });
    const refused = await refusal("edit", "amux", setting(0));
    expect(refused).toMatch(/greater than 0/);
    expect(refused).not.toMatch(/Missing key/);
    expect(existsSync(drafts)).toBe(false);
    await run("edit", "amux", setting(2));
    expect(
      draftOf().pipeline.nodes.find((node: { id: string }) => node.id === "author").slots,
    ).toBe(2);
  });

  test("a setting for another kind of block is refused by name", async () => {
    const refused = await refusal(
      "edit",
      "amux",
      change({ _tag: "Configure", id: "queue", setting: { kind: "check", command: "bun test" } }),
    );
    expect(refused).toMatch(/queue is a source, so it takes no check setting/);
    expect(existsSync(drafts)).toBe(false);
  });

  test("discard drops the draft", async () => {
    await run("edit", "amux", change({ _tag: "SwapEnd", id: "land" }));
    await run("discard", "amux");
    expect(JSON.parse(readFileSync(drafts, "utf8")).drafts).toEqual({});
  });
});
