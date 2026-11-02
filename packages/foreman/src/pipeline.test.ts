import { describe, expect, test } from "bun:test";
import type { Run } from "tasks";
import { checkRun, handedOff, reviewRun } from "./task-fixture.ts";
import {
  type Facts,
  matches,
  nextAgent,
  type Pipeline,
  type PipelineNode,
  place,
  problemsOf,
  STANDARD_PIPELINE,
  toMermaid,
} from "./pipeline.ts";
import { factsOf } from "./pipeline-facts.ts";

const facts = (over: Partial<Facts> = {}): Facts => ({
  status: "open",
  priority: 2,
  epic: undefined,
  size: 1,
  labels: new Set(),
  failedBy: new Set(),
  attempts: 0,
  passed: new Set(),
  underReview: false,
  approved: false,
  ...over,
});

const at = (pipeline: Pipeline, over: Partial<Facts>) => {
  const placement = place(pipeline, facts(over));
  return placement._tag === "At"
    ? {
        node: placement.node.id,
        state: placement.state,
        gates: placement.gates.map((gate) => gate.id),
        ahead: placement.ahead,
      }
    : placement;
};

const RUNGS = ["cheap", "strong"];

describe("filters", () => {
  test.each<[string, Partial<Facts>, boolean]>([
    ["", {}, true],
    ["failed", { failedBy: new Set(["cheap"]) }, true],
    ["failed", {}, false],
    ["failed:cheap", { failedBy: new Set(["cheap"]) }, true],
    ["failed:strong", { failedBy: new Set(["cheap"]) }, false],
    ["-failed", {}, true],
    ["attempts>=1", { attempts: 2 }, true],
    ["attempts>=1", {}, false],
    ["size<=1", { size: 2 }, false],
    ["size=2 priority<=1", { size: 2, priority: 1 }, true],
    ["size=2 priority<=1", { size: 2, priority: 3 }, false],
    ["label:research", { labels: new Set(["research"]) }, true],
    ["epic:ep-1", { epic: "ep-1" }, true],
    ["kind:failed-by", { failedBy: new Set(["cheap"]) }, false],
  ])("%p on %p is %p", (filter, over, expected) => {
    expect(matches(facts(over), filter)).toBe(expected);
  });
});

describe("facts read from labels and runs", () => {
  test("names failures, attempts, size, passed blocks and the review", () => {
    const read = factsOf({
      status: "reviewing",
      priority: 1,
      parent: "ep-1",
      labels: [
        "failed-by:cheap",
        "attempt:strong:1",
        "attempt:strong:2",
        "attempt:x:bad",
        "size:3",
      ],
      runs: [handedOff("cheap"), reviewRun("strong", { ending: "approved", commit: "c1" })],
      tip: "c1",
    });
    expect([...read.failedBy]).toEqual(["cheap"]);
    expect(read.attempts).toBe(2);
    expect(read.size).toBe(3);
    expect([...read.passed]).toEqual(["author", "review"]);
    expect(read.underReview).toBe(true);
    expect(read.approved).toBe(true);
    expect(read.epic).toBe("ep-1");
  });
});

describe("placement on the standard pipeline", () => {
  test.each<[string, Partial<Facts>, ReturnType<typeof at>]>([
    [
      "a new task waits for the author gate",
      {},
      { node: "author", state: "waiting", gates: ["start"], ahead: 2 },
    ],
    [
      "a failed task waits for the climb gate",
      { failedBy: new Set(["cheap"]) },
      { node: "author", state: "waiting", gates: ["climb"], ahead: 2 },
    ],
    [
      "an unfinished attempt is a climb too",
      { attempts: 1 },
      { node: "author", state: "waiting", gates: ["climb"], ahead: 2 },
    ],
    [
      "work in flight with nothing passed is running at the author",
      { status: "in_progress" },
      { node: "author", state: "running", gates: ["start"], ahead: 2 },
    ],
    [
      "a handoff with nothing passed has ended at the author",
      { status: "reviewing" },
      { node: "author", state: "ended", gates: ["start"], ahead: 2 },
    ],
    [
      "past the author it waits for the review gate",
      { status: "reviewing", passed: new Set(["author"]) },
      { node: "review", state: "waiting", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "a reviewer at work is running",
      { status: "reviewing", passed: new Set(["author"]), underReview: true },
      { node: "review", state: "running", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "an approval not yet recorded has ended the review",
      { status: "reviewing", passed: new Set(["author"]), underReview: true, approved: true },
      { node: "review", state: "ended", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "past the review it waits for the land gate",
      { status: "reviewing", passed: new Set(["author", "review"]) },
      { node: "land", state: "waiting", gates: ["land-gate"], ahead: 0 },
    ],
    [
      "a passed block the pipeline no longer has places nothing",
      { status: "reviewing", passed: new Set(["author", "deleted-block"]) },
      { node: "review", state: "waiting", gates: ["review-gate"], ahead: 1 },
    ],
  ])("%s", (_, over, expected) => {
    expect(at(STANDARD_PIPELINE, over)).toEqual(expected);
  });

  test.each(["done", "canceled", "proposed", "draft", "blocked"] as const)(
    "a %s task is outside the flow",
    (status) => {
      expect(place(STANDARD_PIPELINE, facts({ status }))._tag).toBe("Outside");
    },
  );
});

describe("placement on a drawn pipeline", () => {
  const triage: Pipeline = {
    nodes: [
      { kind: "source", id: "small", filter: "size<=1 -label:research", next: "cut" },
      { kind: "source", id: "rest", filter: "", next: "big" },
      {
        kind: "router",
        id: "big",
        routes: [{ when: "failed:strong", to: "operator" }],
        else: "cut",
      },
      { kind: "branch", id: "cut", next: "gate" },
      { kind: "park", id: "operator" },
      { kind: "gate", id: "gate", step: "author", next: "write" },
      { kind: "agent", id: "write", role: "author", model: "ladder", next: "check" },
      { kind: "gate", id: "check", step: "review", next: "read" },
      { kind: "agent", id: "read", role: "review", model: "above", next: "ship" },
      { kind: "gate", id: "ship", step: "land", next: "land" },
      { kind: "land", id: "land" },
    ],
  };

  test("is valid", () => {
    expect(problemsOf(triage, RUNGS)).toEqual([]);
  });

  test("the first source whose filter matches takes the task", () => {
    expect(at(triage, { size: 1 })).toMatchObject({ node: "write", gates: ["gate"] });
    expect(at(triage, { size: 3 })).toMatchObject({ node: "write", gates: ["gate"] });
  });

  test("a router reads the facts and can park the task", () => {
    expect(at(triage, { size: 3, failedBy: new Set(["strong"]) })).toEqual({
      _tag: "Parked",
      node: "operator",
    });
  });

  test("no source taking the task leaves it outside", () => {
    const narrow: Pipeline = {
      nodes: triage.nodes.filter(
        (node) => node.id !== "rest" && node.id !== "big" && node.id !== "operator",
      ),
    };
    expect(place(narrow, facts({ size: 3 }))._tag).toBe("Outside");
  });
});

describe("the block an agent started by hand runs at", () => {
  test("is the first block of its role on the route", () => {
    expect(nextAgent(STANDARD_PIPELINE, facts(), "author")?.id).toBe("author");
    // A review started before the author handed off still runs at the review
    // block: the blocks before it count as passed.
    expect(nextAgent(STANDARD_PIPELINE, facts(), "review")?.id).toBe("review");
  });

  test("is nothing when the route has no such block", () => {
    const parked: Pipeline = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "operator" },
        { kind: "park", id: "operator" },
      ],
    };
    expect(nextAgent(parked, facts(), "author")).toBeUndefined();
  });
});

describe("validation", () => {
  const without = (...ids: string[]) => STANDARD_PIPELINE.nodes.filter((n) => !ids.includes(n.id));
  const replace = (node: PipelineNode): Pipeline => ({
    nodes: STANDARD_PIPELINE.nodes.map((n) => (n.id === node.id ? node : n)),
  });

  test("the standard pipeline is valid", () => {
    expect(problemsOf(STANDARD_PIPELINE, RUNGS)).toEqual([]);
  });

  test("names a duplicate block, a loose wire and a filter that means nothing", () => {
    const problems = problemsOf(
      {
        nodes: [
          { kind: "source", id: "queue", filter: "kind:failed-by", next: "nowhere" },
          { kind: "land", id: "queue" },
        ],
      },
      RUNGS,
    );
    expect(problems).toEqual([
      "two blocks are named queue",
      "queue is wired to nowhere, which is no block",
      "queue: the filter term kind:failed-by means nothing",
    ]);
  });

  test("names a model the block's role cannot use", () => {
    expect(
      problemsOf(
        replace({
          kind: "agent",
          id: "review",
          role: "review",
          model: "ladder",
          next: "land-gate",
        }),
        RUNGS,
      ),
    ).toEqual(["review: a reviewer reads above its author, not from the ladder's foot"]);
    expect(
      problemsOf(
        replace({
          kind: "agent",
          id: "author",
          role: "author",
          model: "gone",
          next: "review-gate",
        }),
        RUNGS,
      ),
    ).toEqual(["author: gone is no rung on the ladder"]);
  });

  test("refuses a wire back to an earlier block", () => {
    const problems = problemsOf(
      replace({ kind: "gate", id: "land-gate", step: "land", next: "author" }),
      RUNGS,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^the wires loop through .*author/);
  });

  test("refuses a route to a land that skips review", () => {
    expect(
      problemsOf(replace({ kind: "gate", id: "review-gate", step: "review", next: "land" }), RUNGS),
    ).toEqual([
      "no source reaches review",
      "no source reaches land-gate",
      "a route from queue reaches land with no review after it",
      "a route from author reaches land with no review after it",
    ]);
  });

  test("a review before the author does not count", () => {
    const backwards: Pipeline = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "cut" },
        { kind: "branch", id: "cut", next: "g1" },
        { kind: "gate", id: "g1", step: "review", next: "review" },
        { kind: "agent", id: "review", role: "review", model: "above", next: "g2" },
        { kind: "gate", id: "g2", step: "author", next: "author" },
        { kind: "agent", id: "author", role: "author", model: "ladder", next: "g3" },
        { kind: "gate", id: "g3", step: "land", next: "land" },
        { kind: "land", id: "land" },
      ],
    };
    expect(problemsOf(backwards, RUNGS)).toEqual([
      "a route from author reaches land with no review after it",
    ]);
  });

  test("refuses a work block no gate stands before", () => {
    expect(
      problemsOf(
        replace({ kind: "agent", id: "review", role: "review", model: "above", next: "land" }),
        RUNGS,
      ),
    ).toEqual(["no source reaches land-gate", "a route from review reaches land through no gate"]);
    expect(
      problemsOf(
        {
          nodes: [
            { kind: "source", id: "q", filter: "", next: "branch" },
            ...without("queue", "worktree"),
            { kind: "worktree", id: "worktree", next: "start" },
          ],
        },
        RUNGS,
      ),
    ).toEqual(["no source reaches retry", "no source reaches climb"]);
  });

  test("a router does not stand in for a gate", () => {
    const ungated: Pipeline = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "branch" },
        { kind: "worktree", id: "worktree", next: "route" },
        { kind: "router", id: "route", routes: [{ when: "failed", to: "g" }], else: "author" },
        { kind: "gate", id: "g", step: "climb", next: "author" },
        ...without("queue", "worktree", "retry", "start", "climb"),
      ],
    };
    expect(problemsOf(ungated, RUNGS)).toEqual([
      "a route from queue reaches author through no gate",
    ]);
  });
});

describe("a check block", () => {
  // The standard pipeline with a check between the author and the review.
  const checked: Pipeline = {
    nodes: STANDARD_PIPELINE.nodes.flatMap((node): ReadonlyArray<PipelineNode> =>
      node.kind === "agent" && node.id === "author"
        ? [
            { ...node, next: "lint-gate" },
            { kind: "gate", id: "lint-gate", step: "review", next: "lint" },
            { kind: "check", id: "lint", command: "bun run lint", next: "review-gate" },
          ]
        : [node],
    ),
  };
  const handedOver = (runs: ReadonlyArray<Run>, tip: string) =>
    place(
      checked,
      factsOf({
        status: "reviewing",
        priority: 1,
        parent: undefined,
        labels: [],
        runs: [handedOff("cheap", "c1"), ...runs],
        tip,
      }),
    );
  const nodeOf = (placement: ReturnType<typeof place>) =>
    placement._tag === "At" ? `${placement.node.id} ${placement.state}` : placement._tag;

  test("is valid where a gate stands before it and an author before that", () => {
    expect(problemsOf(checked, RUNGS)).toEqual([]);
  });

  test("waits after the author hands off, and counts as a block ahead", () => {
    expect(at(checked, {})).toMatchObject({ node: "author", ahead: 3 });
    expect(at(checked, { status: "reviewing", passed: new Set(["author"]) })).toEqual({
      node: "lint",
      state: "waiting",
      gates: ["lint-gate"],
      ahead: 2,
    });
  });

  test("passes the commit its command passed on, and only that commit", () => {
    expect(nodeOf(handedOver([], "c1"))).toBe("lint waiting");
    expect(nodeOf(handedOver([checkRun("lint", "c1", "passed")], "c1"))).toBe("review waiting");
    expect(nodeOf(handedOver([checkRun("lint", "c1", "failed")], "c1"))).toBe("lint waiting");
    // A commit after the check places the task at the check again.
    expect(nodeOf(handedOver([checkRun("lint", "c1", "passed")], "c2"))).toBe("lint waiting");
  });

  test("is no review: a land past a check and no reviewer is refused", () => {
    const unreviewed: Pipeline = {
      nodes: checked.nodes
        .filter((node) => node.id !== "review" && node.id !== "review-gate")
        .map((node) => (node.id === "lint" ? { ...node, next: "land-gate" } : node)),
    };
    expect(problemsOf(unreviewed, RUNGS)).toEqual([
      "a route from queue reaches land with no review after it",
      "a route from author reaches land with no review after it",
    ]);
  });

  test("needs a gate before it, an author before it and a command", () => {
    const ungated: Pipeline = {
      nodes: checked.nodes
        .filter((node) => node.id !== "lint-gate")
        .map((node) => (node.id === "author" ? { ...node, next: "lint" } : node)),
    };
    expect(problemsOf(ungated, RUNGS)).toEqual([
      "a route from author reaches lint through no gate",
    ]);

    const first: Pipeline = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "branch" },
        { kind: "worktree", id: "worktree", next: "g0" },
        { kind: "gate", id: "g0", step: "author", next: "lint" },
        { kind: "check", id: "lint", command: "bun run lint", next: "start" },
        ...STANDARD_PIPELINE.nodes.filter(
          (node) => !["queue", "worktree", "retry", "climb"].includes(node.id),
        ),
      ],
    };
    expect(problemsOf(first, RUNGS)).toEqual([
      "a route from queue reaches lint with no author before it",
    ]);

    const silent: Pipeline = {
      nodes: checked.nodes.map((node) => (node.id === "lint" ? { ...node, command: " " } : node)),
    };
    expect(problemsOf(silent, RUNGS)).toEqual(["lint: a check runs a command, and it names none"]);
  });

  test("is drawn with its command", () => {
    expect(toMermaid(checked)).toContain("lint: runs bun run lint");
  });
});

describe("the Mermaid drawing", () => {
  test("draws every block and one arrow per wire", () => {
    const lines = toMermaid(STANDARD_PIPELINE).split("\n");
    expect(lines[0]).toBe("flowchart LR");
    expect(lines.filter((line) => line.includes("-->"))).toHaveLength(12);
    expect(lines.some((line) => line.includes('"failed"'))).toBe(true);
    expect(lines.some((line) => line.includes("author: author on ladder"))).toBe(true);
  });
});

describe("the modules herdr-web's page bundles", () => {
  test("reach neither the task store nor node", async () => {
    const built = await Bun.build({
      entrypoints: [`${import.meta.dir}/pipeline.ts`, `${import.meta.dir}/pipeline-belt.ts`],
      target: "browser",
    });
    expect(built.success).toBe(true);
    const code = (await Promise.all(built.outputs.map((output) => output.text()))).join("\n");
    expect(code).not.toMatch(/bun:sqlite|from "node:|require\("node:|effect\/sql/);
  });
});

describe("workspace blocks", () => {
  const swap = (pipeline: Pipeline, ...nodes: ReadonlyArray<PipelineNode>): Pipeline => ({
    nodes: pipeline.nodes.map((node) => nodes.find((other) => other.id === node.id) ?? node),
  });
  const drop = (pipeline: Pipeline, id: string, next: string): Pipeline => ({
    nodes: pipeline.nodes
      .filter((node) => node.id !== id)
      .map((node) => ("next" in node && node.next === id ? { ...node, next } : node)),
  });
  const branchOnly = drop(STANDARD_PIPELINE, "worktree", "retry");
  const direct = swap(drop(branchOnly, "branch", "retry"), { kind: "done", id: "land" });
  const workspaceOf = (pipeline: Pipeline, over: Partial<Facts> = {}) => {
    const placement = place(pipeline, facts(over));
    return placement._tag === "At" ? [placement.node.id, placement.workspace] : placement._tag;
  };

  test("each of the three shapes is valid, and places the agent in its workspace", () => {
    for (const pipeline of [STANDARD_PIPELINE, branchOnly, direct]) {
      expect(problemsOf(pipeline, RUNGS)).toEqual([]);
    }
    expect(workspaceOf(STANDARD_PIPELINE)).toEqual(["author", "worktree"]);
    expect(workspaceOf(branchOnly)).toEqual(["author", "branch"]);
    expect(workspaceOf(direct)).toEqual(["author", "none"]);
  });

  test("a task in flight places at the same block as before the workspace blocks", () => {
    const old = drop(drop(STANDARD_PIPELINE, "worktree", "retry"), "branch", "retry");
    for (const over of [
      {},
      { status: "in_progress" as const },
      { status: "reviewing" as const, passed: new Set(["author"]) },
      { status: "reviewing" as const, passed: new Set(["author", "review"]), approved: true },
    ]) {
      expect(at(STANDARD_PIPELINE, over)).toEqual(at(old, over));
    }
  });

  test("a direct task completes at done after its review", () => {
    expect(
      workspaceOf(direct, { status: "reviewing", passed: new Set(["author", "review"]) }),
    ).toEqual(["land", "none"]);
  });

  test("refuses a worktree with no branch before it", () => {
    expect(problemsOf(drop(STANDARD_PIPELINE, "branch", "worktree"), RUNGS)).toEqual([
      "a route from queue reaches worktree with no branch before it",
      "a route from queue reaches land with no branch before it",
    ]);
  });

  test("refuses a land with no branch before it", () => {
    expect(problemsOf(drop(branchOnly, "branch", "retry"), RUNGS)).toEqual([
      "a route from queue reaches land with no branch before it",
    ]);
  });

  test("refuses a route from a branch that ends at done", () => {
    expect(problemsOf(swap(STANDARD_PIPELINE, { kind: "done", id: "land" }), RUNGS)).toEqual([
      "a route from branch ends at land: work on this branch never lands",
    ]);
  });

  test("refuses a done that skips review, or that no gate stands before", () => {
    const unreviewed = swap(direct, {
      kind: "agent",
      id: "author",
      role: "author",
      model: "ladder",
      next: "land-gate",
    });
    expect(problemsOf(unreviewed, RUNGS)).toContain(
      "a route from author reaches land with no review after it",
    );
    const ungated = swap(direct, {
      kind: "agent",
      id: "review",
      role: "review",
      model: "above",
      next: "land",
    });
    expect(problemsOf(ungated, RUNGS)).toContain(
      "a route from review reaches land through no gate",
    );
  });
});
