import { describe, expect, test } from "bun:test";
import { expand } from "./composite.ts";
import { applyChange } from "./pipeline-edit.ts";
import {
  type Composites,
  type Drawing,
  problemsOf,
  type SeatOffers,
  STANDARD_PIPELINES,
} from "./pipeline.ts";
import { makeComposite, setParam, unpack } from "./pipeline-belt.ts";

const OFFERS: SeatOffers = {
  rungs: [
    { name: "cheap", author: true },
    { name: "strong", author: true },
  ],
  reviewers: ["sharp"],
};

const idsOf = (drawing: Drawing) => drawing.nodes.map((node) => node.id).toSorted();

const expansionOf = (drawing: Drawing, composites: Composites) => {
  const result = expand(drawing, composites);
  if (result._tag === "Failed") throw new Error(result.problems.join("; "));
  return result.pipeline;
};

const sameExpansion = (before: Drawing, after: Drawing, composites: Composites) => {
  const left = expansionOf(before, {});
  const right = expansionOf(after, composites);
  expect(idsOf(right)).toEqual(idsOf(left));
  expect(problemsOf(right, OFFERS)).toEqual(problemsOf(left, OFFERS));
  expect(JSON.stringify(right.nodes.toSorted((a, b) => a.id.localeCompare(b.id)))).toEqual(
    JSON.stringify(left.nodes.toSorted((a, b) => a.id.localeCompare(b.id))),
  );
};

describe("MakeComposite round-trips on the standard pipeline", () => {
  test("the review loop expands to the same graph, ids and validation", () => {
    const before = STANDARD_PIPELINES.checkout;
    const made = makeComposite(before, ["review-gate", "review"], "review-loop");
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    sameExpansion(before, made.pipeline, { "review-loop": made.definition });
    const instance = made.pipeline.nodes.find((node) => node.kind === "composite");
    expect(instance).toMatchObject({ kind: "composite", of: "review-loop", prefix: "" });
  });

  test("the author alone expands to the same graph, ids and validation", () => {
    const before = STANDARD_PIPELINES.checkout;
    const made = makeComposite(before, ["author"], "author-step");
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    sameExpansion(before, made.pipeline, { "author-step": made.definition });
  });

  test("the land tail expands to the same graph, ids and validation", () => {
    const before = STANDARD_PIPELINES.checkout;
    const made = makeComposite(before, ["land-gate", "land"], "land-tail");
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    sameExpansion(before, made.pipeline, { "land-tail": made.definition });
  });

  test("start + climb + author is refused: two entries", () => {
    const made = makeComposite(
      STANDARD_PIPELINES.checkout,
      ["start", "climb", "author"],
      "authors",
    );
    expect(made).toMatchObject({ _tag: "Refused" });
  });

  test("Unpack of a made instance restores the same expansion", () => {
    const before = STANDARD_PIPELINES.checkout;
    const made = makeComposite(before, ["review-gate", "review"], "review-loop");
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    const composites = { "review-loop": made.definition };
    const instance = made.pipeline.nodes.find((node) => node.kind === "composite");
    expect(instance?.kind).toBe("composite");
    if (instance?.kind !== "composite") return;
    const unpacked = unpack(made.pipeline, instance.id, composites);
    expect(unpacked._tag).toBe("Unpacked");
    if (unpacked._tag !== "Unpacked") return;
    sameExpansion(before, unpacked.pipeline, {});
  });
});

describe("SetParam and InsertOn composite through applyChange", () => {
  test("SetParam sets a parameter on an instance", () => {
    const made = makeComposite(
      STANDARD_PIPELINES.checkout,
      ["review-gate", "review"],
      "review-loop",
    );
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    const definition = {
      ...made.definition,
      params: [
        {
          name: "reviewer",
          default: "reviewers",
          sets: [{ block: "review", field: "model" }],
        },
      ],
    };
    const composites = { "review-loop": definition };
    const instance = made.pipeline.nodes.find((node) => node.kind === "composite");
    expect(instance?.kind).toBe("composite");
    if (instance?.kind !== "composite") return;
    const withParam = setParam(made.pipeline, instance.id, "reviewer", "opus");
    expect(withParam.nodes.find((node) => node.id === instance.id)).toMatchObject({
      set: { reviewer: "opus" },
    });
    const expanded = expansionOf(withParam, composites);
    expect(expanded.nodes.find((node) => node.id === "review")).toMatchObject({ model: "opus" });
  });

  test("InsertOn kind composite places an instance with prefix <id>.", () => {
    const made = makeComposite(
      STANDARD_PIPELINES.checkout,
      ["review-gate", "review"],
      "review-loop",
    );
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    const composites = { "review-loop": made.definition };
    const result = applyChange(
      STANDARD_PIPELINES.checkout,
      {
        _tag: "InsertOn",
        wire: { from: "author", port: "exit:done" },
        kind: "composite",
        of: "review-loop",
      },
      composites,
    );
    expect(result._tag).toBe("Changed");
    if (result._tag !== "Changed") return;
    const instance = result.pipeline.nodes.find((node) => node.id === result.added);
    expect(instance).toMatchObject({
      kind: "composite",
      of: "review-loop",
      prefix: `${result.added}.`,
    });
    expect(instance?.kind === "composite" && instance.exits[0]?.to).toBe("review-gate");
  });

  test("MakeComposite through applyChange returns the definition", () => {
    const result = applyChange(STANDARD_PIPELINES.checkout, {
      _tag: "MakeComposite",
      ids: ["author"],
      name: "author-step",
    });
    expect(result._tag).toBe("Changed");
    if (result._tag !== "Changed") return;
    expect(result.composites?.["author-step"]).toBeDefined();
    expect(result.pipeline.nodes.some((node) => node.kind === "composite")).toBe(true);
  });
});

describe("Unpack keeps the expansion when an exit targets a block of the drawing", () => {
  const loop: Composites = {
    loop: {
      entry: "g",
      exits: [{ id: "again", name: "again" }],
      params: [],
      blocks: [{ kind: "gate", id: "g", step: "review", next: "out:again" }],
    },
  };

  const unpackSame = (drawing: Drawing, id: string, composites: Composites) => {
    const unpacked = unpack(drawing, id, composites);
    expect(unpacked._tag).toBe("Unpacked");
    if (unpacked._tag !== "Unpacked") return;
    const sorted = (pipeline: { readonly nodes: ReadonlyArray<{ readonly id: string }> }) =>
      JSON.stringify(pipeline.nodes.toSorted((a, b) => a.id.localeCompare(b.id)));
    expect(sorted(expansionOf(unpacked.pipeline, composites))).toEqual(
      sorted(expansionOf(drawing, composites)),
    );
  };

  test("an exit that returns to its own instance points at the instance's entry", () => {
    const drawing = {
      nodes: [
        { kind: "source", id: "s", filter: "", next: "i" },
        {
          kind: "composite",
          id: "i",
          of: "loop",
          prefix: "i.",
          set: {},
          exits: [{ id: "again", to: "i" }],
        },
      ],
    } satisfies Drawing;
    unpackSame(drawing, "i", loop);
  });

  test("an exit that leads to a sibling instance points at the sibling's entry", () => {
    const drawing = {
      nodes: [
        { kind: "source", id: "s", filter: "", next: "a" },
        {
          kind: "composite",
          id: "a",
          of: "loop",
          prefix: "a.",
          set: {},
          exits: [{ id: "again", to: "b" }],
        },
        {
          kind: "composite",
          id: "b",
          of: "loop",
          prefix: "b.",
          set: {},
          exits: [{ id: "again", to: "a" }],
        },
      ],
    } satisfies Drawing;
    unpackSame(drawing, "a", loop);
  });

  test("a self-return through a nested instance keeps the outer entry", () => {
    const composites: Composites = {
      ...loop,
      outer: {
        entry: "n",
        exits: [{ id: "back", name: "back" }],
        params: [],
        blocks: [
          {
            kind: "composite",
            id: "n",
            of: "loop",
            prefix: "",
            set: {},
            exits: [{ id: "again", to: "out:back" }],
          },
        ],
      },
    };
    const drawing = {
      nodes: [
        { kind: "source", id: "s", filter: "", next: "i" },
        {
          kind: "composite",
          id: "i",
          of: "outer",
          prefix: "i.",
          set: {},
          exits: [{ id: "back", to: "i" }],
        },
      ],
    } satisfies Drawing;
    unpackSame(drawing, "i", composites);
  });
});

describe("MakeComposite names an exit as the exit of its source block", () => {
  test("a router's wires take the target's id as the exit name, not the filter", () => {
    const drawing = {
      nodes: [
        { kind: "source", id: "s", filter: "", next: "r" },
        {
          kind: "router",
          id: "r",
          routes: [{ when: "size:1", to: "a" }],
          else: "b",
        },
        { kind: "done", id: "a" },
        { kind: "done", id: "b" },
      ],
    } satisfies Drawing;
    const made = makeComposite(drawing, ["r"], "route", {});
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    expect(made.definition.exits.map((exit) => exit.name)).toEqual(["a", "b"]);
  });

  test("a nested instance's wire takes its definition's exit name, not the exit id", () => {
    const composites: Composites = {
      inner: {
        entry: "g",
        exits: [{ id: "e1", name: "ok" }],
        params: [],
        blocks: [{ kind: "gate", id: "g", step: "review", next: "out:e1" }],
      },
    };
    const drawing = {
      nodes: [
        { kind: "source", id: "s", filter: "", next: "box" },
        {
          kind: "composite",
          id: "box",
          of: "inner",
          prefix: "box.",
          set: {},
          exits: [{ id: "e1", to: "d" }],
        },
        { kind: "done", id: "d" },
      ],
    } satisfies Drawing;
    const made = makeComposite(drawing, ["box"], "outer", composites);
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    expect(made.definition.exits).toEqual([{ id: "exit-ok", name: "ok" }]);
  });
});
