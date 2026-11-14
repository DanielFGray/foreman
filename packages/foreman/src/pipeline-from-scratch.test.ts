import { describe, expect, test } from "bun:test";
import {
  type Drawing,
  EMPTY_PIPELINE,
  type Facts,
  place,
  problemsOf,
  type SeatOffers,
  STANDARD_PIPELINES,
} from "./pipeline.ts";
import { applyChange, type PipelineChange } from "./pipeline-edit.ts";
import { pipelineOf } from "./pipeline-fixture.ts";

const OFFERS: SeatOffers = {
  rungs: [{ name: "cheap", author: true }],
  reviewers: ["sharp"],
};

/**
 * The standard checkout pipeline, built from nothing the way an operator
 * builds one: place each block by name, set it, then wire it.
 */
const CHECKOUT_BUILD: ReadonlyArray<PipelineChange> = [
  { _tag: "Place", kind: "source", id: "queue" },
  { _tag: "Place", kind: "branch", id: "branch" },
  { _tag: "Rejoin", wire: { from: "queue", port: "next" }, to: "branch" },
  { _tag: "Place", kind: "router", id: "retry" },
  { _tag: "Rejoin", wire: { from: "branch", port: "next" }, to: "retry" },
  { _tag: "Place", kind: "gate", id: "start" },
  { _tag: "Place", kind: "gate", id: "climb" },
  { _tag: "Configure", id: "climb", setting: { kind: "gate", step: "climb" } },
  { _tag: "Rejoin", wire: { from: "retry", port: "else" }, to: "start" },
  { _tag: "AddRoute", router: "retry", when: "failed" },
  { _tag: "AddRoute", router: "retry", when: "attempts>=1" },
  { _tag: "Rejoin", wire: { from: "retry", port: 0 }, to: "climb" },
  { _tag: "Rejoin", wire: { from: "retry", port: 1 }, to: "climb" },
  { _tag: "Place", kind: "agent", id: "author" },
  { _tag: "Rejoin", wire: { from: "start", port: "next" }, to: "author" },
  { _tag: "Rejoin", wire: { from: "climb", port: "next" }, to: "author" },
  { _tag: "Place", kind: "gate", id: "review-gate" },
  { _tag: "Configure", id: "review-gate", setting: { kind: "gate", step: "review" } },
  { _tag: "Rejoin", wire: { from: "author", port: "exit:done" }, to: "review-gate" },
  { _tag: "Rejoin", wire: { from: "author", port: "exit:already-done" }, to: "review-gate" },
  { _tag: "Place", kind: "agent", id: "review" },
  {
    _tag: "Configure",
    id: "review",
    setting: { kind: "agent", role: "review", model: "reviewers" },
  },
  { _tag: "RenameExit", id: "review", name: "done", to: "approved" },
  { _tag: "RenameExit", id: "review", name: "already-done", to: "returned" },
  { _tag: "SetEmpty", id: "review", name: "returned", empty: undefined },
  { _tag: "ChargeExit", id: "review", name: "returned", fails: "author" },
  { _tag: "Rejoin", wire: { from: "review-gate", port: "next" }, to: "review" },
  { _tag: "Rejoin", wire: { from: "review", port: "exit:returned" }, to: "climb" },
  { _tag: "Place", kind: "gate", id: "land-gate" },
  { _tag: "Configure", id: "land-gate", setting: { kind: "gate", step: "land" } },
  { _tag: "Rejoin", wire: { from: "review", port: "exit:approved" }, to: "land-gate" },
  { _tag: "Place", kind: "land", id: "land" },
  { _tag: "Configure", id: "land", setting: { kind: "land", how: "merge", onto: undefined } },
  { _tag: "Rejoin", wire: { from: "land-gate", port: "next" }, to: "land" },
];

/** Each drawing the build passes through, the empty one first. */
const stagesOf = (changes: ReadonlyArray<PipelineChange>): ReadonlyArray<Drawing> =>
  changes.reduce<ReadonlyArray<Drawing>>(
    (stages, change) => {
      const result = applyChange(stages.at(-1)!, change);
      if (result._tag === "Refused") throw new Error(`${change._tag}: ${result.reason}`);
      return [...stages, result.pipeline];
    },
    [EMPTY_PIPELINE],
  );

/** A drawing with each exit's id left out: edits give a new exit a random one. */
const withoutExitIds = (drawing: Drawing) => ({
  nodes: drawing.nodes.map((node) =>
    node.kind === "agent" || node.kind === "check"
      ? { ...node, exits: node.exits.map(({ id: _, ...exit }) => exit) }
      : node,
  ),
});

const open: Facts = {
  status: "open",
  priority: 2,
  epic: undefined,
  size: 1,
  labels: new Set(),
  failedBy: new Set(),
  attempts: 0,
  tip: "c1",
  running: undefined,
  named: [],
  exit: undefined,
  exitNode: undefined,
};

describe("a pipeline built from nothing", () => {
  const stages = stagesOf(CHECKOUT_BUILD);

  test("edits alone build the standard checkout pipeline, all but its exit ids", () => {
    expect(withoutExitIds(stages.at(-1)!)).toEqual(withoutExitIds(STANDARD_PIPELINES.checkout));
  });

  test("every drawing on the way is valid: a loose end idles a block, it is no problem", () => {
    for (const stage of stages) expect(problemsOf(pipelineOf(stage), OFFERS)).toEqual([]);
  });

  test("an open task waits before the first idle block, then reaches the author once it is wired", () => {
    const placedAt = (stage: Drawing) => place(pipelineOf(stage), open);
    expect(placedAt(stages[1]!)).toEqual({ _tag: "Idle", node: "queue", loose: ["next"] });
    const wiredToAuthor = stages.findIndex((stage) =>
      stage.nodes.some(
        (node) => node.kind === "gate" && node.id === "start" && node.next === "author",
      ),
    );
    expect(placedAt(stages[wiredToAuthor]!)).toMatchObject({
      _tag: "Idle",
      node: "author",
      loose: ["exit done", "exit already-done"],
    });
    expect(placedAt(stages.at(-1)!)).toMatchObject({ _tag: "At", node: { id: "author" } });
  });
});

describe("edits that name what the drawing lacks are refused", () => {
  const refusal = (drawing: Drawing, change: PipelineChange) => applyChange(drawing, change)._tag;

  test("an insert on a way out no block has", () => {
    expect(
      refusal(EMPTY_PIPELINE, {
        _tag: "InsertOn",
        wire: { from: "queue", port: "next" },
        kind: "gate",
      }),
    ).toBe("Refused");
  });

  test("a removal of a block the drawing lacks", () => {
    expect(refusal(EMPTY_PIPELINE, { _tag: "Remove", id: "author" })).toBe("Refused");
  });

  test("a placed block whose id is taken, empty, or holds a slash", () => {
    const one = stagesOf([{ _tag: "Place", kind: "source", id: "queue" }]).at(-1)!;
    for (const id of ["queue", "", "a/b"]) {
      expect(refusal(one, { _tag: "Place", kind: "gate", id })).toBe("Refused");
    }
  });
});

describe("a new source in an empty drawing", () => {
  test("has a loose way on", () => {
    const result = applyChange(EMPTY_PIPELINE, { _tag: "AddSource", filter: "" });
    expect(result._tag === "Changed" && result.pipeline.nodes).toMatchObject([
      { kind: "source", filter: "" },
    ]);
    expect(
      result._tag === "Changed" && result.pipeline.nodes[0]?.kind === "source"
        ? result.pipeline.nodes[0].next
        : "wired",
    ).toBeUndefined();
  });
});
