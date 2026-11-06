import { describe, expect, test } from "bun:test";
import { expand } from "./composite.ts";
import {
  type CompositeDefinition,
  type Composites,
  type Pipeline,
  problemsOf,
  type SeatOffers,
  STANDARD_PIPELINES,
  toMermaid,
} from "./pipeline.ts";
import { pipelineFor, projectPipeline } from "./pipeline-file.ts";

const OFFERS: SeatOffers = {
  rungs: [
    { name: "cheap", author: true },
    { name: "strong", author: true },
  ],
  reviewers: ["sharp", "opus"],
};

/** The review-gate + review pair from the standard checkout pipeline, as a definition. */
const reviewLoop: CompositeDefinition = {
  entry: "review-gate",
  exits: [
    { id: "exit-landable", name: "landable" },
    { id: "exit-rework", name: "rework" },
  ],
  params: [
    {
      name: "reviewer",
      default: "reviewers",
      sets: [{ block: "review", field: "model" }],
    },
  ],
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

const COMPOSITES: Composites = { "review-loop": reviewLoop };

/** Standard checkout with the review loop replaced by one or two instances. */
const withReviewInstances = (
  ...instances: ReadonlyArray<{
    readonly id: string;
    readonly prefix: string;
    readonly set?: Record<string, unknown>;
  }>
): Pipeline => {
  const base = STANDARD_PIPELINES.checkout;
  const without = base.nodes.filter((node) => node.id !== "review-gate" && node.id !== "review");
  const first = instances[0];
  if (first === undefined) throw new Error("withReviewInstances needs an instance");
  const second = instances[1];
  const wired = without.map((node) => {
    if (node.id === "author" && node.kind === "agent") {
      return {
        ...node,
        exits: node.exits.map((exit) =>
          exit.to === "review-gate" ? { ...exit, to: first.id } : exit,
        ),
      };
    }
    return node;
  });
  const asInstance = (one: {
    readonly id: string;
    readonly prefix: string;
    readonly set?: Record<string, unknown>;
  }) => ({
    kind: "composite" as const,
    id: one.id,
    of: "review-loop",
    prefix: one.prefix,
    set: one.set ?? {},
    exits: [
      { id: "exit-landable", to: "land-gate" },
      { id: "exit-rework", to: "climb" },
    ],
  });
  const nodes: Array<Pipeline["nodes"][number]> = [...wired, asInstance(first)];
  if (second !== undefined) {
    // A second instance sits on a side path from the land gate so both expand.
    nodes.push(
      asInstance(second),
      { kind: "gate", id: "side-gate", step: "review", next: second.id },
      {
        kind: "source",
        id: "side",
        filter: "label:side",
        next: "side-gate",
      },
    );
    // Wire the second instance's landable exit to land; rework to climb.
    // Reachability: side source → side-gate → second instance → land-gate / climb.
  }
  return { nodes };
};

const INSTRUCTIONS = new Map([
  ["author", "Write the change."],
  ["review", "Read the diff."],
]);

describe("expand", () => {
  test("a second instance of one definition gets prefixed ids", () => {
    const drawn = withReviewInstances(
      { id: "checks", prefix: "checks." },
      { id: "again", prefix: "again." },
    );
    const result = expand(drawn, COMPOSITES);
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    const ids = result.pipeline.nodes.map((node) => node.id);
    expect(ids).toContain("checks.review-gate");
    expect(ids).toContain("checks.review");
    expect(ids).toContain("again.review-gate");
    expect(ids).toContain("again.review");
    expect(ids).not.toContain("checks");
    expect(ids).not.toContain("again");
  });

  test("an instance with wired exits validates", () => {
    const drawn = withReviewInstances({ id: "checks", prefix: "checks." });
    const result = expand(drawn, COMPOSITES);
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    expect(problemsOf(result.pipeline, OFFERS)).toEqual([]);
  });

  test("a parameter's value reaches the field it sets", () => {
    const drawn = withReviewInstances({
      id: "checks",
      prefix: "checks.",
      set: { reviewer: "opus" },
    });
    const result = expand(drawn, COMPOSITES);
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    const review = result.pipeline.nodes.find((node) => node.id === "checks.review");
    expect(review).toEqual(
      expect.objectContaining({ kind: "agent", id: "checks.review", model: "opus" }),
    );
  });

  test("a value the field's schema refuses is a validation problem named on the instance", () => {
    const withSlots: Composites = {
      "review-loop": {
        ...reviewLoop,
        params: [
          {
            name: "cap",
            sets: [{ block: "review", field: "slots" }],
          },
        ],
      },
    };
    const drawn = withReviewInstances({
      id: "checks",
      prefix: "checks.",
      set: { cap: -1 },
    });
    const result = expand(drawn, withSlots);
    expect(result).toEqual({
      _tag: "Failed",
      problems: ["checks: parameter cap sets a value review.slots refuses"],
    });
  });

  test("an unknown definition is a problem of that project only", () => {
    const drawn = withReviewInstances({ id: "checks", prefix: "checks." });
    const result = expand(drawn, {});
    expect(result).toEqual({
      _tag: "Failed",
      problems: ["checks: the definition review-loop is unknown"],
    });
    const other = projectPipeline(
      {
        value: {
          pipelines: {
            broken: drawn,
            fine: STANDARD_PIPELINES.checkout,
          },
          composites: {},
        },
        error: undefined,
      },
      "fine",
      OFFERS,
      INSTRUCTIONS,
    );
    expect(other).toEqual({
      _tag: "Runs",
      pipeline: STANDARD_PIPELINES.checkout,
      drawn: true,
    });
    const stopped = projectPipeline(
      {
        value: { pipelines: { broken: drawn }, composites: {} },
        error: undefined,
      },
      "broken",
      OFFERS,
      INSTRUCTIONS,
    );
    expect(stopped).toEqual({
      _tag: "Stopped",
      problems: ["checks: the definition review-loop is unknown"],
    });
  });

  test("a definition that holds itself is a problem of that project only", () => {
    const looped: Composites = {
      self: {
        entry: "inner",
        exits: [{ id: "out", name: "out" }],
        params: [],
        blocks: [
          {
            kind: "composite",
            id: "inner",
            of: "self",
            prefix: "inner.",
            set: {},
            exits: [{ id: "out", to: "out:out" }],
          },
        ],
      },
    };
    const drawn: Pipeline = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "loop" },
        {
          kind: "composite",
          id: "loop",
          of: "self",
          prefix: "loop.",
          set: {},
          exits: [{ id: "out", to: "done" }],
        },
        { kind: "done", id: "done" },
      ],
    };
    const result = expand(drawn, looped);
    expect(result._tag).toBe("Failed");
    if (result._tag !== "Failed") return;
    expect(result.problems).toContain(
      "loop.inner: the definition self holds itself, directly or through others",
    );
    expect(
      projectPipeline(
        {
          value: {
            pipelines: { broken: drawn, fine: STANDARD_PIPELINES.checkout },
            composites: looped,
          },
          error: undefined,
        },
        "fine",
        OFFERS,
        INSTRUCTIONS,
      )._tag,
    ).toBe("Runs");
  });

  test("pipelineFor expands before the caller reads the pipeline", () => {
    const drawn = withReviewInstances({
      id: "checks",
      prefix: "checks.",
      set: { reviewer: "opus" },
    });
    const { pipeline, problems } = pipelineFor(
      { pipelines: { demo: drawn }, composites: COMPOSITES },
      "demo",
    );
    expect(problems).toEqual([]);
    expect(pipeline.nodes.some((node) => node.kind === "composite")).toBe(false);
    expect(pipeline.nodes.some((node) => node.id === "checks.review")).toBe(true);
  });

  test("Mermaid quotes ids so a prefix's dot is one token", () => {
    const drawn = withReviewInstances({ id: "checks", prefix: "checks." });
    const result = expand(drawn, COMPOSITES);
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    const mermaid = toMermaid(result.pipeline);
    expect(mermaid).toContain('"checks.review"');
    expect(mermaid).toContain('"checks.review-gate"');
  });
});
