import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutoverExitIds, withWorkspace } from "./cutover-exits.ts";
import { place, type Pipeline, STANDARD_PIPELINES } from "./pipeline.ts";
import { readDrafts } from "./pipeline-draft.ts";
import { factsOf } from "./pipeline-facts.ts";
import { readPipelines } from "./pipeline-file.ts";
import { authorDone, authorRun, reviewRun } from "./task-fixture.ts";

const folder = mkdtempSync(join(tmpdir(), "foreman-cutover-exits-"));
const path = join(folder, "pipelines.json");
const drafts = join(folder, "pipelines.draft.json");
process.env["FOREMAN_PIPELINES"] = path;
afterAll(() => rmSync(folder, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(path, { force: true });
  rmSync(drafts, { force: true });
});

const cutover = (dryRun = false) =>
  Effect.runPromise(cutoverExitIds({ dryRun }).pipe(Effect.provide(BunServices.layer)));
const read = (at: string) => JSON.parse(readFileSync(at, "utf8"));

/** `pipeline` as a file from before exit ids drew it: each exit a name alone. */
const namedOnly = (pipeline: Pipeline) => ({
  nodes: pipeline.nodes.map((node) =>
    node.kind === "agent" || node.kind === "check"
      ? { ...node, exits: node.exits.map(({ id: _id, empty: _empty, ...exit }) => exit) }
      : node,
  ),
});

const STANDARD = STANDARD_PIPELINES.worktree;

describe("foreman cutover exit-ids", () => {
  test("gives each exit its name as its id, declares the author's already-done the claim, and places every task as before", async () => {
    // A task at each kind of standing the stored runs give: handed to review,
    // approved for landing, and returned to the climb gate.
    const tasks = [
      [authorDone("low")],
      [authorDone("low"), reviewRun("mid", { open: false, ending: "approved", commit: "c1" })],
      [authorDone("low"), reviewRun("mid", { open: false, ending: "returned", commit: "c1" })],
      [authorRun("low", { open: false, ending: "already-done", commit: "c1" })],
    ].map((runs) => ({
      status: "in_progress" as const,
      priority: 2,
      parent: undefined,
      labels: [],
      runs,
      charges: [],
      tip: "c1",
    }));
    const before = tasks.map((task) => place(STANDARD, factsOf(task, STANDARD)));

    writeFileSync(path, JSON.stringify({ version: 4, pipelines: { amux: namedOnly(STANDARD) } }));
    writeFileSync(
      drafts,
      JSON.stringify({
        version: 2,
        drafts: { amux: { base: namedOnly(STANDARD), pipeline: namedOnly(STANDARD) } },
      }),
    );
    const reports = await cutover();
    expect(reports.map((report) => report.from)).toEqual(["version 4", "version 2"]);

    const pipelines = await Effect.runPromise(
      readPipelines(path).pipe(Effect.provide(BunServices.layer)),
    );
    expect(pipelines.error).toBeUndefined();
    const converted = pipelines.value["amux"]!;
    expect(converted).toEqual(STANDARD);
    expect(tasks.map((task) => place(converted, factsOf(task, converted)))).toEqual(before);

    const draft = await Effect.runPromise(
      readDrafts(drafts).pipe(Effect.provide(BunServices.layer)),
    );
    expect(draft.value["amux"]).toEqual({ base: STANDARD, pipeline: STANDARD });

    // A second run finds both files current and writes nothing.
    const text = readFileSync(path, "utf8");
    expect((await cutover()).map((report) => report.from)).toEqual(["current", "current"]);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("a dry run writes nothing", async () => {
    const old = JSON.stringify({ version: 4, pipelines: { amux: namedOnly(STANDARD) } });
    writeFileSync(path, old);
    expect((await cutover(true))[0].from).toBe("version 4");
    expect(readFileSync(path, "utf8")).toBe(old);
    expect(existsSync(drafts)).toBe(false);
  });

  test("only an author's already-done is a claim, and only by the name the old files read", async () => {
    const pipeline = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "author" },
        {
          kind: "agent",
          id: "author",
          role: "author",
          model: "ladder",
          exits: [
            { name: "done", to: "review" },
            { name: "already-done", to: "review" },
          ],
        },
        {
          kind: "agent",
          id: "review",
          role: "review",
          model: "reviewers",
          exits: [
            { name: "already-done", to: "land" },
            { name: "returned", to: "queue", fails: "author" },
          ],
        },
        { kind: "land", id: "land" },
      ],
    };
    writeFileSync(path, JSON.stringify({ version: 4, pipelines: { amux: pipeline } }));
    await cutover();
    const [, author, review] = read(path).pipelines.amux.nodes;
    expect(author.exits).toEqual([
      { id: "done", name: "done", to: "review" },
      { id: "already-done", name: "already-done", to: "review", empty: "claim" },
    ]);
    expect(review.exits).toEqual([
      { id: "already-done", name: "already-done", to: "land" },
      { id: "returned", name: "returned", to: "queue", fails: "author" },
    ]);
  });

  test("a version 3 file reads a review block's above as reviewers", async () => {
    const above = {
      nodes: namedOnly(STANDARD).nodes.map((node) =>
        node.kind === "agent" && node.role === "review" ? { ...node, model: "above" } : node,
      ),
    };
    writeFileSync(path, JSON.stringify({ version: 3, pipelines: { amux: above } }));
    writeFileSync(
      drafts,
      JSON.stringify({ version: 1, drafts: { amux: { base: null, pipeline: above } } }),
    );
    await cutover();
    expect(read(path)).toEqual({ version: 5, pipelines: { amux: STANDARD } });
    expect(read(drafts)).toEqual({
      version: 3,
      drafts: { amux: { base: null, pipeline: STANDARD } },
    });
  });

  test("a version 2 file gives each agent and check the standard exits for its role", async () => {
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
    await cutover();
    const byId = new Map(
      read(path).pipelines.amux.nodes.map((node: { readonly id: string }) => [node.id, node]),
    );
    expect(byId.get("author")).toEqual({
      kind: "agent",
      id: "author",
      role: "author",
      model: "ladder",
      exits: [
        { id: "done", name: "done", to: "lint-gate" },
        { id: "already-done", name: "already-done", to: "lint-gate", empty: "claim" },
      ],
    });
    expect(byId.get("lint")).toEqual({
      kind: "check",
      id: "lint",
      command: "bun run lint",
      exits: [
        { id: "passed", name: "passed", to: "review-gate" },
        { id: "failed", name: "failed", to: "queue", fails: "author" },
      ],
    });
    expect(byId.get("review")).toEqual({
      kind: "agent",
      id: "review",
      role: "review",
      model: "reviewers",
      exits: [
        { id: "approved", name: "approved", to: "land-gate" },
        { id: "returned", name: "returned", to: "queue", fails: "author" },
      ],
    });
  });

  test("a file with no version gets a branch and a worktree after each source", async () => {
    const old = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "author" },
        { kind: "agent", id: "author", role: "author", model: "ladder", next: "review" },
        { kind: "agent", id: "review", role: "review", model: "above", next: "land" },
        { kind: "land", id: "land" },
      ],
    };
    writeFileSync(path, JSON.stringify({ amux: old }));
    await cutover();
    expect(read(path).version).toBe(5);
    expect(read(path).pipelines.amux.nodes.map((node: { readonly id: string }) => node.id)).toEqual(
      ["queue", "branch", "worktree", "author", "review", "land"],
    );
  });

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
          exits: [{ id: "done", name: "done", to: "land" }],
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
});
