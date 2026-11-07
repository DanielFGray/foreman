import { assert, describe, it } from "@effect/vitest";
import { makeComposite } from "foreman/pipeline-belt";
import {
  DEFAULT_PIPELINE,
  STANDARD_PIPELINES,
  type Drawing,
  type SeatOffers,
} from "foreman/pipeline";
import { writtenDrawingOf } from "foreman/pipeline-layout";
import {
  frameOf,
  handlePoint,
  inputPoint,
  rejoinFrames,
  type CheckInputs,
} from "./pipeline-preview.ts";

const LADDER_OFFERS: SeatOffers = { rungs: [{ name: "cheap", author: true }], reviewers: [] };
const CHECKS: CheckInputs = { composites: {}, offers: LADDER_OFFERS };
const BRANCH_NEXT = { from: "branch", port: "next" } as const;

/** The block `branch.next` leads to in the drawing as written: the candidate that changes nothing. */
const currentTarget = (drawing: Drawing): string => {
  const wire = writtenDrawingOf(drawing, {}, "across").wires.find(
    (one) => one.from === BRANCH_NEXT.from && one.port === BRANCH_NEXT.port,
  );
  assert.isDefined(wire);
  return wire!.to;
};

describe("rejoinFrames", () => {
  it("marks rejoining branch.next to start with one unreachable problem", () => {
    const frames = rejoinFrames(DEFAULT_PIPELINE, BRANCH_NEXT, CHECKS, "across");
    const toStart = frames.find(
      (frame) => frame.pending?._tag === "Rejoin" && frame.pending.to === "start",
    );
    assert.isDefined(toStart);
    assert.strictEqual(toStart!.problems.length, 1);
    assert.strictEqual(toStart!.problems[0], "no source reaches retry");
  });

  it("keeps the committed block positions so closest can hit the visible target", () => {
    const committed = frameOf(DEFAULT_PIPELINE, [], CHECKS, "across");
    const frames = rejoinFrames(DEFAULT_PIPELINE, BRANCH_NEXT, CHECKS, "across");
    const toStart = frames.find(
      (frame) => frame.pending?._tag === "Rejoin" && frame.pending.to === "start",
    );
    const toClimb = frames.find(
      (frame) => frame.pending?._tag === "Rejoin" && frame.pending.to === "climb",
    );
    assert.isDefined(toStart);
    assert.isDefined(toClimb);
    assert.deepStrictEqual(
      handlePoint(toStart!, BRANCH_NEXT),
      inputPoint(committed.drawing, "start"),
    );
    assert.deepStrictEqual(
      handlePoint(toClimb!, BRANCH_NEXT),
      inputPoint(committed.drawing, "climb"),
    );
  });

  it("checks with the author's configured rung, so the unchanged target has no problem", () => {
    const configured: Drawing = {
      nodes: DEFAULT_PIPELINE.nodes.map((node) =>
        node.kind === "agent" && node.role === "author" ? { ...node, model: "cheap" } : node,
      ),
    };
    const frames = rejoinFrames(configured, BRANCH_NEXT, CHECKS, "across");
    const unchanged = frames.find(
      (frame) => frame.pending?._tag === "Rejoin" && frame.pending.to === currentTarget(configured),
    );
    assert.isDefined(unchanged);
    assert.deepStrictEqual(unchanged!.problems, []);
  });

  it("checks a composite instance with the definitions the server holds, so its unchanged target has no problem", () => {
    const made = makeComposite(
      STANDARD_PIPELINES.checkout,
      ["review-gate", "review"],
      "review-loop",
    );
    assert.strictEqual(made._tag, "Made");
    if (made._tag !== "Made") return;
    const checks: CheckInputs = {
      composites: { "review-loop": made.definition },
      offers: { rungs: [], reviewers: ["codex"] },
    };
    const frames = rejoinFrames(made.pipeline, BRANCH_NEXT, checks, "across");
    const unchanged = frames.find(
      (frame) =>
        frame.pending?._tag === "Rejoin" && frame.pending.to === currentTarget(made.pipeline),
    );
    assert.isDefined(unchanged);
    assert.deepStrictEqual(unchanged!.problems, []);
  });
});
