import { describe, expect, test } from "bun:test";
import { coversOf, expand } from "./composite.ts";
import {
  type CompositeDefinition,
  type Composites,
  type Drawing,
  type Facts,
  matches,
  place,
  type Pipeline,
  problemsOf,
  type SeatOffers,
  STANDARD_PIPELINES,
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
  entries: [{ id: "entry-review-gate", name: "review-gate", block: "review-gate" }],
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

const INSTRUCTIONS = new Map([
  ["author", "Write the change."],
  ["review", "Read the diff."],
]);

/** Standard checkout with the review loop replaced by one or two instances. */
const withReviewInstances = (
  ...instances: ReadonlyArray<{
    readonly id: string;
    readonly prefix: string;
    readonly set?: Record<string, string | number>;
  }>
): Drawing => {
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
    readonly set?: Record<string, string | number>;
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
  const nodes: Array<Drawing["nodes"][number]> = [...wired, asInstance(first)];
  if (second !== undefined) {
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
  }
  return { nodes };
};

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

  test("an instance with prefix empty keeps its blocks' original ids", () => {
    const drawn = withReviewInstances({ id: "checks", prefix: "" });
    const result = expand(drawn, COMPOSITES);
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    const ids = result.pipeline.nodes.map((node) => node.id);
    expect(ids).toContain("review-gate");
    expect(ids).toContain("review");
    expect(ids).not.toContain("checks");
  });

  test("a wire into the instance reaches prefix plus entry", () => {
    const drawn = withReviewInstances({ id: "checks", prefix: "checks." });
    const result = expand(drawn, COMPOSITES);
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    const author = result.pipeline.nodes.find((node) => node.id === "author");
    expect(author?.kind).toBe("agent");
    if (author?.kind !== "agent") return;
    expect(author.exits.map((exit) => exit.to)).toEqual([
      "checks.review-gate",
      "checks.review-gate",
    ]);
  });

  test("a nested instance expands with joined prefixes", () => {
    const inner: CompositeDefinition = {
      entries: [{ id: "entry-inner-gate", name: "inner-gate", block: "inner-gate" }],
      exits: [{ id: "out", name: "out" }],
      params: [],
      blocks: [
        { kind: "gate", id: "inner-gate", step: "review", next: "inner-agent" },
        {
          kind: "agent",
          id: "inner-agent",
          role: "review",
          model: "reviewers",
          exits: [{ id: "ok", name: "ok", to: "out:out" }],
        },
      ],
    };
    const outer: CompositeDefinition = {
      entries: [{ id: "entry-wrap", name: "wrap", block: "wrap" }],
      exits: [{ id: "out", name: "out" }],
      params: [],
      blocks: [
        {
          kind: "composite",
          id: "wrap",
          of: "inner",
          prefix: "wrap.",
          set: {},
          exits: [{ id: "out", to: "out:out" }],
        },
      ],
    };
    const drawn: Drawing = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "outer" },
        {
          kind: "composite",
          id: "outer",
          of: "outer",
          prefix: "outer.",
          set: {},
          exits: [{ id: "out", to: "done" }],
        },
        { kind: "done", id: "done" },
      ],
    };
    const result = expand(drawn, { inner, outer });
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    const ids = result.pipeline.nodes.map((node) => node.id);
    expect(ids).toContain("outer.wrap.inner-gate");
    expect(ids).toContain("outer.wrap.inner-agent");
    const source = result.pipeline.nodes.find((node) => node.id === "queue");
    expect(source).toEqual(
      expect.objectContaining({ kind: "source", next: "outer.wrap.inner-gate" }),
    );
  });

  test("two instances whose expansions share an id give the duplicate-block problem", () => {
    const drawn = withReviewInstances({ id: "first", prefix: "" }, { id: "second", prefix: "" });
    const result = expand(drawn, COMPOSITES);
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    expect(problemsOf(result.pipeline, OFFERS)).toContain("two blocks are named review-gate");
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
    const fineReading = pipelineFor(
      {
        pipelines: {
          broken: drawn,
          fine: STANDARD_PIPELINES.checkout,
        },
        composites: {},
      },
      "fine",
    );
    expect(projectPipeline(fineReading, undefined, OFFERS, INSTRUCTIONS)).toEqual({
      _tag: "Runs",
      pipeline: STANDARD_PIPELINES.checkout,
      drawn: true,
    });
    const brokenReading = pipelineFor({ pipelines: { broken: drawn }, composites: {} }, "broken");
    expect(projectPipeline(brokenReading, undefined, OFFERS, INSTRUCTIONS)).toEqual({
      _tag: "Stopped",
      problems: ["checks: the definition review-loop is unknown"],
    });
  });

  test("a definition that holds itself is a problem of that project only", () => {
    const looped: Composites = {
      self: {
        entries: [{ id: "entry-inner", name: "inner", block: "inner" }],
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
    const drawn: Drawing = {
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
        pipelineFor(
          {
            pipelines: { broken: drawn, fine: STANDARD_PIPELINES.checkout },
            composites: looped,
          },
          "fine",
        ),
        undefined,
        OFFERS,
        INSTRUCTIONS,
      )._tag,
    ).toBe("Runs");
  });

  test("pipelineFor returns a tagged expansion, never an unexpanded pipeline with problems", () => {
    const drawn = withReviewInstances({
      id: "checks",
      prefix: "checks.",
      set: { reviewer: "opus" },
    });
    const reading = pipelineFor({ pipelines: { demo: drawn }, composites: COMPOSITES }, "demo");
    expect(reading._tag).toBe("Expanded");
    if (reading._tag !== "Expanded") return;
    expect(reading.pipeline.nodes.map((node) => node.kind)).not.toContain("composite");
    expect(reading.pipeline.nodes.some((node) => node.id === "checks.review")).toBe(true);

    const failed = pipelineFor({ pipelines: { demo: drawn }, composites: {} }, "demo");
    expect(failed).toEqual({
      _tag: "Failed",
      drawn: true,
      problems: ["checks: the definition review-loop is unknown"],
    });
  });

  test("place on an expansion puts a task whose last exit was at an inner block where that exit leads", () => {
    const drawn = withReviewInstances({ id: "checks", prefix: "checks." });
    const result = expand(drawn, COMPOSITES);
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    const facts: Facts = {
      status: "in_progress",
      priority: 2,
      epic: undefined,
      size: 1,
      labels: new Set(),
      failedBy: new Set(),
      attempts: 0,
      tip: "c1",
      running: undefined,
      named: [
        { node: "author", id: "done", name: "done", commit: "c0" },
        { node: "checks.review", id: "approved", name: "approved", commit: "c1" },
      ],
      exit: "approved",
      exitNode: "checks.review",
    };
    const placement = place(result.pipeline, facts);
    expect(placement).toEqual(
      expect.objectContaining({
        _tag: "At",
        node: expect.objectContaining({ kind: "land", id: "land" }),
      }),
    );
  });
});

describe("expand: ids and entries", () => {
  // The reviewer's reproducer: with empty prefixes the instance id `wrap`
  // equals the id of the entry block it expands to.
  test("an instance whose entry block shares its id, through nested empty prefixes, terminates", () => {
    const inner: CompositeDefinition = {
      entries: [{ id: "entry-wrap", name: "wrap", block: "wrap" }],
      exits: [],
      params: [],
      blocks: [{ kind: "done", id: "wrap" }],
    };
    const outer: CompositeDefinition = {
      entries: [{ id: "entry-wrap", name: "wrap", block: "wrap" }],
      exits: [],
      params: [],
      blocks: [{ kind: "composite", id: "wrap", of: "inner", prefix: "", set: {}, exits: [] }],
    };
    const drawn: Drawing = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "top" },
        { kind: "composite", id: "top", of: "outer", prefix: "", set: {}, exits: [] },
      ],
    };
    const result = expand(drawn, { inner, outer });
    expect(result).toEqual({
      _tag: "Expanded",
      pipeline: {
        nodes: [
          { kind: "source", id: "queue", filter: "", next: "wrap" },
          { kind: "done", id: "wrap" },
        ],
      },
    });
  });

  // An exit wired to the parent's `foo` must stay there, even though the
  // definition holds an instance whose id is `foo` with prefix "".
  test("an exit wire to a parent block named like a nested instance is not rewritten", () => {
    const leaf: CompositeDefinition = {
      entries: [{ id: "entry-end", name: "end", block: "end" }],
      exits: [{ id: "x", name: "x" }],
      params: [],
      blocks: [{ kind: "gate", id: "end", step: "review", next: "out:x" }],
    };
    const wrapper: CompositeDefinition = {
      entries: [{ id: "entry-foo", name: "foo", block: "foo" }],
      exits: [{ id: "e", name: "e" }],
      params: [],
      blocks: [
        {
          kind: "composite",
          id: "foo",
          of: "leaf",
          prefix: "",
          set: {},
          exits: [{ id: "x", to: "out:e" }],
        },
      ],
    };
    const drawn: Drawing = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "wrapper" },
        {
          kind: "composite",
          id: "wrapper",
          of: "wrapper",
          prefix: "",
          set: {},
          exits: [{ id: "e", to: "foo" }],
        },
        { kind: "done", id: "foo" },
      ],
    };
    const result = expand(drawn, { leaf, wrapper });
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    expect(result.pipeline.nodes).toEqual([
      { kind: "source", id: "queue", filter: "", next: "end" },
      { kind: "gate", id: "end", step: "review", next: "foo" },
      { kind: "done", id: "foo" },
    ]);
  });

  test("two drawn nodes named alike are a failure naming the id, not a silent choice", () => {
    const definition: CompositeDefinition = {
      entries: [{ id: "entry-end", name: "end", block: "end" }],
      exits: [],
      params: [],
      blocks: [{ kind: "done", id: "end" }],
    };
    const drawn: Drawing = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "x" },
        { kind: "composite", id: "x", of: "done-only", prefix: "a.", set: {}, exits: [] },
        { kind: "composite", id: "x", of: "done-only", prefix: "b.", set: {}, exits: [] },
      ],
    };
    expect(expand(drawn, { "done-only": definition })).toEqual({
      _tag: "Failed",
      problems: ["two blocks are named x"],
    });
  });

  test("two instances with prefix empty of one definition give the duplicate-block problem", () => {
    const definition: CompositeDefinition = {
      entries: [{ id: "entry-end", name: "end", block: "end" }],
      exits: [],
      params: [],
      blocks: [{ kind: "done", id: "end" }],
    };
    const drawn: Drawing = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "a" },
        { kind: "composite", id: "a", of: "done-only", prefix: "", set: {}, exits: [] },
        { kind: "composite", id: "b", of: "done-only", prefix: "", set: {}, exits: [] },
      ],
    };
    const result = expand(drawn, { "done-only": definition });
    expect(result._tag).toBe("Expanded");
    if (result._tag !== "Expanded") return;
    expect(problemsOf(result.pipeline, OFFERS)).toContain("two blocks are named end");
  });

  test("coversOf names the expanded ids each instance draws as one block", () => {
    const drawn = withReviewInstances({ id: "checks", prefix: "checks." });
    const covers = coversOf(drawn, COMPOSITES);
    expect([...covers.keys()]).toEqual(["checks"]);
    expect(covers.get("checks")).toEqual(["checks.review-gate", "checks.review"]);
  });

  test("coversOf with an empty prefix keeps the definition's own block ids", () => {
    const drawn: Drawing = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "loop" },
        {
          kind: "composite",
          id: "loop",
          of: "review-loop",
          prefix: "",
          set: {},
          exits: [
            { id: "exit-landable", to: "done" },
            { id: "exit-rework", to: "queue" },
          ],
        },
        { kind: "done", id: "done" },
      ],
    };
    expect(coversOf(drawn, COMPOSITES).get("loop")).toEqual(["review-gate", "review"]);
  });
});

describe("filters that name a block", () => {
  const returnedAt = (node: string) => ({ node, id: "returned", name: "returned", commit: "c1" });
  const factsNamed = (named: Facts["named"]): Facts => ({
    status: "in_progress",
    priority: 2,
    epic: undefined,
    size: 1,
    labels: new Set(),
    failedBy: new Set(),
    attempts: 0,
    tip: "c1",
    running: undefined,
    named,
    exit: named.at(-1)?.name,
    exitNode: named.at(-1)?.node,
  });

  /**
   * The review loop, its reviewer named `reviewId`, with a router that gives up
   * once that reviewer has returned twice.
   */
  const cappedAround = (reviewId: string): CompositeDefinition => ({
    ...reviewLoop,
    blocks: [
      ...reviewLoop.blocks.map((block) => {
        if (block.kind === "gate") return { ...block, next: reviewId };
        if (block.kind !== "agent") return block;
        return {
          ...block,
          id: reviewId,
          exits: block.exits.map((exit) =>
            exit.id === "returned" ? { id: exit.id, name: exit.name, to: "cap" } : exit,
          ),
        };
      }),
      {
        kind: "router",
        id: "cap",
        routes: [{ when: `exits:${reviewId}/returned>=2`, to: "out:exit-landable" }],
        else: "review-gate",
      },
    ],
  });

  const expandTwo = (reviewId: string): Pipeline => {
    const result = expand(
      withReviewInstances({ id: "checks", prefix: "checks." }, { id: "again", prefix: "again." }),
      { "review-loop": cappedAround(reviewId) },
    );
    expect(result._tag).toBe("Expanded");
    return result._tag === "Expanded" ? result.pipeline : { nodes: [] };
  };

  const whenOf = (pipeline: Pipeline, id: string): string => {
    const node = pipeline.nodes.find((one) => one.id === id);
    return node?.kind === "router" ? (node.routes[0]?.when ?? "") : "";
  };

  const withWhen = (pipeline: Pipeline, id: string, when: string): Pipeline => ({
    nodes: pipeline.nodes.map((node) =>
      node.id === id && node.kind === "router"
        ? {
            ...node,
            routes: node.routes.map((route, at) => (at === 0 ? { ...route, when } : route)),
          }
        : node,
    ),
  });

  const filterOrLoopProblems = (pipeline: Pipeline) =>
    problemsOf(pipeline, OFFERS).filter((problem) => /filter|loop/.test(problem));

  test.each(["review", "review:one", "review=one", "review>one", "review<one"])(
    "a filter written in the definition counts each instance's own block (%s)",
    (reviewId) => {
      const pipeline = expandTwo(reviewId);
      expect(whenOf(pipeline, "checks.cap")).toBe(`exits:checks.${reviewId}/returned>=2`);
      expect(whenOf(pipeline, "again.cap")).toBe(`exits:again.${reviewId}/returned>=2`);
      const facts = factsNamed([
        returnedAt(`checks.${reviewId}`),
        returnedAt(`checks.${reviewId}`),
      ]);
      expect(matches(facts, whenOf(pipeline, "checks.cap"))).toBe(true);
      expect(matches(facts, whenOf(pipeline, "again.cap"))).toBe(false);
      expect(filterOrLoopProblems(pipeline)).toEqual([]);
    },
  );

  test("a filter naming a block counts only the exits named there", () => {
    const facts = factsNamed([returnedAt("checks.review"), returnedAt("again.review")]);
    expect(matches(facts, "exits:checks.review/returned>=2")).toBe(false);
    expect(matches(facts, "exits:checks.review/returned>=1")).toBe(true);
    expect(matches(facts, "exit:again.review/returned")).toBe(true);
    expect(matches(facts, "exit:checks.review/returned")).toBe(false);
    expect(matches(facts, "exits:returned>=2")).toBe(true);
  });

  test.each(["checks:review", "checks=review", "checks>review", "checks<review"])(
    "a block id %s is matched whole",
    (block) => {
      const facts = factsNamed([returnedAt(block)]);
      expect(matches(facts, `exit:${block}/returned`)).toBe(true);
      expect(matches(facts, `exits:${block}/returned>=1`)).toBe(true);
      expect(matches(facts, "exits:checks/returned>=1")).toBe(false);
    },
  );

  test.each(["review", "review=one", "review>one"])(
    "validation refuses a block that is absent or does not declare the exit (%s)",
    (reviewId) => {
      const pipeline = expandTwo(reviewId);
      expect(filterOrLoopProblems(pipeline)).toEqual([]);
      expect(
        problemsOf(withWhen(pipeline, "checks.cap", "exits:nowhere/returned>=2"), OFFERS),
      ).toContain("checks.cap: the filter counts the exit returned at nowhere, which is no block");
      expect(
        problemsOf(withWhen(pipeline, "checks.cap", `exit:checks.${reviewId}/landed`), OFFERS),
      ).toContain(
        `checks.cap: the filter counts the exit landed at checks.${reviewId}, which declares no such exit`,
      );
    },
  );

  test("a qualified count grows each lap only when its block is on the cycle", () => {
    const pipeline = expandTwo("review");
    const other = withWhen(pipeline, "checks.cap", "exits:again.review/returned>=2");
    expect(
      filterOrLoopProblems(other).some((problem) => problem.includes("nothing ends the loop")),
    ).toBe(true);
  });
});
