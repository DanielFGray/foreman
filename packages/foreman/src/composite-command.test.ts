import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const pipelineWithReviewLoop = () => {
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
        of: "review-loop",
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
    // Drop the entry gate so expansion of amux cannot place the instance.
    await runComposite("edit", "review-loop", change({ _tag: "Remove", id: "review-gate" }));
    const refused = await refuseComposite("save", "review-loop");
    expect(refused).toMatch(/amux/);
    expect(refused).toMatch(/review-gate|entry|unknown|missing|reaches/i);
    expect(JSON.parse(readFileSync(path, "utf8")).composites["review-loop"]).toEqual(reviewLoop);
    expect(JSON.parse(readFileSync(drafts, "utf8")).composites["review-loop"]).toBeDefined();
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
});
