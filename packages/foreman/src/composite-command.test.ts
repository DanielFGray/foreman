import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STANDARD_PIPELINES } from "./pipeline.ts";
import { compositeCommand } from "./composite-command.ts";
import { pipelineCommand as pipelineCommandWith } from "./pipeline-command.ts";
import { Dispatcher } from "./dispatcher.ts";
import { scratchStore, seed } from "./scratch-store.ts";

const folder = mkdtempSync(join(tmpdir(), "foreman-composite-command-"));
const path = join(folder, "pipelines.json");
process.env["FOREMAN_PIPELINES"] = path;
process.env["XDG_CONFIG_HOME"] = folder;
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

const platform = Layer.merge(BunServices.layer, store.registry);

const runComposite = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(compositeCommand, { version: "test" })(args).pipe(Effect.provide(platform)),
  );

const refuseComposite = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(compositeCommand, { version: "test" })(args).pipe(
      Effect.flip,
      Effect.map((error) => ("detail" in error ? String(error.detail) : String(error))),
      Effect.provide(platform),
    ),
  );

const runPipeline = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(pipelineCommand, { version: "test" })(args).pipe(Effect.provide(platform)),
  );

const refusePipeline = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(pipelineCommand, { version: "test" })(args).pipe(
      Effect.flip,
      Effect.map((error) => ("detail" in error ? String(error.detail) : String(error))),
      Effect.provide(platform),
    ),
  );

const change = (value: unknown) => JSON.stringify(value);

/** What a run of the composite command prints. */
const printedComposite = async (...args: ReadonlyArray<string>) => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runComposite(...args);
    return log.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    log.mockRestore();
  }
};

const reviewLoop = {
  entry: "review-gate",
  exits: [
    { id: "exit-landable", name: "landable" },
    { id: "exit-rework", name: "rework" },
  ],
  params: [] as Array<unknown>,
  blocks: [
    { kind: "gate", id: "review-gate", step: "review", next: "review" },
    {
      kind: "agent",
      id: "review",
      role: "review",
      model: "reviewers",
      exits: [
        { id: "approved", name: "approved", to: "out:exit-landable" },
        { id: "returned", name: "returned", to: "out:exit-rework", fails: "author" },
      ],
    },
  ],
};

const pipelineWithReviewLoop = (of = "review-loop") => {
  const nodes = STANDARD_PIPELINES.checkout.nodes
    .filter((node) => node.id !== "review-gate" && node.id !== "review")
    .map((node) =>
      node.kind === "agent" && node.id === "author"
        ? {
            ...node,
            exits: node.exits.map((exit) =>
              exit.to === "review-gate" ? { ...exit, to: "checks" } : exit,
            ),
          }
        : node,
    );
  return {
    nodes: [
      ...nodes,
      {
        kind: "composite",
        id: "checks",
        of,
        prefix: "checks.",
        set: {},
        exits: [
          { id: "exit-landable", to: "land-gate" },
          { id: "exit-rework", to: "climb" },
        ],
      },
    ],
  };
};

const writeReviewLoopProject = (project = "amux") => {
  writeFileSync(
    path,
    JSON.stringify({
      pipelines: { [project]: pipelineWithReviewLoop() },
      composites: { "review-loop": reviewLoop },
    }),
  );
};

describe("foreman composite", () => {
  test("edit, show, save and discard round-trip a definition draft", async () => {
    writeReviewLoopProject();
    await runComposite(
      "edit",
      "review-loop",
      change({ _tag: "RenameCompositeExit", id: "exit-landable", name: "ok" }),
    );
    const draft = JSON.parse(readFileSync(drafts, "utf8")).composites["review-loop"];
    expect(
      draft.definition.exits.find((exit: { id: string }) => exit.id === "exit-landable").name,
    ).toBe("ok");
    expect(JSON.parse(readFileSync(path, "utf8")).composites["review-loop"]).toEqual(reviewLoop);

    await runComposite("show", "review-loop", "--json");
    await runComposite("save", "review-loop");
    expect(
      JSON.parse(readFileSync(path, "utf8")).composites["review-loop"].exits.find(
        (exit: { id: string }) => exit.id === "exit-landable",
      ).name,
    ).toBe("ok");
    expect(JSON.parse(readFileSync(drafts, "utf8")).composites).toEqual({});

    await runComposite(
      "edit",
      "review-loop",
      change({ _tag: "RenameCompositeExit", id: "exit-landable", name: "landable" }),
    );
    await runComposite("discard", "review-loop");
    expect(JSON.parse(readFileSync(drafts, "utf8")).composites).toEqual({});
    expect(
      JSON.parse(readFileSync(path, "utf8")).composites["review-loop"].exits.find(
        (exit: { id: string }) => exit.id === "exit-landable",
      ).name,
    ).toBe("ok");
  });

  test("a definition save that would break one project's pipeline is refused and names it", async () => {
    writeReviewLoopProject("amux");
    // Drop the review agent the entry gate hands off to, so amux's expansion cannot resolve that wire.
    await runComposite("edit", "review-loop", change({ _tag: "Remove", id: "review" }));
    const refused = await refuseComposite("save", "review-loop");
    expect(refused).toMatch(/amux/);
    expect(refused).toMatch(/review-gate|entry|unknown|missing|reaches/i);
    expect(JSON.parse(readFileSync(path, "utf8")).composites["review-loop"]).toEqual(reviewLoop);
    expect(JSON.parse(readFileSync(drafts, "utf8")).composites["review-loop"]).toBeDefined();
  });

  test("removing a definition's entry block is refused, and the draft keeps the entry", async () => {
    writeReviewLoopProject();
    const refused = await refuseComposite(
      "edit",
      "review-loop",
      change({ _tag: "Remove", id: "review-gate" }),
    );
    expect(refused).toMatch(/review-gate/);
    expect(refused).toMatch(/entry/);
    expect(existsSync(drafts)).toBe(false);
  });

  test("a save with a dangling entry is refused when no project uses the definition", async () => {
    writeFileSync(
      path,
      JSON.stringify({ pipelines: {}, composites: { "review-loop": reviewLoop } }),
    );
    await runComposite(
      "edit",
      "review-loop",
      change({ _tag: "RenameCompositeExit", id: "exit-landable", name: "ok" }),
    );
    const draftFile = JSON.parse(readFileSync(drafts, "utf8"));
    draftFile.composites["review-loop"].definition.entry = "nowhere";
    writeFileSync(drafts, JSON.stringify(draftFile));
    const refused = await refuseComposite("save", "review-loop");
    expect(refused).toMatch(/nowhere/);
    expect(JSON.parse(readFileSync(path, "utf8")).composites["review-loop"]).toEqual(reviewLoop);
  });

  test("prompt renders a definition's block from its draft by the definition-local id, else from the stored definition", async () => {
    writeReviewLoopProject();
    const prompts = join(folder, "foreman", "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "probe-custom.md"), "COMPOSITE DRAFT MARKER for {{ task }}");
    try {
      const stored = await printedComposite("prompt", "review-loop", "review");
      expect(stored).not.toContain("COMPOSITE DRAFT MARKER");
      // No change verb sets `instructions`; a draft that reads other instructions
      // is a draft file the operator or the pane's editor wrote.
      await runComposite(
        "edit",
        "review-loop",
        change({ _tag: "RenameCompositeExit", id: "exit-landable", name: "ok" }),
      );
      const draftFile = JSON.parse(readFileSync(drafts, "utf8"));
      const blocks = draftFile.composites["review-loop"].definition.blocks;
      blocks[blocks.findIndex((one: { id: string }) => one.id === "review")].instructions =
        "probe-custom";
      writeFileSync(drafts, JSON.stringify(draftFile));
      const edited = await printedComposite("prompt", "review-loop", "review");
      expect(edited).toContain("COMPOSITE DRAFT MARKER for trace");
      expect(edited).toContain("`foreman exit trace approved`");
      expect(await refuseComposite("prompt", "review-loop", "review-gate")).toBe(
        "composite review-loop has no agent block named review-gate",
      );
      expect(await refuseComposite("prompt", "nobody", "review")).toBe("no composite named nobody");
    } finally {
      rmSync(join(folder, "foreman"), { recursive: true, force: true });
    }
  });

  test("a nested instance in an opened definition lists every exit in show and edit, the queued one routable to an outer out", async () => {
    // `outer` holds one instance of review-loop whose second exit returns to the queue,
    // which the drawing has no wire for.
    const outer = {
      entry: "nested",
      exits: [{ id: "exit-done", name: "done" }],
      params: [],
      blocks: [
        {
          kind: "composite",
          id: "nested",
          of: "review-loop",
          prefix: "nested.",
          set: {},
          exits: [
            { id: "exit-landable", to: "out:exit-done" },
            { id: "exit-rework", to: "queue" },
          ],
        },
      ],
    };
    writeFileSync(
      path,
      JSON.stringify({
        pipelines: { amux: pipelineWithReviewLoop() },
        composites: { "review-loop": reviewLoop, outer },
      }),
    );
    const exitsOf = (shown: {
      drawing: { blocks: ReadonlyArray<{ id: string; exits?: unknown }> };
    }) => shown.drawing.blocks.find((block) => block.id === "nested")?.exits;
    const queued = [
      { id: "exit-landable", name: "landable", to: "out:exit-done" },
      { id: "exit-rework", name: "rework", to: "queue" },
    ];

    expect(exitsOf(JSON.parse(await printedComposite("show", "outer", "--json")))).toEqual(queued);
    const rerouted = JSON.parse(
      await printedComposite(
        "edit",
        "outer",
        change({
          _tag: "Rejoin",
          wire: { from: "nested", port: "exit:exit-rework" },
          to: "out:exit-done",
        }),
        "--json",
      ),
    );
    expect(exitsOf(rerouted)).toEqual([
      queued[0],
      { id: "exit-rework", name: "rework", to: "out:exit-done" },
    ]);
  });

  test("a definition a project draft made is not readable until that draft is saved", async () => {
    await runPipeline("use", "checkout", "--project", "amux");
    await runPipeline(
      "edit",
      "amux",
      change({ _tag: "MakeComposite", ids: ["review-gate", "review"], name: "review-loop" }),
    );
    const refused = await refuseComposite("show", "review-loop", "--json");
    expect(refused).toContain("save that project's draft");
    expect(refused).not.toContain("no composite named");
    await runPipeline("save", "amux");
    expect(await runComposite("show", "review-loop", "--json")).toBeUndefined();
  });

  test("save refuses when the definition changed since its draft began", async () => {
    writeReviewLoopProject();
    await runComposite(
      "edit",
      "review-loop",
      change({ _tag: "RenameCompositeExit", id: "exit-rework", name: "back" }),
    );
    // Another writer changes the stored definition under the draft.
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.composites["review-loop"] = {
      ...reviewLoop,
      exits: reviewLoop.exits.map((exit) =>
        exit.id === "exit-landable" ? { ...exit, name: "ship" } : exit,
      ),
    };
    writeFileSync(path, JSON.stringify(file));
    expect(await refuseComposite("save", "review-loop")).toMatch(/changed since this draft began/);
  });

  test("a project draft save refuses when a definition it uses changed", async () => {
    writeReviewLoopProject();
    await runPipeline(
      "edit",
      "amux",
      change({ _tag: "Configure", id: "land", setting: { kind: "land", how: "fast-forward" } }),
    );
    const draft = JSON.parse(readFileSync(drafts, "utf8")).drafts.amux;
    expect(draft.bases["review-loop"]).toBeDefined();

    await runComposite(
      "edit",
      "review-loop",
      change({ _tag: "RenameCompositeExit", id: "exit-landable", name: "ok" }),
    );
    await runComposite("save", "review-loop");

    expect(await refusePipeline("save", "amux")).toMatch(/composite this draft uses changed/);
    expect(JSON.parse(readFileSync(drafts, "utf8")).drafts.amux).toBeDefined();
  });

  test("a project draft save refuses when a nested definition it reaches changed", async () => {
    // review-loop nests inner-step; the project only instances review-loop.
    const inner = {
      entry: "review-gate",
      exits: [
        { id: "exit-landable", name: "landable" },
        { id: "exit-rework", name: "rework" },
      ],
      params: [],
      blocks: reviewLoop.blocks,
    };
    const outer = {
      entry: "nested",
      exits: [
        { id: "exit-landable", name: "landable" },
        { id: "exit-rework", name: "rework" },
      ],
      params: [],
      blocks: [
        {
          kind: "composite",
          id: "nested",
          of: "inner-step",
          prefix: "",
          set: {},
          exits: [
            { id: "exit-landable", to: "out:exit-landable" },
            { id: "exit-rework", to: "out:exit-rework" },
          ],
        },
      ],
    };
    writeFileSync(
      path,
      JSON.stringify({
        pipelines: { amux: pipelineWithReviewLoop() },
        composites: { "inner-step": inner, "review-loop": outer },
      }),
    );
    await runPipeline(
      "edit",
      "amux",
      change({ _tag: "Configure", id: "land", setting: { kind: "land", how: "fast-forward" } }),
    );
    expect(JSON.parse(readFileSync(drafts, "utf8")).drafts.amux.bases["inner-step"]).toBeDefined();

    const file = JSON.parse(readFileSync(path, "utf8"));
    file.composites["inner-step"] = {
      ...inner,
      exits: inner.exits.map((exit) =>
        exit.id === "exit-landable" ? { ...exit, name: "ship" } : exit,
      ),
    };
    writeFileSync(path, JSON.stringify(file));
    expect(await refusePipeline("save", "amux")).toMatch(/inner-step/);
  });

  test("AddParam and SetEntry edit the definition draft", async () => {
    writeReviewLoopProject();
    await runComposite(
      "edit",
      "review-loop",
      change({
        _tag: "AddParam",
        name: "reviewer",
        default: "reviewers",
        sets: [{ block: "review", field: "model" }],
      }),
    );
    await runComposite("edit", "review-loop", change({ _tag: "SetEntry", entry: "review" }));
    const definition = JSON.parse(readFileSync(drafts, "utf8")).composites["review-loop"]
      .definition;
    expect(definition.entry).toBe("review");
    expect(definition.params).toEqual([
      { name: "reviewer", default: "reviewers", sets: [{ block: "review", field: "model" }] },
    ]);
    // SetEntry to review skips the gate, so save would break amux; put the entry back.
    await runComposite("edit", "review-loop", change({ _tag: "SetEntry", entry: "review-gate" }));
    await runComposite("save", "review-loop");
    expect(JSON.parse(readFileSync(path, "utf8")).composites["review-loop"].params).toEqual([
      { name: "reviewer", default: "reviewers", sets: [{ block: "review", field: "model" }] },
    ]);
  });

  test("Rejoin to out:<exit id> is allowed on a definition draft", async () => {
    writeReviewLoopProject();
    await runComposite(
      "edit",
      "review-loop",
      change({
        _tag: "Rejoin",
        wire: { from: "review", port: "exit:approved" },
        to: "out:exit-rework",
      }),
    );
    const review = JSON.parse(readFileSync(drafts, "utf8")).composites[
      "review-loop"
    ].definition.blocks.find((block: { id: string }) => block.id === "review");
    expect(review.exits[0].to).toBe("out:exit-rework");
  });

  test("Unpack of a definition's entry instance moves the entry into the expansion", async () => {
    const outer = {
      entry: "nested",
      exits: reviewLoop.exits,
      params: [],
      blocks: [
        {
          kind: "composite",
          id: "nested",
          of: "review-loop",
          prefix: "nested.",
          set: {},
          exits: [
            { id: "exit-landable", to: "out:exit-landable" },
            { id: "exit-rework", to: "out:exit-rework" },
          ],
        },
      ],
    };
    writeFileSync(
      path,
      JSON.stringify({
        pipelines: { amux: pipelineWithReviewLoop("outer") },
        composites: { "review-loop": reviewLoop, outer },
      }),
    );
    await runComposite("edit", "outer", change({ _tag: "Unpack", id: "nested" }));
    const definition = JSON.parse(readFileSync(drafts, "utf8")).composites.outer.definition;
    expect(definition.blocks.map((block: { id: string }) => block.id)).toContain(definition.entry);
    await runComposite("save", "outer");
    expect(JSON.parse(readFileSync(path, "utf8")).composites.outer.entry).toBe(definition.entry);
  });

  test("MakeComposite packs a selection that holds the definition's entry", async () => {
    writeReviewLoopProject();
    await runComposite(
      "edit",
      "review-loop",
      change({ _tag: "MakeComposite", ids: ["review-gate", "review"], name: "inner" }),
    );
    const definition = JSON.parse(readFileSync(drafts, "utf8")).composites["review-loop"]
      .definition;
    expect(definition.entry).toBe("inner");
    await runComposite("save", "review-loop");
    expect(JSON.parse(readFileSync(path, "utf8")).composites.inner.entry).toBe("review-gate");
  });

  test("AddParam without a default saves, and the parameter holds no default key", async () => {
    // The project's instance must set a parameter that has no default, or save refuses it.
    const pipeline = pipelineWithReviewLoop();
    const setting = {
      nodes: pipeline.nodes.map((node) =>
        node.id === "checks" ? { ...node, set: { reviewer: "reviewers" } } : node,
      ),
    };
    writeFileSync(
      path,
      JSON.stringify({ pipelines: { amux: setting }, composites: { "review-loop": reviewLoop } }),
    );
    await runComposite(
      "edit",
      "review-loop",
      change({
        _tag: "AddParam",
        name: "reviewer",
        sets: [{ block: "review", field: "model" }],
      }),
    );
    await runComposite("save", "review-loop");
    const stored = JSON.parse(readFileSync(path, "utf8")).composites["review-loop"].params;
    expect(stored).toEqual([{ name: "reviewer", sets: [{ block: "review", field: "model" }] }]);
    expect(Object.hasOwn(stored[0], "default")).toBe(false);
  });
});
