import { assert, describe, it } from "@effect/vitest";
import { makeComposite } from "foreman/pipeline-belt";
import { STANDARD_PIPELINES, type Drawing, type SeatOffers } from "foreman/pipeline";
import { writtenDrawingOf } from "foreman/pipeline-layout";
import { Option } from "effect";
import {
  frameAfter,
  frameOf,
  handlePoint,
  inputPoint,
  rejoinFrames,
  type CheckInputs,
  type EditorFrame,
  type ServerView,
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
  return wire.to;
};

describe("inputPoint", () => {
  for (const flow of ["across", "down"] as const) {
    it(`is where the layout ends each wire into a block, laid out ${flow}`, () => {
      const drawing = writtenDrawingOf(STANDARD_PIPELINES.checkout, {}, flow);
      const intoBlocks = drawing.wires.filter((wire) => wire.to !== "queue");
      assert.isAbove(intoBlocks.length, 0);
      for (const wire of intoBlocks) {
        assert.deepStrictEqual(
          inputPoint(drawing, wire.to, flow),
          Option.fromNullishOr(wire.points.at(-1)),
          `${wire.from} → ${wire.to}`,
        );
      }
    });
  }
});

describe("rejoinFrames", () => {
  it("marks rejoining branch.next to start with one unreachable problem", () => {
    const frames = rejoinFrames(STANDARD_PIPELINES.checkout, BRANCH_NEXT, CHECKS, "across");
    const toStart = frames.find((frame) => rejoinsTo(frame, "start"));
    assert.isDefined(toStart);
    assert.strictEqual(toStart.problems.length, 1);
    assert.strictEqual(toStart.problems[0], "no source reaches retry");
  });

  it("keeps the committed block positions so closest can hit the visible target", () => {
    const committed = frameOf(STANDARD_PIPELINES.checkout, [], CHECKS, "across");
    const frames = rejoinFrames(STANDARD_PIPELINES.checkout, BRANCH_NEXT, CHECKS, "across");
    const toStart = frames.find((frame) => rejoinsTo(frame, "start"));
    const toClimb = frames.find((frame) => rejoinsTo(frame, "climb"));
    assert.isDefined(toStart);
    assert.isDefined(toClimb);
    assert.deepStrictEqual(
      handlePoint(toStart, BRANCH_NEXT),
      inputPoint(committed.drawing, "start", "across"),
    );
    assert.deepStrictEqual(
      handlePoint(toClimb, BRANCH_NEXT),
      inputPoint(committed.drawing, "climb", "across"),
    );
  });

  it("checks with the author's configured rung, so the unchanged target has no problem", () => {
    const configured: Drawing = {
      nodes: STANDARD_PIPELINES.checkout.nodes.map((node) =>
        node.kind === "agent" && node.role === "author" ? { ...node, model: "cheap" } : node,
      ),
    };
    const frames = rejoinFrames(configured, BRANCH_NEXT, CHECKS, "across");
    const unchanged = frames.find((frame) => rejoinsTo(frame, currentTarget(configured)));
    assert.isDefined(unchanged);
    assert.deepStrictEqual(unchanged.problems, []);
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
    const unchanged = frames.find((frame) => rejoinsTo(frame, currentTarget(made.pipeline)));
    assert.isDefined(unchanged);
    assert.deepStrictEqual(unchanged.problems, []);
  });
});

/** Whether a drag candidate rejoins its wire to `to`. */
const rejoinsTo = (frame: EditorFrame, to: string): boolean =>
  Option.exists(frame.pending, (change) => change._tag === "Rejoin" && change.to === to);

/** Where `id`'s next exit leads in a drawing. */
const nextOf = (drawing: Drawing, id: string): Option.Option<string> =>
  Option.fromNullishOr(drawing.nodes.find((one) => one.id === id)).pipe(
    Option.flatMap((node) => ("next" in node ? Option.some(node.next) : Option.none())),
  );

describe("frameAfter", () => {
  const view: ServerView = {
    pipeline: STANDARD_PIPELINES.checkout,
    problems: ["as the server reports it"],
    drawing: writtenDrawingOf(STANDARD_PIPELINES.checkout, {}, "across"),
    draft: null,
    ...CHECKS,
  };
  const startToClimb = {
    _tag: "Rejoin",
    wire: { from: "start", port: "next" },
    to: "climb",
  } as const;

  it("draws the server's view and its problems when no edit waits", () => {
    const frame = frameAfter(view, [], "across");
    assert.deepStrictEqual(frame.pipeline, STANDARD_PIPELINES.checkout);
    assert.deepStrictEqual(frame.problems, ["as the server reports it"]);
  });

  it("replays the unanswered edits over the server's view, and checks the result itself", () => {
    const frame = frameAfter(view, [startToClimb], "across");
    assert.deepStrictEqual(nextOf(frame.pipeline, "start"), Option.some("climb"));
    assert.deepStrictEqual(frame.problems, []);
  });

  it("leaves out an edit the view no longer takes, and replays the rest", () => {
    const gone = { _tag: "Rejoin", wire: { from: "gone", port: "next" }, to: "start" } as const;
    const frame = frameAfter(view, [gone, startToClimb], "across");
    assert.deepStrictEqual(nextOf(frame.pipeline, "start"), Option.some("climb"));
  });
});
