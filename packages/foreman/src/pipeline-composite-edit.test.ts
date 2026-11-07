import { describe, expect, test } from "bun:test";
import { expand } from "./composite.ts";
import { applyChange, applyDefinitionChange, type CompositeChange } from "./pipeline-edit.ts";
import {
  type Composites,
  type Drawing,
  problemsOf,
  type SeatOffers,
  STANDARD_PIPELINES,
} from "./pipeline.ts";
import { makeComposite, setParam, unpack } from "./pipeline-belt.ts";
import { writtenDrawingOf } from "./pipeline-layout.ts";

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

  test("start + climb + author makes two entries, keeps ids and validation, and leaves a task at the author in place", () => {
    const before = STANDARD_PIPELINES.checkout;
    const made = makeComposite(before, ["start", "climb", "author"], "authors");
    expect(made._tag).toBe("Made");
    if (made._tag !== "Made") return;
    expect(made.definition.entries.map((entry) => entry.block)).toEqual(["climb", "start"]);
    sameExpansion(before, made.pipeline, { authors: made.definition });
    // A run stores the block it stood at; placement looks that id up in the expansion.
    const expanded = expansionOf(made.pipeline, { authors: made.definition });
    expect(expanded.nodes.some((node) => node.id === "author")).toBe(true);
  });

  test("a second instance with both entries wired validates", () => {
    const made = makeComposite(
      STANDARD_PIPELINES.checkout,
      ["start", "climb", "author"],
      "authors",
    );
    if (made._tag !== "Made") throw new Error("expected Made");
    const [climb, start] = made.definition.entries;
    const second = {
      kind: "composite" as const,
      id: "again",
      of: "authors",
      prefix: "again.",
      set: {},
      exits: [{ id: "exit-done", to: "review-gate" }],
    };
    const nodes = made.pipeline.nodes.map((node) =>
      node.kind === "router"
        ? {
            ...node,
            routes: [
              ...node.routes,
              { when: "attempts>=2", to: `again/${climb!.id}` },
              { when: "attempts>=3", to: `again/${start!.id}` },
            ],
          }
        : node,
    );
    const drawing: Drawing = { nodes: [...nodes, second] };
    const expanded = expansionOf(drawing, { authors: made.definition });
    expect(expanded.nodes.map((node) => node.id)).toContain("again.author");
    expect(problemsOf(expanded, OFFERS)).toEqual([]);
  });

  test("a block id holding a slash is a validation problem", () => {
    const pipeline = expansionOf(STANDARD_PIPELINES.checkout, {});
    const renamed = {
      nodes: pipeline.nodes.map((node) =>
        node.id === "review" ? { ...node, id: "re/view" } : node,
      ),
    };
    expect(problemsOf(renamed, OFFERS).join("\n")).toContain('a block id holds no "/"');
  });

  test("Rejoin to <instance>/<entry id> is allowed, and to an unknown entry is not", () => {
    const made = makeComposite(
      STANDARD_PIPELINES.checkout,
      ["start", "climb", "author"],
      "authors",
    );
    if (made._tag !== "Made") throw new Error("expected Made");
    const composites = { authors: made.definition };
    const wire = { from: "review", port: "exit:returned" } as const;
    const ok = applyChange(
      made.pipeline,
      { _tag: "Rejoin", wire, to: "authors/entry-start" },
      composites,
    );
    expect(ok._tag).toBe("Changed");
    const bad = applyChange(
      made.pipeline,
      { _tag: "Rejoin", wire, to: "authors/entry-nowhere" },
      composites,
    );
    expect(bad._tag).toBe("Refused");
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
      entries: [{ id: "entry-g", name: "g", block: "g" }],
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
        entries: [{ id: "entry-n", name: "n", block: "n" }],
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
        entries: [{ id: "entry-g", name: "g", block: "g" }],
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

describe("the entry verbs on a definition", () => {
  const authors = () => {
    const made = makeComposite(
      STANDARD_PIPELINES.checkout,
      ["start", "climb", "author"],
      "authors",
    );
    if (made._tag !== "Made") throw new Error("expected Made");
    return made.definition;
  };
  const apply = (definition: ReturnType<typeof authors>, change: CompositeChange) =>
    applyDefinitionChange(definition, change);

  test("AddEntry, RenameEntry and SetEntry change one entry; wires name entries by id", () => {
    const added = apply(authors(), { _tag: "AddEntry", block: "author", name: "direct" });
    if (added._tag !== "Changed") throw new Error("expected Changed");
    expect(added.definition.entries.map((entry) => entry.id)).toEqual([
      "entry-climb",
      "entry-start",
      "entry-direct",
    ]);
    const renamed = apply(added.definition, {
      _tag: "RenameEntry",
      id: "entry-direct",
      name: "straight",
    });
    if (renamed._tag !== "Changed") throw new Error("expected Changed");
    expect(renamed.definition.entries[2]).toEqual({
      id: "entry-direct",
      name: "straight",
      block: "author",
    });
    const pointed = apply(renamed.definition, {
      _tag: "SetEntry",
      id: "entry-direct",
      block: "start",
    });
    if (pointed._tag !== "Changed") throw new Error("expected Changed");
    expect(pointed.definition.entries[2]?.block).toBe("start");
    expect(
      apply(renamed.definition, { _tag: "SetEntry", id: "entry-direct", block: "nowhere" })._tag,
    ).toBe("Refused");
    expect(
      apply(renamed.definition, { _tag: "RenameEntry", id: "entry-direct", name: "start" })._tag,
    ).toBe("Refused");
  });

  test("removing the block of an entry, and the last entry, are refused", () => {
    const refused = apply(authors(), { _tag: "Remove", id: "start" });
    expect(refused).toMatchObject({ _tag: "Refused" });
    const one = apply(authors(), { _tag: "RemoveEntry", id: "entry-start" });
    if (one._tag !== "Changed") throw new Error("expected Changed");
    expect(one.definition.entries.map((entry) => entry.id)).toEqual(["entry-climb"]);
    expect(apply(one.definition, { _tag: "RemoveEntry", id: "entry-climb" })).toMatchObject({
      _tag: "Refused",
      reason: expect.stringContaining("last entry"),
    });
  });

  test("Unpack of an instance an entry names moves each entry to the expanded block", () => {
    const inner = authors();
    const outer = {
      entries: [
        { id: "entry-a", name: "a", block: "nested" },
        { id: "entry-b", name: "b", block: "nested/entry-start" },
      ],
      exits: inner.exits,
      params: [],
      blocks: [
        {
          kind: "composite" as const,
          id: "nested",
          of: "authors",
          prefix: "n.",
          set: {},
          exits: [{ id: "exit-done", to: "out:exit-done" }],
        },
      ],
    };
    const unpacked = applyDefinitionChange(
      outer,
      { _tag: "Unpack", id: "nested" },
      { authors: inner },
    );
    if (unpacked._tag !== "Changed") throw new Error("expected Changed");
    expect(unpacked.definition.entries.map((entry) => entry.block)).toEqual(["n.climb", "n.start"]);
  });
});

describe("the written drawing of a multi-entry instance", () => {
  test("lists one way in per entry, and a wire into a later entry ends on the instance and names it", () => {
    const made = makeComposite(
      STANDARD_PIPELINES.checkout,
      ["start", "climb", "author"],
      "authors",
    );
    if (made._tag !== "Made") throw new Error("expected Made");
    const drawing = writtenDrawingOf(made.pipeline, { authors: made.definition }, "across");
    const block = drawing.blocks.find((one) => one.id === "authors");
    expect(block?.entries).toEqual([
      { id: "entry-climb", name: "climb", target: "authors" },
      { id: "entry-start", name: "start", target: "authors/entry-start" },
    ]);
    const into = drawing.wires.filter((wire) => wire.to === "authors");
    expect(into.map((wire) => wire.entry)).toEqual([undefined, undefined, "entry-start"]);
  });
});
