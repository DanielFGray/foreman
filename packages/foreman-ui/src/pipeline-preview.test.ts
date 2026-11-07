import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_PIPELINE } from "foreman/pipeline";
import { frameOf, handlePoint, inputPoint, rejoinFrames } from "./pipeline-preview.ts";

describe("rejoinFrames", () => {
  it("marks rejoining branch.next to start with one unreachable problem", () => {
    const frames = rejoinFrames(DEFAULT_PIPELINE, { from: "branch", port: "next" }, {}, "across");
    const toStart = frames.find(
      (frame) => frame.pending?._tag === "Rejoin" && frame.pending.to === "start",
    );
    assert.isDefined(toStart);
    assert.strictEqual(toStart!.problems.length, 1);
    assert.strictEqual(toStart!.problems[0], "no source reaches retry");
  });

  it("keeps the committed block positions so closest can hit the visible target", () => {
    const committed = frameOf(DEFAULT_PIPELINE, [], {}, "across");
    const frames = rejoinFrames(DEFAULT_PIPELINE, { from: "branch", port: "next" }, {}, "across");
    const toStart = frames.find(
      (frame) => frame.pending?._tag === "Rejoin" && frame.pending.to === "start",
    );
    const toClimb = frames.find(
      (frame) => frame.pending?._tag === "Rejoin" && frame.pending.to === "climb",
    );
    assert.isDefined(toStart);
    assert.isDefined(toClimb);
    assert.deepStrictEqual(
      handlePoint(toStart!, { from: "branch", port: "next" }),
      inputPoint(committed.drawing, "start"),
    );
    assert.deepStrictEqual(
      handlePoint(toClimb!, { from: "branch", port: "next" }),
      inputPoint(committed.drawing, "climb"),
    );
  });
});
