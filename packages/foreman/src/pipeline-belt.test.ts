import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { isExit } from "tasks";
import { expand } from "./composite.ts";
import {
  type Drawing,
  problemsOf,
  type SeatOffers,
  STANDARD_PIPELINES,
  standardOf,
  standardPipeline,
} from "./pipeline.ts";
import { pipelineOf } from "./pipeline-fixture.ts";
import {
  addExit,
  addRoute,
  addSource,
  beltOf,
  chargeExit,
  configure,
  insertOn,
  makeComposite,
  rejoin,
  remove,
  removeExit,
  removeRoute,
  renameExit,
  setEmpty,
  swapEnd,
} from "./pipeline-belt.ts";

const OFFERS: SeatOffers = {
  rungs: ["cheap", "strong"].map((name) => ({ name, author: true })),
  reviewers: ["sharp"],
};
const ids = (pipeline: Drawing) => pipeline.nodes.map((node) => node.id);
const node = (pipeline: Drawing, id: string) => pipeline.nodes.find((n) => n.id === id);
const gateSteps = (pipeline: Drawing) =>
  pipeline.nodes.flatMap((one) => (one.kind === "gate" ? [one.step] : []));
const exitsOf = (pipeline: Drawing, id: string) => {
  const found = node(pipeline, id);
  return found?.kind === "agent" || found?.kind === "check" ? found.exits : [];
};
const at = (pipeline: Drawing) =>
  Object.fromEntries(beltOf(pipeline).cells.map((cell) => [cell.node.id, [cell.column, cell.row]]));

describe("the standard pipeline as belts", () => {
  test("runs one belt, with the retry branch on a row of its own", () => {
    expect(at(STANDARD_PIPELINES.worktree)).toEqual({
      queue: [0, 0],
      branch: [1, 0],
      worktree: [2, 0],
      retry: [3, 0],
      climb: [4, 1],
      start: [4, 0],
      author: [5, 0],
      "review-gate": [6, 0],
      review: [7, 0],
      "land-gate": [8, 0],
      land: [9, 0],
    });
    const belt = beltOf(STANDARD_PIPELINES.worktree);
    expect([belt.columns, belt.rows]).toEqual([10, 2]);
    // The author's two exits onward are two wires to the same gate.
    expect(belt.wires).toHaveLength(14);
    // The returned exit runs back to the climb gate, against the flow.
    expect(belt.wires.filter((wire) => wire.back)).toEqual([
      { from: "review", port: "exit:returned", to: "climb", label: "returned", back: true },
    ]);
  });
});

describe("belt edits", () => {
  test("a block put on a wire runs on to where the wire went", () => {
    const { pipeline, id } = insertOn(
      STANDARD_PIPELINES.worktree,
      { from: "review", port: "exit:approved" },
      "agent",
    );
    expect(node(pipeline, "review")).toMatchObject({
      exits: [
        { id: "approved", name: "approved", to: id },
        { id: "returned", name: "returned", to: "climb", fails: "author" },
      ],
    });
    expect(node(pipeline, id)).toMatchObject({
      kind: "agent",
      exits: [
        { name: "done", to: "land-gate" },
        { name: "already-done", to: "land-gate", empty: "claim" },
      ],
    });
    // A second agent between review and land needs its own gate, and a review after it.
    expect(problemsOf(pipelineOf(pipeline), OFFERS)).toEqual([
      `a route from ${id} reaches land with no review after it`,
      `a route from review reaches ${id} through no gate`,
    ]);
  });

  test("a check put on a wire names no command until the operator sets one", () => {
    const { pipeline, id } = insertOn(
      STANDARD_PIPELINES.worktree,
      { from: "author", port: "exit:done" },
      "check",
    );
    expect(node(pipeline, id)).toEqual({
      kind: "check",
      id,
      command: "",
      exits: [
        { id: "passed", name: "passed", to: "review-gate" },
        { id: "failed", name: "failed", to: "queue", fails: "author" },
      ],
    });
    expect(problemsOf(pipelineOf(pipeline), OFFERS)).toEqual([
      `${id}: a check runs a command, and it names none`,
    ]);
    const named = configure(pipeline, id, { kind: "check", command: "bun run lint" });
    expect(node(named, id)).toMatchObject({
      command: "bun run lint",
      exits: [
        { id: "passed", name: "passed", to: "review-gate" },
        { id: "failed", name: "failed", to: "queue" },
      ],
    });
    expect(problemsOf(pipelineOf(named), OFFERS)).toEqual([
      `a route from author reaches ${id} through no gate`,
    ]);
  });

  test("new blocks never reuse an id", () => {
    const first = insertOn(STANDARD_PIPELINES.worktree, { from: "queue", port: "next" }, "gate");
    const second = insertOn(first.pipeline, { from: "queue", port: "next" }, "gate");
    expect(new Set(ids(second.pipeline)).size).toBe(ids(second.pipeline).length);
  });

  test("taking a block out joins the wires around it", () => {
    const pipeline = remove(STANDARD_PIPELINES.worktree, "retry");
    expect(node(pipeline, "worktree")).toMatchObject({ next: "start" });
    // The review's returned exit still reaches climb after the router goes.
    expect(ids(pipeline)).toContain("climb");
    expect(problemsOf(pipelineOf(pipeline), OFFERS)).toEqual([]);
  });

  test("an end stays, and turns from land to done to park and back", () => {
    expect(remove(STANDARD_PIPELINES.worktree, "land")).toBe(STANDARD_PIPELINES.worktree);
    const done = swapEnd(STANDARD_PIPELINES.worktree, "land");
    expect(node(done, "land")).toEqual({ kind: "done", id: "land" });
    const park = swapEnd(done, "land");
    expect(node(park, "land")).toEqual({ kind: "park", id: "land" });
    expect(node(swapEnd(park, "land"), "land")).toEqual({ kind: "land", id: "land" });
  });

  test("a land is set to merge or fast-forward", () => {
    const pipeline = configure(STANDARD_PIPELINES.worktree, "land", {
      kind: "land",
      how: "fast-forward",
    });
    expect(node(pipeline, "land")).toEqual({ kind: "land", id: "land", how: "fast-forward" });
    expect(problemsOf(pipelineOf(pipeline), OFFERS)).toEqual([]);
  });

  test("a land is set to land onto a branch, and a setting without onto clears it", () => {
    const onto = configure(STANDARD_PIPELINES.worktree, "land", {
      kind: "land",
      how: "merge",
      onto: "develop",
    });
    expect(node(onto, "land")).toEqual({ kind: "land", id: "land", how: "merge", onto: "develop" });
    expect(problemsOf(pipelineOf(onto), OFFERS)).toEqual([]);
    const cleared = configure(onto, "land", { kind: "land", how: "fast-forward" });
    expect(node(cleared, "land")).toEqual({ kind: "land", id: "land", how: "fast-forward" });
  });

  test("a land set to pull-request gets a publish gate, and one set back loses it", () => {
    for (const workspace of ["checkout", "worktree"] as const) {
      const published = configure(STANDARD_PIPELINES[workspace], "land", {
        kind: "land",
        how: "pull-request",
        onto: "develop",
      });
      expect(problemsOf(pipelineOf(published), OFFERS)).toEqual([]);
      expect(standardOf(published)).toEqual(
        Option.some({ workspace, how: "pull-request", onto: "develop" }),
      );
      const merged = configure(published, "land", { kind: "land", how: "merge" });
      expect(standardOf(merged)).toEqual(Option.some({ workspace, how: "merge" }));
      const forwarded = configure(published, "land", { kind: "land", how: "fast-forward" });
      expect(gateSteps(forwarded)).not.toContain("publish");
      expect(problemsOf(pipelineOf(forwarded), OFFERS)).toEqual([]);
    }
  });

  test("a land reached through a composite instance still gets its publish gate", () => {
    const made = makeComposite(
      STANDARD_PIPELINES.checkout,
      ["review-gate", "review"],
      "review-loop",
    );
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    const composites = { "review-loop": made.definition };
    // writtenBlocks would miss the route through the instance; expansion sees it.
    const published = configure(
      made.pipeline,
      "land",
      { kind: "land", how: "pull-request", onto: "develop" },
      composites,
    );
    expect(gateSteps(published)).toContain("publish");
    const expanded = expand(published, composites);
    expect(expanded._tag).toBe("Expanded");
    if (expanded._tag !== "Expanded") return;
    expect(problemsOf(expanded.pipeline, OFFERS)).toEqual([]);
  });

  test("a pull-request land keeps the publish gate it has", () => {
    const published = standardPipeline({ workspace: "worktree", how: "pull-request" });
    const moved = configure(published, "land", {
      kind: "land",
      how: "pull-request",
      onto: "develop",
    });
    expect(ids(moved)).toEqual(ids(published));
    const stranded = {
      nodes: published.nodes.map((one) =>
        one.kind === "land" ? { ...one, how: "merge" as const } : one,
      ),
    };
    expect(problemsOf(pipelineOf(stranded), OFFERS)).toContain(
      "publish-gate gates publish, but no route from it reaches a pull-request land",
    );
    expect(configure(stranded, "land", { kind: "land", how: "pull-request" })).toEqual(published);
  });

  test("a land behind no land gate gets one with its publish gate", () => {
    const authorGated = configure(STANDARD_PIPELINES.worktree, "land-gate", {
      kind: "gate",
      step: "author",
    });
    const published = configure(authorGated, "land", { kind: "land", how: "pull-request" });
    expect(gateSteps(published).toSorted()).toEqual([
      "author",
      "author",
      "climb",
      "land",
      "publish",
      "review",
    ]);
    expect(problemsOf(pipelineOf(published), OFFERS)).toEqual([]);
  });

  test("taking the worktree out leaves the task's branch in the operator's checkout", () => {
    const pipeline = remove(STANDARD_PIPELINES.worktree, "worktree");
    expect(node(pipeline, "branch")).toMatchObject({ next: "retry" });
    expect(problemsOf(pipelineOf(pipeline), OFFERS)).toEqual([]);
  });

  test("a branch and a worktree go on a wire with nothing to set", () => {
    const direct = swapEnd(
      remove(remove(STANDARD_PIPELINES.worktree, "worktree"), "branch"),
      "land",
    );
    expect(problemsOf(pipelineOf(direct), OFFERS)).toEqual([]);
    const branched = insertOn(direct, { from: "queue", port: "next" }, "branch");
    expect(node(branched.pipeline, branched.id)).toEqual({
      kind: "branch",
      id: branched.id,
      next: "retry",
    });
    expect(problemsOf(pipelineOf(branched.pipeline), OFFERS)).toEqual([
      `a route from ${branched.id} ends at land: work on this branch never lands`,
    ]);
  });

  test("a new route joins else at once, and blocks go on it", () => {
    const routed = addRoute(STANDARD_PIPELINES.worktree, "retry", "size>=3");
    expect(node(routed, "retry")).toMatchObject({
      routes: [{}, {}, { when: "size>=3", to: "start" }],
    });
    const { pipeline, id } = insertOn(routed, { from: "retry", port: 2 }, "gate");
    expect(node(pipeline, id)).toMatchObject({ next: "start" });
    expect(at(pipeline)[id]![1]).toBeGreaterThan(0);
  });

  test("dropping a route keeps the blocks only it reached, named as unreached", () => {
    const routed = addRoute(STANDARD_PIPELINES.worktree, "retry", "size>=3");
    const inserted = insertOn(routed, { from: "retry", port: 2 }, "gate");
    const pipeline = removeRoute(inserted.pipeline, "retry", 2);
    expect(ids(pipeline)).toContain(inserted.id);
    expect(problemsOf(pipelineOf(pipeline), OFFERS)).toContain(`no source reaches ${inserted.id}`);
    expect(ids(remove(pipeline, inserted.id))).not.toContain(inserted.id);
  });

  test("removing the only source removes that block alone, and a new source joins the rest", () => {
    const pipeline = remove(STANDARD_PIPELINES.worktree, "queue");
    expect(ids(pipeline)).toEqual(ids(STANDARD_PIPELINES.worktree).filter((id) => id !== "queue"));
    expect(problemsOf(pipelineOf(pipeline), OFFERS)).toEqual(["no source supplied"]);
    const { pipeline: supplied, id } = addSource(pipeline, "");
    expect(node(supplied, id)).toMatchObject({ next: "branch" });
    expect(problemsOf(pipelineOf(supplied), OFFERS)).toEqual([]);
  });

  test("an end no wire enters can go; one a wire enters stays", () => {
    const routed = insertOn(STANDARD_PIPELINES.worktree, { from: "queue", port: "next" }, "router");
    const parked = { nodes: [...routed.pipeline.nodes, { kind: "park" as const, id: "hold" }] };
    expect(ids(remove(parked, "hold"))).not.toContain("hold");
    expect(remove(STANDARD_PIPELINES.worktree, "land")).toBe(STANDARD_PIPELINES.worktree);
  });

  test("a wire rejoins a later block or an earlier one, never one the pipeline lacks", () => {
    const skip = rejoin(
      STANDARD_PIPELINES.worktree,
      { from: "climb", port: "next" },
      "review-gate",
    );
    expect(Option.map(skip, (pipeline) => node(pipeline, "climb"))).toEqual(
      Option.some({ kind: "gate", id: "climb", step: "climb", next: "review-gate" }),
    );
    const looped = rejoin(
      STANDARD_PIPELINES.worktree,
      { from: "review", port: "exit:approved" },
      "start",
    ).pipe(Option.getOrThrow);
    expect(beltOf(looped).wires).toContainEqual({
      from: "review",
      port: "exit:approved",
      to: "start",
      label: "approved",
      back: true,
    });
    // The loop leaves the land unreached, and validation says so.
    expect(problemsOf(pipelineOf(looped), OFFERS)).toContain("no source reaches land");
    expect(
      rejoin(
        STANDARD_PIPELINES.worktree,
        { from: "review", port: "exit:approved" },
        "no-such-block",
      ),
    ).toEqual(Option.none());
  });

  test("an exit is added where the first exit leads, renamed, charged and removed", () => {
    const added = addExit(STANDARD_PIPELINES.worktree, "author", "stuck");
    const stuck = exitsOf(added, "author")[2]?.id ?? "";
    // A fresh id, not the name: a name given back after a removal would
    // otherwise place the removed exit's tasks at the new one.
    expect(stuck).toMatch(/^exit-[a-z]{10}$/);
    // A run stores the id as its ending, and the store must read it as an exit.
    expect(isExit(stuck)).toBe(true);
    expect(node(added, "author")).toMatchObject({
      exits: [{ name: "done" }, { name: "already-done" }, { name: "stuck", to: "review-gate" }],
    });
    const back = rejoin(added, { from: "author", port: "exit:stuck" }, "start").pipe(
      Option.getOrThrow,
    );
    // Back to the author's own gate with nothing charged, the loop never ends.
    expect(problemsOf(pipelineOf(back), OFFERS)).toEqual([
      "the wires loop through author, start, and nothing ends the loop: no exit on it fails a rung, and no router leaves it on a count that grows",
    ]);
    const charged = chargeExit(back, "author", "stuck", "self");
    expect(node(charged, "author")).toMatchObject({
      exits: [{}, {}, { id: stuck, name: "stuck", to: "start", fails: "self" }],
    });
    expect(problemsOf(pipelineOf(charged), OFFERS)).toEqual([]);
    const renamed = renameExit(charged, "author", "stuck", "blocked");
    expect(node(renamed, "author")).toMatchObject({
      exits: [{}, {}, { id: stuck, name: "blocked", to: "start", fails: "self" }],
    });
    expect(node(chargeExit(renamed, "author", "blocked", undefined), "author")).toMatchObject({
      exits: [{}, {}, { id: stuck, name: "blocked", to: "start" }],
    });
    expect(node(removeExit(renamed, "author", "blocked"), "author")).toEqual(
      node(STANDARD_PIPELINES.worktree, "author"),
    );
  });

  test("an exit leads back to the queue, and renaming an exit a router counts renames it in the filter", () => {
    const returned = rejoin(
      STANDARD_PIPELINES.worktree,
      { from: "review", port: "exit:returned" },
      "queue",
    ).pipe(Option.getOrThrow);
    expect(node(returned, "review")).toMatchObject({
      exits: [{}, { id: "returned", name: "returned", to: "queue", fails: "author" }],
    });
    const counted = configure(returned, "retry", {
      kind: "router",
      route: 1,
      when: "exits:returned>=2",
    });
    const renamed = renameExit(counted, "review", "returned", "sent-back");
    expect(node(renamed, "retry")).toMatchObject({
      routes: [{ when: "failed" }, { when: "exits:sent-back>=2" }],
    });
    expect(problemsOf(pipelineOf(renamed), OFFERS)).toEqual(
      problemsOf(pipelineOf(counted), OFFERS),
    );
    // While another exit still has the old name, the filter keeps counting it.
    const twice = renameExit(
      addExit(counted, "author", "returned"),
      "review",
      "returned",
      "sent-back",
    );
    expect(node(twice, "retry")).toMatchObject({
      routes: [{ when: "failed" }, { when: "exits:returned>=2" }],
    });
  });

  test("marking an exit the claim unmarks the author's other exits", () => {
    const moved = setEmpty(STANDARD_PIPELINES.worktree, "author", "done", "claim");
    expect(exitsOf(moved, "author").map((exit) => [exit.name, exit.empty])).toEqual([
      ["done", "claim"],
      ["already-done", undefined],
    ]);
    const none = setEmpty(moved, "author", "done", undefined);
    expect(exitsOf(none, "author").some((exit) => exit.empty !== undefined)).toBe(false);
  });

  test("a wire can rejoin an acyclic sibling in the same column", () => {
    expect(at(STANDARD_PIPELINES.worktree).climb?.[0]).toBe(
      at(STANDARD_PIPELINES.worktree).start?.[0],
    );
    const joined = rejoin(STANDARD_PIPELINES.worktree, { from: "climb", port: "next" }, "start");
    expect(Option.map(joined, (pipeline) => node(pipeline, "climb"))).toEqual(
      Option.some({ kind: "gate", id: "climb", step: "climb", next: "start" }),
    );
    expect(Option.map(joined, (pipeline) => node(pipeline, "review"))).toEqual(
      Option.some(node(STANDARD_PIPELINES.worktree, "review")),
    );
  });

  test("a new source starts a belt that joins the first one", () => {
    const { pipeline, id } = addSource(STANDARD_PIPELINES.worktree, "label:research");
    expect(node(pipeline, id)).toMatchObject({ filter: "label:research", next: "branch" });
    expect(at(pipeline)[id]).toEqual([0, 2]);
  });

  test("configuring a block keeps its id and wires", () => {
    const pipeline = configure(STANDARD_PIPELINES.worktree, "author", {
      kind: "agent",
      role: "author",
      model: "cheap",
      slots: 2,
    });
    expect(node(pipeline, "author")).toEqual({
      kind: "agent",
      id: "author",
      role: "author",
      model: "cheap",
      slots: 2,
      exits: [
        { id: "done", name: "done", to: "review-gate" },
        { id: "already-done", name: "already-done", to: "review-gate", empty: "claim" },
      ],
    });
    const unslotted = configure(pipeline, "author", {
      kind: "agent",
      role: "author",
      model: "cheap",
      slots: undefined,
    });
    expect(node(unslotted, "author")).not.toHaveProperty("slots");
    expect(
      node(
        configure(STANDARD_PIPELINES.worktree, "retry", {
          kind: "router",
          route: 1,
          when: "attempts>=2",
        }),
        "retry",
      ),
    ).toMatchObject({
      routes: [{ when: "failed" }, { when: "attempts>=2", to: "climb" }],
    });
  });

  test("a looped file still draws", () => {
    const looped: Drawing = {
      nodes: STANDARD_PIPELINES.worktree.nodes.map((n) =>
        n.id === "land-gate" ? { ...n, next: "author" } : n,
      ),
    };
    expect(beltOf(looped).cells).toHaveLength(looped.nodes.length);
  });
});
