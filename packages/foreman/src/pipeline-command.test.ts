import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { Command } from "effect/cli";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STANDARD_PIPELINES, standardOf, standardPipeline, WORKSPACE_CHOICES } from "./pipeline.ts";
import { Dispatcher } from "./dispatcher.ts";
import { pipelineCommand as pipelineCommandWith } from "./pipeline-command.ts";
import { readPipelines } from "./pipeline-file.ts";
import { Registry } from "./registry.ts";
import { scratchStore, seed } from "./scratch-store.ts";

const folder = mkdtempSync(join(tmpdir(), "foreman-pipeline-command-"));
const path = join(folder, "pipelines.json");
process.env["FOREMAN_PIPELINES"] = path;
// `instructions` writes the operator's prompts directory, under the config directory.
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

const platform = Layer.merge(BunServices.layer, store.registry);

const run = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(pipelineCommand, { version: "test" })(args).pipe(Effect.provide(platform)),
  );

/** The detail of the error a refused command fails with. */
const refusal = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(pipelineCommand, { version: "test" })(args).pipe(
      Effect.flip,
      Effect.map((error) => ("detail" in error ? String(error.detail) : String(error))),
      Effect.provide(platform),
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
      pipelines: { amux: JSON.parse(JSON.stringify(pinned)) },
      composites: {},
    });

    await run("clear", "amux");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pipelines: {}, composites: {} });
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
      expect(read.value.pipelines["amux"]).toEqual(STANDARD_PIPELINES[choice]);
    }
  });

  test("draws the landing --land and --onto name, over another standard choice", async () => {
    await run("use", "checkout", "--project", "amux");
    await run(
      "use",
      "worktree",
      "--land",
      "pull-request",
      "--onto",
      "develop",
      "--project",
      "amux",
    );
    expect(JSON.parse(readFileSync(path, "utf8")).pipelines.amux).toEqual(
      JSON.parse(
        JSON.stringify(
          standardPipeline({ workspace: "worktree", how: "pull-request", onto: "develop" }),
        ),
      ),
    );
  });

  test("refuses --land or --onto with direct, and writes nothing", async () => {
    for (const flag of [
      ["--land", "merge"],
      ["--onto", "develop"],
    ]) {
      expect(await refusal("use", "direct", ...flag, "--project", "amux")).toMatch(
        /takes no --land or --onto/,
      );
    }
    expect(existsSync(path)).toBe(false);
  });

  test("refuses over a drawing that is no standard choice, and leaves it as it is", async () => {
    await run("set", "amux", fileWith(pinned));
    expect(await refusal("use", "worktree", "--project", "amux")).toMatch(
      /amux runs its own drawn pipeline/,
    );
    expect(JSON.parse(readFileSync(path, "utf8")).pipelines.amux).toEqual(pinned);
  });
});

describe("reading the pipelines file", () => {
  test("a file that does not decode reports its path and why", async () => {
    writeFileSync(path, "{ not json");
    const read = await Effect.runPromise(
      readPipelines(path).pipe(Effect.provide(BunServices.layer)),
    );
    expect(read.error).toStartWith(`${path} does not decode: `);
    expect(read.error?.length).toBeGreaterThan(`${path} does not decode: `.length);
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

  test("MakeComposite carries the definition on the draft, and save writes both", async () => {
    await run("use", "checkout", "--project", "amux");
    await run(
      "edit",
      "amux",
      change({ _tag: "MakeComposite", ids: ["review-gate", "review"], name: "review-loop" }),
    );
    const draft = draftOf();
    expect(draft.composites["review-loop"]).toBeDefined();
    expect(draft.pipeline.nodes.some((node: { kind: string }) => node.kind === "composite")).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(path, "utf8")).composites).toEqual({});
    await run("save", "amux");
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.composites["review-loop"]).toBeDefined();
    expect(
      file.pipelines.amux.nodes.some((node: { kind: string }) => node.kind === "composite"),
    ).toBe(true);
    expect(JSON.parse(readFileSync(drafts, "utf8")).drafts).toEqual({});
  });

  test("one change of a land to pull-request leaves a draft that saves", async () => {
    await run("use", "worktree", "--project", "amux");
    await run(
      "edit",
      "amux",
      change({ _tag: "Configure", id: "land", setting: { kind: "land", how: "pull-request" } }),
    );
    await run("save", "amux");
    const read = await Effect.runPromise(
      readPipelines(path).pipe(Effect.provide(BunServices.layer)),
    );
    expect(standardOf(read.value.pipelines["amux"] ?? { nodes: [] })).toEqual(
      Option.some({ workspace: "worktree", how: "pull-request" }),
    );
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

  test("a rejoin to an earlier block is written, and save names what the loop leaves unreached", async () => {
    await run(
      "edit",
      "amux",
      change({ _tag: "Rejoin", wire: { from: "review", port: "exit:approved" }, to: "start" }),
    );
    expect(
      draftOf().pipeline.nodes.find((node: { id: string }) => node.id === "review").exits[0],
    ).toEqual({ id: "approved", name: "approved", to: "start" });
    expect(await refusal("save", "amux")).toMatch(/no source reaches land-gate/);
  });

  test("an exit added, wired back to the author's gate and charged lets the draft save", async () => {
    await run("edit", "amux", change({ _tag: "AddExit", id: "author", name: "stuck" }));
    await run(
      "edit",
      "amux",
      change({ _tag: "Rejoin", wire: { from: "author", port: "exit:stuck" }, to: "start" }),
    );
    expect(await refusal("save", "amux")).toMatch(/loop through author, start, and nothing ends/);
    await run(
      "edit",
      "amux",
      change({ _tag: "ChargeExit", id: "author", name: "stuck", fails: "self" }),
    );
    await run(
      "edit",
      "amux",
      change({ _tag: "RenameExit", id: "author", name: "stuck", to: "blocked" }),
    );
    await run("save", "amux");
    expect(
      JSON.parse(readFileSync(path, "utf8")).pipelines.amux.nodes.find(
        (node: { id: string }) => node.id === "author",
      ).exits,
    ).toEqual([
      { id: "done", name: "done", to: "review-gate" },
      { id: "already-done", name: "already-done", to: "review-gate", empty: "claim" },
      {
        id: expect.stringMatching(/^exit-[a-z]{10}$/),
        name: "blocked",
        to: "start",
        fails: "self",
      },
    ]);
    await run("edit", "amux", change({ _tag: "RemoveExit", id: "author", name: "blocked" }));
    expect(
      draftOf().pipeline.nodes.find((node: { id: string }) => node.id === "author").exits,
    ).toHaveLength(2);
  });

  test("an exit name the block has, or an exit on a check, is refused", async () => {
    expect(
      await refusal("edit", "amux", change({ _tag: "AddExit", id: "author", name: "done" })),
    ).toMatch(/author already has an exit named done/);
    expect(
      await refusal(
        "edit",
        "amux",
        change({ _tag: "RenameExit", id: "review", name: "returned", to: "approved" }),
      ),
    ).toMatch(/review already has an exit named approved/);
    expect(existsSync(drafts)).toBe(false);
    await run(
      "edit",
      "amux",
      change({ _tag: "InsertOn", wire: { from: "author", port: "exit:done" }, kind: "check" }),
    );
    const check = draftOf().pipeline.nodes.find(
      (node: { kind: string }) => node.kind === "check",
    ).id;
    expect(
      await refusal("edit", "amux", change({ _tag: "RemoveExit", id: check, name: "failed" })),
    ).toMatch(/a check's exits are passed and failed/);
    expect(
      await refusal(
        "edit",
        "amux",
        change({ _tag: "SetEmpty", id: "review", name: "approved", empty: "claim" }),
      ),
    ).toMatch(/review is no author, and only an author claims/);
  });

  test("a rejoin to a block the pipeline lacks is refused, and the draft is not written", async () => {
    expect(
      await refusal(
        "edit",
        "amux",
        change({ _tag: "Rejoin", wire: { from: "land-gate", port: "next" }, to: "nowhere" }),
      ),
    ).toMatch(/one of them is not in the pipeline/);
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

/** What a run of the command prints. */
const printed = async (...args: ReadonlyArray<string>) => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await run(...args);
    return log.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    log.mockRestore();
  }
};

describe("foreman pipeline prompt and instructions", () => {
  const change = (value: unknown) => JSON.stringify(value);
  const own = join(folder, "foreman", "prompts", "author.md");
  beforeEach(() => rmSync(join(folder, "foreman"), { recursive: true, force: true }));

  test("prompt shows a draft's agent block for a pretend task, with the exits the draft gives it", async () => {
    await run("edit", "amux", change({ _tag: "AddExit", id: "author", name: "stuck" }));
    await run(
      "edit",
      "amux",
      change({ _tag: "Rejoin", wire: { from: "author", port: "exit:stuck" }, to: "start" }),
    );
    const text = await printed("prompt", "amux", "author");
    expect(text).toContain("## Task\n\ntrace — a pretend task\nProject: amux.");
    expect(text).toContain("- `foreman exit trace stuck`: the task goes to start.");
    expect(text).toContain("Your task's work: `git log <base>..HEAD`");
  });

  test("prompt names no block that is not an agent", async () => {
    expect(await refusal("prompt", "amux", "land")).toBe(
      "amux's pipeline has no agent block named land",
    );
  });

  test("instructions prints the text foreman ships until the operator writes their own, which the prompt then carries", async () => {
    expect(await printed("instructions", "author")).toBe(
      readFileSync(join(import.meta.dir, "..", "prompts", "author.md"), "utf8"),
    );
    await run("instructions", "author", "Work on {{ task }} alone.");
    expect(readFileSync(own, "utf8")).toBe("Work on {{ task }} alone.");
    expect(await printed("instructions", "author")).toBe("Work on {{ task }} alone.");
    expect(await printed("prompt", "amux", "author")).toContain(
      "\n\nWork on trace alone.\n\n## Exits",
    );
  });

  test("instructions refuses a name that is no file name, and prints none for a name with no file", async () => {
    expect(await refusal("instructions", "../policy", "text")).toBe(
      "../policy is no file name: use a-z, 0-9 and -",
    );
    expect(existsSync(join(folder, "foreman"))).toBe(false);
    expect(await refusal("instructions", "nobody")).toBe("no instructions file is named nobody.md");
  });
});

describe("foreman pipeline check", () => {
  test("refuses an instance whose definition the file lacks, and names the definition", async () => {
    const drawn = {
      nodes: [
        ...STANDARD_PIPELINES.checkout.nodes,
        { kind: "composite", id: "unknown", of: "absent", prefix: "unknown.", set: {}, exits: [] },
      ],
    };
    expect(await refusal("check", fileWith(drawn))).toMatch(/absent is unknown/);
  });

  test("an instance that replaces the review loop checks as the pipeline it expands to", async () => {
    const reviewLoop = {
      entry: "review-gate",
      exits: [
        { id: "exit-landable", name: "landable" },
        { id: "exit-rework", name: "rework" },
      ],
      params: [],
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
    writeFileSync(
      path,
      JSON.stringify({ pipelines: {}, composites: { "review-loop": reviewLoop } }),
    );
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
    const drawn = {
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
    // A missing block would refuse here; the instance's blocks must be found.
    await expect(run("check", fileWith(drawn))).resolves.toBeUndefined();
  });
});
