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

const RUNGS = ["cheap", "strong"];
const ids = (pipeline: Pipeline) => pipeline.nodes.map((node) => node.id);
const node = (pipeline: Pipeline, id: string) => pipeline.nodes.find((n) => n.id === id);
const at = (pipeline: Pipeline) =>
  Object.fromEntries(beltOf(pipeline).cells.map((cell) => [cell.node.id, [cell.column, cell.row]]));

describe("the standard pipeline as belts", () => {
  test("runs one belt, with the retry branch on a row of its own", () => {
    expect(at(STANDARD_PIPELINE)).toEqual({
      queue: [0, 0],
      retry: [1, 0],
      climb: [2, 1],
      start: [2, 0],
      author: [3, 0],
      "review-gate": [4, 0],
      review: [5, 0],
      "land-gate": [6, 0],
      land: [7, 0],
    });
    const belt = beltOf(STANDARD_PIPELINE);
    expect([belt.columns, belt.rows]).toEqual([8, 2]);
    expect(belt.wires).toHaveLength(10);
  });
});

describe("belt edits", () => {
  test("a block put on a wire runs on to where the wire went", () => {
    const { pipeline, id } = insertOn(STANDARD_PIPELINE, { from: "review", port: "next" }, "agent");
    expect(node(pipeline, "review")).toMatchObject({ next: id });
    expect(node(pipeline, id)).toMatchObject({ kind: "agent", next: "land-gate" });
    // A second agent between review and land needs its own gate, and a review after it.
    expect(problemsOf(pipeline, RUNGS)).toEqual([
      `a route from ${id} reaches land with no review after it`,
      `a route from review reaches ${id} through no gate`,
    ]);
  });

  test("a check put on a wire names no command until the operator sets one", () => {
    const { pipeline, id } = insertOn(STANDARD_PIPELINE, { from: "author", port: "next" }, "check");
    expect(node(pipeline, id)).toEqual({ kind: "check", id, command: "", next: "review-gate" });
    expect(problemsOf(pipeline, RUNGS)).toEqual([
      `${id}: a check runs a command, and it names none`,
    ]);
    const named = configure(pipeline, id, { command: "bun run lint" });
    expect(node(named, id)).toMatchObject({ command: "bun run lint", next: "review-gate" });
    expect(problemsOf(named, RUNGS)).toEqual([`a route from author reaches ${id} through no gate`]);
  });

  test("new blocks never reuse an id", () => {
    const first = insertOn(STANDARD_PIPELINE, { from: "queue", port: "next" }, "gate");
    const second = insertOn(first.pipeline, { from: "queue", port: "next" }, "gate");
    expect(new Set(ids(second.pipeline)).size).toBe(ids(second.pipeline).length);
  });

  test("taking a block out joins the wires around it", () => {
    const pipeline = remove(STANDARD_PIPELINE, "retry");
    expect(node(pipeline, "queue")).toMatchObject({ next: "start" });
    // climb was reached only through the router's route, so it goes too.
    expect(ids(pipeline)).not.toContain("climb");
    expect(problemsOf(pipeline, RUNGS)).toEqual([]);
  });

  test("a land or a park stays, and swaps with the other", () => {
    expect(remove(STANDARD_PIPELINE, "land")).toBe(STANDARD_PIPELINE);
    expect(node(swapEnd(STANDARD_PIPELINE, "land"), "land")).toEqual({ kind: "park", id: "land" });
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
    const pipeline = removeRoute(removeRoute(STANDARD_PIPELINE, "retry", 0), "retry", 0);
    expect(ids(pipeline)).not.toContain("climb");
  });

  test("a wire rejoins a later block, never an earlier one", () => {
    const skip = rejoin(STANDARD_PIPELINE, { from: "climb", port: "next" }, "review-gate");
    expect(Option.map(skip, (pipeline) => node(pipeline, "climb"))).toEqual(
      Option.some({ kind: "gate", id: "climb", step: "climb", next: "review-gate" }),
    );
    expect(rejoin(STANDARD_PIPELINE, { from: "review", port: "next" }, "author")).toEqual(
      Option.none(),
    );
    expect(rejoin(STANDARD_PIPELINE, { from: "review", port: "next" }, "no-such-block")).toEqual(
      Option.none(),
    );
  });

  test("a new source starts a belt that joins the first one", () => {
    const { pipeline, id } = addSource(STANDARD_PIPELINE, "label:research");
    expect(node(pipeline, id)).toMatchObject({ filter: "label:research", next: "retry" });
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
      next: "review-gate",
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
