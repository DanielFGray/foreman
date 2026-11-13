import { assert, describe, it } from "@effect/vitest";
import type { GraphItemView, GraphView } from "foreman/pipeline-graph-view";
import { projectGraph, type Projection } from "./graph-projection.ts";

const item = (id: string, over: Partial<GraphItemView> = {}): GraphItemView => ({
  id,
  title: `Task ${id}`,
  type: "task",
  status: "open",
  priority: 2,
  parent: null,
  column: 0,
  row: 0,
  waitsFor: [],
  grant: null,
  ...over,
});

/**
 * An epic `ep` with tasks `a` and `b` (b waits for a), a task `c` outside it
 * that waits for both, and a task `d` that waits for `c`.
 */
const VIEW: GraphView = {
  project: "p",
  items: [
    item("ep", { type: "epic", status: "in_progress", title: "Epic" }),
    item("a", { parent: "ep" }),
    item("b", { parent: "ep" }),
    item("c", { title: "Elsewhere" }),
    item("d"),
  ],
  edges: [
    { item: "b", dependsOn: "a" },
    { item: "c", dependsOn: "a" },
    { item: "c", dependsOn: "b" },
    { item: "d", dependsOn: "c" },
  ],
  steps: [],
  grantSteps: [],
};

const columns = (projection: Projection) =>
  Object.fromEntries(projection.nodes.map((node) => [node.item.id, node.column]));

describe("projectGraph", () => {
  it("draws every item unfolded, each one past its furthest blocker", () => {
    const shown = projectGraph(VIEW, { folded: new Set(), query: "" });
    assert.deepStrictEqual(columns(shown), { ep: 0, a: 0, b: 1, c: 2, d: 3 });
    assert.strictEqual(shown.edges.length, 4);
    assert.isTrue(shown.edges.every((edge) => edge.count === 1 && !edge.resolved));
  });

  it("draws a folded epic for its family, merges the edges out of it and counts the ones inside", () => {
    const shown = projectGraph(VIEW, { folded: new Set(["ep"]), query: "" });
    assert.deepStrictEqual(columns(shown), { ep: 0, c: 1, d: 2 });
    assert.deepStrictEqual(
      shown.edges.map(({ from, to, count }) => `${from}>${to}x${count}`).toSorted(),
      ["c>dx1", "ep>cx2"],
    );
    assert.strictEqual(shown.inside.get("ep"), 1);
    const epic = shown.nodes.find((node) => node.item.id === "ep");
    assert.strictEqual(epic?.hidden, 2);
    assert.strictEqual(epic?.members, 2);
  });

  it("draws an inner folded epic as the outer folded one", () => {
    const nested: GraphView = {
      ...VIEW,
      items: [
        ...VIEW.items,
        item("inner", { type: "epic", parent: "ep" }),
        item("e", { parent: "inner" }),
      ],
      edges: [...VIEW.edges, { item: "d", dependsOn: "e" }],
    };
    const shown = projectGraph(nested, { folded: new Set(["ep", "inner"]), query: "" });
    assert.deepStrictEqual(shown.nodes.map((node) => node.item.id).toSorted(), ["c", "d", "ep"]);
    assert.strictEqual(shown.nodes.find((node) => node.item.id === "ep")?.hidden, 4);
    assert.isTrue(shown.edges.some((edge) => edge.from === "ep" && edge.to === "d"));
  });

  it("keeps a match's ancestors as context and unfolds them, and drops what does not match", () => {
    const shown = projectGraph(VIEW, { folded: new Set(["ep"]), query: "task B" });
    assert.deepStrictEqual(
      shown.nodes
        .map((node) => [node.item.id, node.context])
        .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      [
        ["b", false],
        ["ep", true],
      ],
    );
    assert.deepStrictEqual(shown.edges, []);
  });

  it("matches an id as well as a title, ignoring case", () => {
    const shown = projectGraph(VIEW, { folded: new Set(), query: "ELSEWHERE" });
    assert.deepStrictEqual(
      shown.nodes.map((node) => node.item.id),
      ["c"],
    );
    assert.deepStrictEqual(
      projectGraph(VIEW, { folded: new Set(), query: "d" }).nodes.map((node) => node.item.id),
      ["d"],
    );
  });

  it("marks an edge resolved only when every dependency under it has a finished blocker", () => {
    const finished: GraphView = {
      ...VIEW,
      items: VIEW.items.map((one) => (one.id === "a" ? { ...one, status: "done" } : one)),
    };
    const shown = projectGraph(finished, { folded: new Set(["ep"]), query: "" });
    const out = shown.edges.find((edge) => edge.from === "ep" && edge.to === "c");
    assert.isFalse(out?.resolved);
    const open = projectGraph(finished, { folded: new Set(), query: "" });
    assert.isTrue(open.edges.find((edge) => edge.from === "a" && edge.to === "c")?.resolved);
  });
});
