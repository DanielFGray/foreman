import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { type Pipeline, problemsOf, STANDARD_PIPELINE } from "./pipeline.ts";
import {
  addRoute,
  addSource,
  beltOf,
  configure,
  insertOn,
  rejoin,
  remove,
  removeRoute,
  swapEnd,
} from "./pipeline-belt.ts";

const RUNGS = ["cheap", "strong"].map((name) => ({ name, author: true, review: true }));
const ids = (pipeline: Pipeline) => pipeline.nodes.map((node) => node.id);
const node = (pipeline: Pipeline, id: string) => pipeline.nodes.find((n) => n.id === id);
const at = (pipeline: Pipeline) =>
  Object.fromEntries(beltOf(pipeline).cells.map((cell) => [cell.node.id, [cell.column, cell.row]]));

describe("the standard pipeline as belts", () => {
  test("runs one belt, with the retry branch on a row of its own", () => {
    expect(at(STANDARD_PIPELINE)).toEqual({
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
    const belt = beltOf(STANDARD_PIPELINE);
    expect([belt.columns, belt.rows]).toEqual([10, 2]);
    // The author's two exits onward are two wires to the same gate.
    expect(belt.wires).toHaveLength(14);
    expect(belt.wires).toContainEqual({
      from: "review",
      port: "exit:returned",
      to: "climb",
      label: "returned",
    });
  });
});

describe("belt edits", () => {
  test("a block put on a wire runs on to where the wire went", () => {
    const { pipeline, id } = insertOn(
      STANDARD_PIPELINE,
      { from: "review", port: "exit:approved" },
      "agent",
    );
    expect(node(pipeline, "review")).toMatchObject({
      exits: [
        { name: "approved", to: id },
        { name: "returned", to: "climb", fails: "author" },
      ],
    });
    expect(node(pipeline, id)).toMatchObject({
      kind: "agent",
      exits: [
        { name: "done", to: "land-gate" },
        { name: "already-done", to: "land-gate" },
      ],
    });
    // A second agent between review and land needs its own gate, and a review after it.
    expect(problemsOf(pipeline, RUNGS)).toEqual([
      `a route from ${id} reaches land with no review after it`,
      `a route from review reaches ${id} through no gate`,
    ]);
  });

  test("a check put on a wire names no command until the operator sets one", () => {
    const { pipeline, id } = insertOn(
      STANDARD_PIPELINE,
      { from: "author", port: "exit:done" },
      "check",
    );
    expect(node(pipeline, id)).toEqual({
      kind: "check",
      id,
      command: "",
      exits: [
        { name: "passed", to: "review-gate" },
        { name: "failed", to: "queue", fails: "author" },
      ],
    });
    expect(problemsOf(pipeline, RUNGS)).toEqual([
      `${id}: a check runs a command, and it names none`,
    ]);
    const named = configure(pipeline, id, { command: "bun run lint" });
    expect(node(named, id)).toMatchObject({
      command: "bun run lint",
      exits: [
        { name: "passed", to: "review-gate" },
        { name: "failed", to: "queue" },
      ],
    });
    expect(problemsOf(named, RUNGS)).toEqual([`a route from author reaches ${id} through no gate`]);
  });

  test("new blocks never reuse an id", () => {
    const first = insertOn(STANDARD_PIPELINE, { from: "queue", port: "next" }, "gate");
    const second = insertOn(first.pipeline, { from: "queue", port: "next" }, "gate");
    expect(new Set(ids(second.pipeline)).size).toBe(ids(second.pipeline).length);
  });

  test("taking a block out joins the wires around it", () => {
    const pipeline = remove(STANDARD_PIPELINE, "retry");
    expect(node(pipeline, "worktree")).toMatchObject({ next: "start" });
    // The review's returned exit still reaches climb after the router goes.
    expect(ids(pipeline)).toContain("climb");
    expect(problemsOf(pipeline, RUNGS)).toEqual([]);
  });

  test("an end stays, and turns from land to done to park and back", () => {
    expect(remove(STANDARD_PIPELINE, "land")).toBe(STANDARD_PIPELINE);
    const done = swapEnd(STANDARD_PIPELINE, "land");
    expect(node(done, "land")).toEqual({ kind: "done", id: "land" });
    const park = swapEnd(done, "land");
    expect(node(park, "land")).toEqual({ kind: "park", id: "land" });
    expect(node(swapEnd(park, "land"), "land")).toEqual({ kind: "land", id: "land" });
  });

  test("a land is set to merge or fast-forward", () => {
    const pipeline = configure(STANDARD_PIPELINE, "land", { how: "fast-forward" });
    expect(node(pipeline, "land")).toEqual({ kind: "land", id: "land", how: "fast-forward" });
    expect(problemsOf(pipeline, RUNGS)).toEqual([]);
  });

  test("taking the worktree out leaves the task's branch in the operator's checkout", () => {
    const pipeline = remove(STANDARD_PIPELINE, "worktree");
    expect(node(pipeline, "branch")).toMatchObject({ next: "retry" });
    expect(problemsOf(pipeline, RUNGS)).toEqual([]);
  });

  test("a branch and a worktree go on a wire with nothing to set", () => {
    const direct = swapEnd(remove(remove(STANDARD_PIPELINE, "worktree"), "branch"), "land");
    expect(problemsOf(direct, RUNGS)).toEqual([]);
    const branched = insertOn(direct, { from: "queue", port: "next" }, "branch");
    expect(node(branched.pipeline, branched.id)).toEqual({
      kind: "branch",
      id: branched.id,
      next: "retry",
    });
    expect(problemsOf(branched.pipeline, RUNGS)).toEqual([
      `a route from ${branched.id} ends at land: work on this branch never lands`,
    ]);
  });

  test("a new route joins else at once, and blocks go on it", () => {
    const routed = addRoute(STANDARD_PIPELINE, "retry", "size>=3");
    expect(node(routed, "retry")).toMatchObject({
      routes: [{}, {}, { when: "size>=3", to: "start" }],
    });
    const { pipeline, id } = insertOn(routed, { from: "retry", port: 2 }, "gate");
    expect(node(pipeline, id)).toMatchObject({ next: "start" });
    expect(at(pipeline)[id]![1]).toBeGreaterThan(0);
  });

  test("dropping a route drops the blocks only it reached", () => {
    const routed = addRoute(STANDARD_PIPELINE, "retry", "size>=3");
    const inserted = insertOn(routed, { from: "retry", port: 2 }, "gate");
    const pipeline = removeRoute(inserted.pipeline, "retry", 2);
    expect(ids(pipeline)).not.toContain(inserted.id);
    const withoutRetries = removeRoute(removeRoute(pipeline, "retry", 0), "retry", 0);
    expect(ids(withoutRetries)).toContain("climb");
  });

  test("a wire rejoins a later block, never an earlier one", () => {
    const skip = rejoin(STANDARD_PIPELINE, { from: "climb", port: "next" }, "review-gate");
    expect(Option.map(skip, (pipeline) => node(pipeline, "climb"))).toEqual(
      Option.some({ kind: "gate", id: "climb", step: "climb", next: "review-gate" }),
    );
    expect(rejoin(STANDARD_PIPELINE, { from: "review", port: "exit:approved" }, "author")).toEqual(
      Option.none(),
    );
    expect(
      rejoin(STANDARD_PIPELINE, { from: "review", port: "exit:approved" }, "no-such-block"),
    ).toEqual(Option.none());
  });

  test("a wire can rejoin an acyclic sibling in the same column", () => {
    expect(at(STANDARD_PIPELINE).climb?.[0]).toBe(at(STANDARD_PIPELINE).start?.[0]);
    const joined = rejoin(STANDARD_PIPELINE, { from: "climb", port: "next" }, "start");
    expect(Option.map(joined, (pipeline) => node(pipeline, "climb"))).toEqual(
      Option.some({ kind: "gate", id: "climb", step: "climb", next: "start" }),
    );
    expect(Option.map(joined, (pipeline) => node(pipeline, "review"))).toEqual(
      Option.some(node(STANDARD_PIPELINE, "review")),
    );
  });

  test("a new source starts a belt that joins the first one", () => {
    const { pipeline, id } = addSource(STANDARD_PIPELINE, "label:research");
    expect(node(pipeline, id)).toMatchObject({ filter: "label:research", next: "branch" });
    expect(at(pipeline)[id]).toEqual([0, 2]);
  });

  test("configuring a block keeps its id and wires", () => {
    const pipeline = configure(STANDARD_PIPELINE, "author", {
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
        { name: "done", to: "review-gate" },
        { name: "already-done", to: "review-gate" },
      ],
    });
    const unslotted = configure(pipeline, "author", {
      role: "author",
      model: "cheap",
      slots: undefined,
    });
    expect(node(unslotted, "author")).not.toHaveProperty("slots");
    expect(
      node(configure(STANDARD_PIPELINE, "retry", { route: 1, when: "attempts>=2" }), "retry"),
    ).toMatchObject({
      routes: [{ when: "failed" }, { when: "attempts>=2", to: "climb" }],
    });
  });

  test("a looped file still draws", () => {
    const looped: Pipeline = {
      nodes: STANDARD_PIPELINE.nodes.map((n) =>
        n.id === "land-gate" ? { ...n, next: "author" } : n,
      ),
    };
    expect(beltOf(looped).cells).toHaveLength(looped.nodes.length);
  });
});
