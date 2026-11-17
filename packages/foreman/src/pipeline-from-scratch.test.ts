import { describe, expect, test } from "bun:test";
import {
  type Drawing,
  EMPTY_PIPELINE,
  type Facts,
  looseEnds,
  place,
  problemsOf,
  type SeatOffers,
  STANDARD_PIPELINES,
  WORKSPACE_CHOICES,
} from "./pipeline.ts";
import { applyChange, type PipelineChange } from "./pipeline-edit.ts";
import { CHECKOUT_STAGES, pipelineOf, stagesOf } from "./pipeline-fixture.ts";
import { writtenDrawingOf } from "./pipeline-layout.ts";

const OFFERS: SeatOffers = {
  rungs: [{ name: "cheap", author: true }],
  reviewers: ["sharp"],
};

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
  const stages = CHECKOUT_STAGES;

  test("edits alone build the standard checkout pipeline, all but its exit ids", () => {
    expect(withoutExitIds(stages.at(-1)!)).toEqual(withoutExitIds(STANDARD_PIPELINES.checkout));
  });

  test("every drawing on the way is valid: a loose end idles a block, it is no problem", () => {
    for (const stage of stages) expect(problemsOf(pipelineOf(stage), OFFERS)).toEqual([]);
  });

  test("every drawing on the way lays out every block in a finite size, and a stub with no end for each loose end", () => {
    for (const stage of stages) {
      for (const flow of ["across", "down"] as const) {
        const drawn = writtenDrawingOf(stage, {}, flow);
        expect([drawn.width, drawn.height].every(Number.isFinite)).toBe(true);
        expect(drawn.blocks.map((block) => block.id).sort()).toEqual(
          stage.nodes.map((node) => node.id).sort(),
        );
        for (const node of pipelineOf(stage).nodes) {
          const stubs = drawn.wires.filter(
            (wire) => wire.from === node.id && wire.to === undefined,
          );
          expect(stubs.length).toBe(looseEnds(node).length);
        }
      }
    }
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

describe("starting an empty drawing from a standard pipeline", () => {
  test.each(WORKSPACE_CHOICES)("%s draws exactly the standard pipeline", (standard) => {
    const result = applyChange(EMPTY_PIPELINE, { _tag: "StartFrom", standard });
    expect(result).toEqual({
      _tag: "Changed",
      pipeline: STANDARD_PIPELINES[standard],
      added: undefined,
      composites: {},
    });
  });

  test("is refused on a drawing with a block, which is left as it was", () => {
    const one = stagesOf([{ _tag: "Place", kind: "source", id: "queue" }]).at(-1)!;
    expect(applyChange(one, { _tag: "StartFrom", standard: "checkout" })._tag).toBe("Refused");
  });
});
