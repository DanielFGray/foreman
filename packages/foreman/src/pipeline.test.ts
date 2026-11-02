import { describe, expect, test } from "bun:test";
import type { Run } from "tasks";
import { checkRun, authorDone, reviewRun } from "./task-fixture.ts";
import {
  type AgentNode,
  type CheckNode,
  type Exit,
  type Facts,
  matches,
  nextAgent,
  type Pipeline,
  type PipelineNode,
  place,
  problemsOf,
  QUEUE,
  routeWorkspace,
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
  tip: "c1",
  running: undefined,
  named: [],
  // The last exit named, as `factsOf` reads it, unless the test states it.
  exit: over.named?.at(-1)?.name,
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

/** The block with each exit that does not return to the queue wired to `to`. */
const onward = <N extends AgentNode | CheckNode>(node: N, to: string): N => ({
  ...node,
  exits: node.exits.map((exit) => (exit.to === QUEUE ? exit : { ...exit, to })),
});

describe("filters", () => {
  const returned = { node: "review", name: "returned", commit: "c1" };
  const approvedExit = { node: "review", name: "approved", commit: "c1" };

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
    ["exit:returned", { exit: "returned" }, true],
    ["exit:returned", { exit: "approved" }, false],
    ["exits:returned>=2", { named: [returned, returned] }, true],
    ["exits:returned>=2", { named: [returned, approvedExit] }, false],
    ["exits:returned=0", {}, true],
  ])("%p on %p is %p", (filter, over, expected) => {
    expect(matches(facts(over), filter)).toBe(expected);
  });
});

describe("facts read from labels and runs", () => {
  test("names failures, attempts, size, the exits and the open run", () => {
    const read = factsOf(
      {
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
        runs: [authorDone("cheap"), reviewRun("strong", { ending: "approved", commit: "c1" })],
        tip: "c1",
      },
      STANDARD_PIPELINE,
    );
    expect([...read.failedBy]).toEqual(["cheap"]);
    expect(read.attempts).toBe(2);
    expect(read.size).toBe(3);
    expect(read.named).toEqual([
      { node: "author", name: "done", commit: undefined },
      { node: "review", name: "approved", commit: "c1" },
    ]);
    expect(read.exit).toBe("approved");
    expect(read.running).toEqual({ node: "review", named: true });
    expect(read.epic).toBe("ep-1");
  });
});

describe("placement on the standard pipeline", () => {
  const done = { node: "author", name: "done", commit: "c1" };
  const approved = { node: "review", name: "approved", commit: "c1" };

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
      "a stopped attempt is a climb too",
      { attempts: 1 },
      { node: "author", state: "waiting", gates: ["climb"], ahead: 2 },
    ],
    [
      "work in flight with no exit named is running at the author",
      { status: "in_progress" },
      { node: "author", state: "running", gates: ["start"], ahead: 2 },
    ],
    [
      "an author that named done, with settle yet to record it, has ended at the author",
      { status: "in_progress", running: { node: "author", named: true } },
      { node: "author", state: "ended", gates: ["start"], ahead: 2 },
    ],
    [
      "a handoff with no exit named has ended at the author",
      { status: "reviewing" },
      { node: "author", state: "ended", gates: ["start"], ahead: 2 },
    ],
    [
      "after the author's done it waits for the review gate",
      { status: "reviewing", named: [done] },
      { node: "review", state: "waiting", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "a reviewer at work is running",
      { status: "reviewing", named: [done], running: { node: "review", named: false } },
      { node: "review", state: "running", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "an approval settle has not yet recorded has ended the review",
      { status: "reviewing", named: [done], running: { node: "review", named: true } },
      { node: "review", state: "ended", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "after the review's approved it waits for the land gate",
      { status: "reviewing", named: [done, approved] },
      { node: "land", state: "waiting", gates: ["land-gate"], ahead: 0 },
    ],
    [
      "an earlier exit at a block the pipeline no longer has changes nothing",
      { status: "reviewing", named: [{ node: "deleted-block", name: "done", commit: "c1" }, done] },
      { node: "review", state: "waiting", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "a last exit at a block the pipeline no longer has walks from the source",
      { status: "reviewing", named: [done, { node: "deleted-block", name: "done", commit: "c1" }] },
      { node: "author", state: "waiting", gates: ["start"], ahead: 2 },
    ],
    [
      "a last exit the block no longer declares walks from the source",
      { status: "reviewing", named: [{ node: "author", name: "gone", commit: "c1" }] },
      { node: "author", state: "waiting", gates: ["start"], ahead: 2 },
    ],
    [
      "a commit after the approval places the task at review again",
      { status: "reviewing", named: [done, approved], tip: "c2" },
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
      {
        kind: "agent",
        id: "write",
        role: "author",
        model: "ladder",
        exits: [
          { name: "done", to: "check" },
          { name: "already-done", to: "check" },
        ],
      },
      { kind: "gate", id: "check", step: "review", next: "read" },
      {
        kind: "agent",
        id: "read",
        role: "review",
        model: "above",
        exits: [
          { name: "approved", to: "ship" },
          { name: "returned", to: "queue", fails: "author" },
        ],
      },
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
          exits: [
            { name: "approved", to: "land-gate" },
            { name: "returned", to: "queue", fails: "author" },
          ],
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
          exits: [
            { name: "done", to: "review-gate" },
            { name: "already-done", to: "review-gate" },
          ],
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
    expect(problems[0]).toMatch(/^the wires loop through .*author.*nothing ends the loop/);
    expect(problems).toContain("no source reaches land");
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
        {
          kind: "agent",
          id: "review",
          role: "review",
          model: "above",
          exits: [
            { name: "approved", to: "g2" },
            { name: "returned", to: "queue", fails: "author" },
          ],
        },
        { kind: "gate", id: "g2", step: "author", next: "author" },
        {
          kind: "agent",
          id: "author",
          role: "author",
          model: "ladder",
          exits: [
            { name: "done", to: "g3" },
            { name: "already-done", to: "g3" },
          ],
        },
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
        replace({
          kind: "agent",
          id: "review",
          role: "review",
          model: "above",
          exits: [
            { name: "approved", to: "land" },
            { name: "returned", to: "queue", fails: "author" },
          ],
        }),
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
            onward(node, "lint-gate"),
            { kind: "gate", id: "lint-gate", step: "review", next: "lint" },
            {
              kind: "check",
              id: "lint",
              command: "bun run lint",
              exits: [
                { name: "passed", to: "review-gate" },
                { name: "failed", to: "queue", fails: "author" },
              ],
            },
          ]
        : [node],
    ),
  };
  const handedOver = (runs: ReadonlyArray<Run>, tip: string) =>
    place(
      checked,
      factsOf(
        {
          status: "reviewing",
          priority: 1,
          parent: undefined,
          labels: [],
          runs: [authorDone("cheap", "c1"), ...runs],
          tip,
        },
        checked,
      ),
    );
  const nodeOf = (placement: ReturnType<typeof place>) =>
    placement._tag === "At" ? `${placement.node.id} ${placement.state}` : placement._tag;

  test("is valid where a gate stands before it and an author before that", () => {
    expect(problemsOf(checked, RUNGS)).toEqual([]);
  });

  test("waits after the author hands off, and counts as a block ahead", () => {
    expect(at(checked, {})).toMatchObject({ node: "author", ahead: 3 });
    expect(
      at(checked, { status: "reviewing", named: [{ node: "author", name: "done", commit: "c1" }] }),
    ).toEqual({
      node: "lint",
      state: "waiting",
      gates: ["lint-gate"],
      ahead: 2,
    });
  });

  test("passes the commit its command passed on, and only that commit", () => {
    expect(nodeOf(handedOver([], "c1"))).toBe("lint waiting");
    expect(nodeOf(handedOver([checkRun("lint", "c1", "passed")], "c1"))).toBe("review waiting");
    // The check's failed exit returns the task to the queue, so it walks from the source.
    expect(nodeOf(handedOver([checkRun("lint", "c1", "failed")], "c1"))).toBe("author waiting");
    // A commit after the check places the task at the check again.
    expect(nodeOf(handedOver([checkRun("lint", "c1", "passed")], "c2"))).toBe("lint waiting");
  });

  test("is no review: a land past a check and no reviewer is refused", () => {
    const unreviewed: Pipeline = {
      nodes: checked.nodes
        .filter((node) => node.id !== "review" && node.id !== "review-gate")
        .map((node) =>
          node.id === "lint" && node.kind === "check" ? onward(node, "land-gate") : node,
        ),
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
        .map((node) =>
          node.id === "author" && node.kind === "agent" ? onward(node, "lint") : node,
        ),
    };
    expect(problemsOf(ungated, RUNGS)).toEqual([
      "a route from author reaches lint through no gate",
    ]);

    const first: Pipeline = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "branch" },
        { kind: "worktree", id: "worktree", next: "g0" },
        { kind: "gate", id: "g0", step: "author", next: "lint" },
        {
          kind: "check",
          id: "lint",
          command: "bun run lint",
          exits: [
            { name: "passed", to: "start" },
            { name: "failed", to: "queue", fails: "author" },
          ],
        },
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
    // The author's done and already-done are two arrows to the same gate.
    expect(lines.filter((line) => line.includes("-->"))).toHaveLength(13);
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
    return placement._tag === "At"
      ? [placement.node.id, routeWorkspace(pipeline, facts(over))]
      : placement._tag;
  };

  test("each of the three shapes is valid, and places the agent in its workspace", () => {
    for (const pipeline of [STANDARD_PIPELINE, branchOnly, direct]) {
      expect(problemsOf(pipeline, RUNGS)).toEqual([]);
    }
    expect(workspaceOf(STANDARD_PIPELINE)).toEqual(["author", "worktree"]);
    expect(workspaceOf(branchOnly)).toEqual(["author", "branch"]);
    expect(workspaceOf(direct)).toEqual(["author", "none"]);
  });

  const done = { node: "author", name: "done", commit: "c1" };
  const approved = { node: "review", name: "approved", commit: "c1" };

  test("a task in flight places at the same block as before the workspace blocks", () => {
    const old = drop(drop(STANDARD_PIPELINE, "worktree", "retry"), "branch", "retry");
    for (const over of [
      {},
      { status: "in_progress" as const },
      { status: "reviewing" as const, named: [done] },
      { status: "reviewing" as const, named: [done, approved] },
    ]) {
      expect(at(STANDARD_PIPELINE, over)).toEqual(at(old, over));
    }
  });

  test("a direct task completes at done after its review", () => {
    expect(workspaceOf(direct, { status: "reviewing", named: [done, approved] })).toEqual([
      "land",
      "none",
    ]);
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
      exits: [
        { name: "done", to: "land-gate" },
        { name: "already-done", to: "land-gate" },
      ],
    });
    expect(problemsOf(unreviewed, RUNGS)).toContain(
      "a route from author reaches land with no review after it",
    );
    const ungated = swap(direct, {
      kind: "agent",
      id: "review",
      role: "review",
      model: "above",
      exits: [
        { name: "approved", to: "land" },
        { name: "returned", to: "queue", fails: "author" },
      ],
    });
    expect(problemsOf(ungated, RUNGS)).toContain(
      "a route from review reaches land through no gate",
    );
  });
});

test("refuses a workspace block after an agent", () => {
  const late: Pipeline = {
    nodes: STANDARD_PIPELINE.nodes
      .map((node) =>
        node.id === "author" && node.kind === "agent"
          ? onward(node, "late")
          : node.id === "queue"
            ? { ...node, next: "retry" }
            : node,
      )
      .filter((node) => node.id !== "branch" && node.id !== "worktree")
      .concat([{ kind: "branch", id: "late", next: "review-gate" }]),
  };
  expect(problemsOf(late, RUNGS)).toEqual([
    "a route from author reaches late: a route's workspace is set before its first agent",
  ]);
});

describe("a cycle", () => {
  // The review sends a returned task straight back to the author's gate, a
  // wire inside the graph rather than a return to the queue.
  const looped = (returned: Exit): Pipeline => ({
    nodes: STANDARD_PIPELINE.nodes.map((node) =>
      node.id === "review" && node.kind === "agent"
        ? { ...node, exits: [{ name: "approved", to: "land-gate" }, returned] }
        : node,
    ),
  });

  test("is a problem when no exit on it fails a rung and no router leaves it on a count", () => {
    expect(problemsOf(looped({ name: "returned", to: "start" }), RUNGS)).toEqual([
      "the wires loop through author, start, review, review-gate, and nothing ends the loop: no exit on it fails a rung, and no router leaves it on a count that grows",
    ]);
  });

  test("is valid when an exit on it fails a rung", () => {
    expect(problemsOf(looped({ name: "returned", to: "start", fails: "author" }), RUNGS)).toEqual(
      [],
    );
  });

  test("is valid when a router leaves it on a count of exits", () => {
    const counted: Pipeline = {
      nodes: [
        ...looped({ name: "returned", to: "count" }).nodes,
        {
          kind: "router",
          id: "count",
          routes: [{ when: "exits:returned>=3", to: "operator" }],
          else: "start",
        },
        { kind: "park", id: "operator" },
      ],
    };
    expect(problemsOf(counted, RUNGS)).toEqual([]);
  });

  test("is a problem when its router counts an exit no block on it declares", () => {
    const miscounted: Pipeline = {
      nodes: [
        ...looped({ name: "returned", to: "count" }).nodes,
        {
          kind: "router",
          id: "count",
          routes: [{ when: "exits:rejected>=3", to: "operator" }],
          else: "start",
        },
        { kind: "park", id: "operator" },
      ],
    };
    expect(problemsOf(miscounted, RUNGS)).toEqual([
      "the wires loop through author, start, count, review, review-gate, and nothing ends the loop: no exit on it fails a rung, and no router leaves it on a count that grows",
    ]);
  });

  test("of only routers and gates is a problem", () => {
    const spin: Pipeline = {
      nodes: [
        ...STANDARD_PIPELINE.nodes.map((node) =>
          node.id === "climb" && node.kind === "gate" ? { ...node, next: "spin" } : node,
        ),
        {
          kind: "router",
          id: "spin",
          routes: [{ when: "attempts>=3", to: "author" }],
          else: "climb",
        },
      ],
    };
    expect(problemsOf(spin, RUNGS)).toContainEqual(
      "the wires loop through climb, spin with no work block on the loop",
    );
  });
});

describe("exits", () => {
  const replace = (node: PipelineNode): Pipeline => ({
    nodes: STANDARD_PIPELINE.nodes.map((n) => (n.id === node.id ? node : n)),
  });
  const review = (exits: ReadonlyArray<Exit>): PipelineNode => ({
    kind: "agent",
    id: "review",
    role: "review",
    model: "above",
    exits,
  });

  test("an agent names at least one, each unique, lower-case and wired", () => {
    expect(problemsOf(replace(review([])), RUNGS)).toContain(
      "review: an agent names an exit to end its run, and it declares none",
    );
    expect(
      problemsOf(
        replace(
          review([
            { name: "approved", to: "land-gate" },
            { name: "approved", to: "queue" },
            { name: "Bad_Name", to: "land-gate" },
            { name: "stopped", to: "land-gate" },
            { name: "loose", to: "nowhere" },
          ]),
        ),
        RUNGS,
      ),
    ).toEqual([
      "review is wired to nowhere, which is no block",
      "review: two exits are named approved",
      "review: the exit Bad_Name is not lower-case words and hyphens",
      "review: stopped is how a run stops with no exit, not an exit",
    ]);
  });
});
