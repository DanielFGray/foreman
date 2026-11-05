import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import type { Item } from "tasks";
import { STANDARD_PIPELINES } from "./pipeline.ts";
import { type GraphWorld, graphReport } from "./pipeline-graph.ts";
import { DEFAULT_POLICY, grant } from "./policy.ts";

const item = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  title: `Task ${id}`,
  project: "p",
  type: "task",
  status: "open",
  priority: 2,
  parent: Option.none(),
  labels: [],
  description: "",
  definitionOfDone: Option.none(),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastActivityAt: new Date(0),
  ...over,
});

const world = (over: Partial<GraphWorld>): GraphWorld => {
  const items = over.items ?? [];
  return {
    project: "p",
    items,
    dependencies: [],
    statusOf: (id) => items.find((it) => it.id === id)?.status,
    policy: DEFAULT_POLICY,
    scopes: new Map(),
    pipeline: STANDARD_PIPELINES.worktree,
    ...over,
  };
};

describe("graphReport", () => {
  test("waits on unfinished blockers only, shown or not", () => {
    const report = graphReport(
      world({
        items: [item("a"), item("b")],
        dependencies: [
          { item: "b", dependsOn: "a" },
          { item: "b", dependsOn: "landed" },
          { item: "b", dependsOn: "drafted" },
        ],
        statusOf: (id) => ({ a: "open", b: "open", landed: "done", drafted: "draft" })[id],
      }),
    );
    const b = report.items.find((it) => it.id === "b")!;
    expect(b.waitsFor).toEqual(["a", "drafted"]);
    expect(b.column).toBe(1);
    expect(report.edges).toEqual([{ item: "b", dependsOn: "a" }]);
  });

  test("names the grant that covers a task through its epic", () => {
    const policy = grant(DEFAULT_POLICY, "ep", ["author"], 2);
    const report = graphReport(
      world({
        items: [
          item("ep", { type: "epic", status: "in_progress" }),
          item("t", { parent: Option.some("ep") }),
          item("u"),
        ],
        policy,
        scopes: new Map([["ep", new Set(["t"])]]),
      }),
    );
    const covering = Object.fromEntries(report.items.map((it) => [it.id, it.grant?.scope ?? null]));
    expect(covering).toEqual({ ep: "ep", t: "ep", u: null });
    expect(report.items.find((it) => it.id === "t")!.grant!.left).toBe(2);
  });

  test("marks no task the dispatcher would not grant", () => {
    // One grant has admitted its one task; the other covers a step a pane grant does not give.
    const policy = {
      ...DEFAULT_POLICY,
      default: { author: "off", climb: "off", review: "on", publish: "off", land: "on" },
      grants: [
        { scope: "ep", steps: ["author"], remaining: 1, admitted: ["t"] },
        { scope: "v", steps: ["review"], admitted: [] },
      ],
    } as const;
    const report = graphReport(
      world({
        items: [
          item("t", { parent: Option.some("ep") }),
          item("u", { parent: Option.some("ep") }),
          item("v"),
        ],
        policy,
        scopes: new Map([
          ["ep", new Set(["t", "u"])],
          ["v", new Set(["v"])],
        ]),
      }),
    );
    const marks = Object.fromEntries(report.items.map((it) => [it.id, it.grant?.steps ?? null]));
    expect(marks).toEqual({ t: ["author"], u: null, v: null });
  });

  test("grants the gated steps that are not on", () => {
    const policy = {
      ...DEFAULT_POLICY,
      default: { author: "off", climb: "ask", review: "on", publish: "off", land: "on" },
    } as const;
    const report = graphReport(world({ policy }));
    expect(report.steps.map(({ step, mode }) => `${step}:${mode}`)).toEqual([
      "author:off",
      "climb:ask",
      "review:on",
      "land:on",
    ]);
    expect(report.grantSteps).toEqual(["author", "climb"]);
  });

  test("stacks each column by priority, then by epic", () => {
    const report = graphReport(
      world({
        items: [
          item("x", { parent: Option.some("e2") }),
          item("y", { parent: Option.some("e1") }),
          item("z", { priority: 1, parent: Option.some("e2") }),
        ],
      }),
    );
    expect(report.items.map((it) => `${it.id}${it.row}`)).toEqual(["z0", "y1", "x2"]);
  });
});
