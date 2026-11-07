import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import type { Run } from "tasks";
import { authorDone, authorRun, charged, checkRun, reviewRun, stoppedRun } from "./task-fixture.ts";
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
  type SeatOffers,
  QUEUE,
  routeTarget,
  routeWorkspace,
  targetsOf,
  type Landing,
  LANDINGS,
  type Standard,
  standardOf,
  standardPipeline,
  DEFAULT_PIPELINE,
  STANDARD_PIPELINES,
  WORKSPACE_CHOICES,
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
  exitNode: over.named?.at(-1)?.node,
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

const OFFERS: SeatOffers = {
  rungs: ["cheap", "strong"].map((name) => ({ name, author: true })),
  reviewers: ["sharp"],
};

/** The block with each exit that does not return to the queue wired to `to`. */
const onward = <N extends AgentNode | CheckNode>(node: N, to: string): N => ({
  ...node,
  exits: node.exits.map((exit) => (exit.to === QUEUE ? exit : { ...exit, to })),
});

describe("filters", () => {
  const returned = { node: "review", id: "returned", name: "returned", commit: "c1" };
  const approvedExit = { node: "review", id: "approved", name: "approved", commit: "c1" };

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

describe("facts read from labels, runs and charges", () => {
  test("names failures, attempts, size, the exits and the open run", () => {
    // Two stopped runs on strong are two attempts; a released run on x is none.
    const cheap = authorDone("cheap");
    const read = factsOf(
      {
        status: "in_progress",
        priority: 1,
        parent: Option.some("ep-1"),
        labels: ["size:3"],
        runs: [
          stoppedRun("strong"),
          stoppedRun("strong"),
          authorRun("x", { open: false, ending: "released" }),
          cheap,
          reviewRun("strong", { ending: "approved", commit: "c1" }),
        ],
        charges: [charged("cheap", cheap.id)],
        tip: "c1",
      },
      STANDARD_PIPELINES.worktree,
    );
    expect([...read.failedBy]).toEqual(["cheap"]);
    expect(read.attempts).toBe(2);
    expect(read.size).toBe(3);
    expect(read.named).toEqual([
      { node: "author", id: "done", name: "done", commit: undefined },
      { node: "review", id: "approved", name: "approved", commit: "c1" },
    ]);
    expect(read.exit).toBe("approved");
    expect(read.running).toEqual({ node: "review", named: true });
    expect(read.epic).toBe("ep-1");
  });
});

describe("the block a board draws a task on", () => {
  const done = { node: "author", id: "done", name: "done", commit: "c1" };
  const stands = (over: Partial<Facts>) => {
    const placement = place(STANDARD_PIPELINES.worktree, facts(over));
    return placement._tag === "At" ? placement.stands : placement._tag;
  };

  test.each<[string, Partial<Facts>, string]>([
    ["a task that has not started stands at the queue", {}, "queue"],
    ["a failed task stands at the climb gate", { failedBy: new Set(["cheap"]) }, "climb"],
    ["a stopped attempt stands at the climb gate", { attempts: 1 }, "climb"],
    [
      "a finished author stands at the review gate",
      { status: "in_progress", named: [done] },
      "review-gate",
    ],
    ["a running author stands at the author", { status: "in_progress" }, "author"],
  ])("%s", (_name, over, expected) => {
    expect(stands(over)).toBe(expected);
  });
});

describe("placement on the standard pipeline", () => {
  const done = { node: "author", id: "done", name: "done", commit: "c1" };
  const approved = { node: "review", id: "approved", name: "approved", commit: "c1" };

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
      "after the author's done it waits for the review gate",
      { status: "in_progress", named: [done] },
      { node: "review", state: "waiting", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "a returned review waits at the author behind climb",
      {
        status: "in_progress",
        named: [done, { node: "review", id: "returned", name: "returned", commit: "c1" }],
        failedBy: new Set(["cheap"]),
      },
      { node: "author", state: "waiting", gates: ["climb"], ahead: 2 },
    ],
    [
      "a reviewer at work is running",
      { status: "in_progress", named: [done], running: { node: "review", named: false } },
      { node: "review", state: "running", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "an approval settle has not yet recorded has ended the review",
      { status: "in_progress", named: [done], running: { node: "review", named: true } },
      { node: "review", state: "ended", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "after the review's approved it waits for the land gate",
      { status: "in_progress", named: [done, approved] },
      { node: "land", state: "waiting", gates: ["land-gate"], ahead: 0 },
    ],
    [
      "an earlier exit at a block the pipeline no longer has changes nothing",
      {
        status: "in_progress",
        named: [{ node: "deleted-block", id: "done", name: "done", commit: "c1" }, done],
      },
      { node: "review", state: "waiting", gates: ["review-gate"], ahead: 1 },
    ],
    [
      "a last exit at a block the pipeline no longer has places nowhere, for the operator to answer",
      {
        status: "in_progress",
        named: [done, { node: "deleted-block", id: "done", name: undefined, commit: "c1" }],
      },
      {
        _tag: "ExitGone",
        node: "deleted-block",
        exit: "done",
        reason:
          "the pipeline no longer has the block deleted-block, where the task's run named done",
      },
    ],
    [
      "a last exit the block no longer declares places nowhere, for the operator to answer",
      {
        status: "in_progress",
        named: [{ node: "author", id: "gone", name: undefined, commit: "c1" }],
      },
      {
        _tag: "ExitGone",
        node: "author",
        exit: "gone",
        reason: "author no longer has the exit gone the task's run named there",
      },
    ],
    [
      "an agent at work past a lost exit stands at its block",
      {
        status: "in_progress",
        named: [{ node: "author", id: "gone", name: undefined, commit: "c1" }],
        running: { node: "review", named: false },
      },
      { node: "review", state: "running", gates: [], ahead: 1 },
    ],
    [
      "a commit after the approval places the task at review again",
      { status: "in_progress", named: [done, approved], tip: "c2" },
      { node: "review", state: "waiting", gates: ["review-gate"], ahead: 1 },
    ],
  ])("%s", (_, over, expected) => {
    expect(at(STANDARD_PIPELINES.worktree, over)).toEqual(expected);
  });

  test.each(["done", "canceled", "proposed", "draft", "blocked"] as const)(
    "a %s task is outside the flow",
    (status) => {
      expect(place(STANDARD_PIPELINES.worktree, facts({ status }))._tag).toBe("Outside");
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
          { id: "done", name: "done", to: "check" },
          { id: "already-done", name: "already-done", to: "check" },
        ],
      },
      { kind: "gate", id: "check", step: "review", next: "read" },
      {
        kind: "agent",
        id: "read",
        role: "review",
        model: "reviewers",
        exits: [
          { id: "approved", name: "approved", to: "ship" },
          { id: "returned", name: "returned", to: "queue", fails: "author" },
        ],
      },
      { kind: "gate", id: "ship", step: "land", next: "land" },
      { kind: "land", id: "land" },
    ],
  };

  test("is valid", () => {
    expect(problemsOf(triage, OFFERS)).toEqual([]);
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
    expect(nextAgent(STANDARD_PIPELINES.worktree, facts(), "author")?.id).toBe("author");
    // A review started before the author handed off still runs at the review
    // block: the blocks before it count as passed.
    expect(nextAgent(STANDARD_PIPELINES.worktree, facts(), "review")?.id).toBe("review");
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

// An acyclic drawing lets each invalid-route test introduce its own defect.
const forwardPipeline: Pipeline = {
  nodes: STANDARD_PIPELINES.worktree.nodes.map((node) =>
    node.kind === "agent" && node.role === "review"
      ? {
          ...node,
          exits: [
            { id: "approved", name: "approved", to: "land-gate" },
            { id: "returned", name: "returned", to: "queue", fails: "author" },
          ],
        }
      : node,
  ),
};

describe("validation", () => {
  const without = (...ids: string[]) => forwardPipeline.nodes.filter((n) => !ids.includes(n.id));
  const replace = (node: PipelineNode): Pipeline => ({
    nodes: forwardPipeline.nodes.map((n) => (n.id === node.id ? node : n)),
  });
  const reviewBlock = forwardPipeline.nodes.find(
    (node): node is AgentNode => node.kind === "agent" && node.role === "review",
  )!;

  test("the standard pipeline is valid", () => {
    expect(problemsOf(STANDARD_PIPELINES.worktree, OFFERS)).toEqual([]);
  });

  describe("a pull-request land", () => {
    // The standard worktree pipeline landing by pull request, with `gates`
    // between its review and its land.
    const landingBy = (gates: ReadonlyArray<"publish" | "land">): Pipeline => {
      const ids = gates.map((step) => `${step}-gate`);
      return {
        nodes: [
          ...STANDARD_PIPELINES.worktree.nodes.flatMap((node): ReadonlyArray<PipelineNode> =>
            node.kind === "land"
              ? [{ ...node, how: "pull-request" }]
              : node.kind === "gate" && node.step === "land"
                ? []
                : node.kind === "agent" && node.role === "review"
                  ? [
                      {
                        ...node,
                        exits: node.exits.map((exit) =>
                          exit.to === "land-gate" ? { ...exit, to: ids[0] ?? "land" } : exit,
                        ),
                      },
                    ]
                  : [node],
          ),
          ...gates.map((step, at) => ({
            kind: "gate" as const,
            id: ids[at]!,
            step,
            next: ids[at + 1] ?? "land",
          })),
        ],
      };
    };

    test("is valid with a publish gate and a land gate after the review", () => {
      expect(problemsOf(landingBy(["publish", "land"]), OFFERS)).toEqual([]);
    });

    test("names the gate it is missing", () => {
      expect(problemsOf(landingBy(["land"]), OFFERS)).toContain(
        "a route from review reaches land with no publish gate after it",
      );
      expect(problemsOf(landingBy(["publish"]), OFFERS)).toContain(
        "a route from review reaches land with no land gate after it",
      );
    });

    test("refuses a publish gate before a land that merges in the checkout", () => {
      const pipeline = landingBy(["publish", "land"]);
      const merging = {
        nodes: pipeline.nodes.map((node) =>
          node.kind === "land" ? { ...node, how: "merge" as const } : node,
        ),
      };
      expect(problemsOf(merging, OFFERS)).toContain(
        "publish-gate gates publish, but no route from it reaches a pull-request land",
      );
    });
  });

  test("the default pipeline works in the operator's checkout on the task's branch", () => {
    expect(DEFAULT_PIPELINE).toBe(STANDARD_PIPELINES.checkout);
    const kinds = DEFAULT_PIPELINE.nodes.map((node) => node.kind);
    expect(kinds).toContain("branch");
    expect(kinds).not.toContain("worktree");
  });

  test("each standard pipeline is valid, and is named by its blocks", () => {
    const standards: ReadonlyArray<Standard> = [
      { workspace: "direct" },
      ...(["checkout", "worktree"] as const).flatMap((workspace) =>
        LANDINGS.flatMap((how) => [
          { workspace, how },
          { workspace, how, onto: "develop" },
        ]),
      ),
    ];
    for (const standard of standards) {
      const pipeline = standardPipeline(standard);
      expect(problemsOf(pipeline, OFFERS)).toEqual([]);
      expect(standardOf(pipeline)).toEqual(Option.some(standard));
      expect(standardOf({ nodes: pipeline.nodes.toReversed() })).toEqual(Option.some(standard));
    }
    for (const choice of WORKSPACE_CHOICES) {
      expect(standardOf(STANDARD_PIPELINES[choice])).toEqual(
        Option.some(
          choice === "direct" ? { workspace: choice } : { workspace: choice, how: "merge" },
        ),
      );
    }
    const kinds = STANDARD_PIPELINES.direct.nodes.map((node) => node.kind);
    expect(kinds).not.toContain("branch");
    expect(kinds).toContain("done");
    const pinned = {
      nodes: DEFAULT_PIPELINE.nodes.map((node) =>
        node.id === "author" ? { ...node, model: "cheap" } : node,
      ),
    };
    expect(standardOf(pinned)).toEqual(Option.none());
  });

  test("a standard pull-request land is behind a publish gate, and no other land is", () => {
    const gates = (how: Landing) =>
      standardPipeline({ workspace: "worktree", how }).nodes.flatMap((node) =>
        node.kind === "gate" ? [node.step] : [],
      );
    expect(gates("pull-request")).toContain("publish");
    expect(gates("merge")).not.toContain("publish");
    expect(gates("fast-forward")).not.toContain("publish");
  });

  test("names a duplicate block, a loose wire and a filter that means nothing", () => {
    const problems = problemsOf(
      {
        nodes: [
          { kind: "source", id: "queue", filter: "kind:failed-by", next: "nowhere" },
          { kind: "land", id: "queue" },
        ],
      },
      OFFERS,
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
            { id: "approved", name: "approved", to: "land-gate" },
            { id: "returned", name: "returned", to: "queue", fails: "author" },
          ],
        }),
        OFFERS,
      ),
    ).toEqual(["review: a reviewer reads from the reviewers, not from the ladder"]);
    expect(
      problemsOf(
        replace({
          kind: "agent",
          id: "author",
          role: "author",
          model: "gone",
          exits: [
            { id: "done", name: "done", to: "review-gate" },
            { id: "already-done", name: "already-done", to: "review-gate" },
          ],
        }),
        OFFERS,
      ),
    ).toEqual(["author: gone is no rung on the ladder"]);
    expect(
      problemsOf(
        replace({
          kind: "agent",
          id: "author",
          role: "author",
          model: "cheap",
          exits: [
            { id: "done", name: "done", to: "review-gate" },
            { id: "already-done", name: "already-done", to: "review-gate" },
          ],
        }),
        {
          rungs: [
            { name: "cheap", author: false },
            { name: "strong", author: true },
          ],
          reviewers: [],
        },
      ),
    ).toEqual(["author: cheap may not author"]);
    // A rung and a reviewer are separate lists, even when both name the same model.
    expect(problemsOf(replace({ ...reviewBlock, model: "strong" }), OFFERS)).toEqual([
      "review: strong is no reviewer",
    ]);
    expect(problemsOf(replace({ ...reviewBlock, model: "sharp" }), OFFERS)).toEqual([]);
    expect(
      problemsOf(
        replace({
          kind: "agent",
          id: "author",
          role: "author",
          model: "reviewers",
          exits: [
            { id: "done", name: "done", to: "review-gate" },
            { id: "already-done", name: "already-done", to: "review-gate" },
          ],
        }),
        OFFERS,
      ),
    ).toEqual(["author: an author writes from the ladder, not from the reviewers"]);
  });

  test("refuses a review exit that fails the reviewer itself", () => {
    const selfFailing = replace({
      ...reviewBlock,
      exits: reviewBlock.exits.map((exit) =>
        exit.name === "returned" ? { ...exit, fails: "self" as const } : exit,
      ),
    });
    expect(problemsOf(selfFailing, OFFERS)).toContain(
      "review: a reviewer is no rung, so returned has none to fail",
    );
  });

  test("refuses a wire back to an earlier block that nothing lets leave the loop", () => {
    const problems = problemsOf(
      replace({ kind: "gate", id: "land-gate", step: "land", next: "author" }),
      OFFERS,
    );
    expect(problems[0]).toMatch(/^the wires loop through .*author.*nothing ends the loop/);
    expect(problems).toContain("no source reaches land");
  });

  test("refuses a route to a land that skips review", () => {
    expect(
      problemsOf(
        replace({ kind: "gate", id: "review-gate", step: "review", next: "land" }),
        OFFERS,
      ),
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
          model: "reviewers",
          exits: [
            { id: "approved", name: "approved", to: "g2" },
            { id: "returned", name: "returned", to: "queue", fails: "author" },
          ],
        },
        { kind: "gate", id: "g2", step: "author", next: "author" },
        {
          kind: "agent",
          id: "author",
          role: "author",
          model: "ladder",
          exits: [
            { id: "done", name: "done", to: "g3" },
            { id: "already-done", name: "already-done", to: "g3" },
          ],
        },
        { kind: "gate", id: "g3", step: "land", next: "land" },
        { kind: "land", id: "land" },
      ],
    };
    expect(problemsOf(backwards, OFFERS)).toEqual([
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
          model: "reviewers",
          exits: [
            { id: "approved", name: "approved", to: "land" },
            { id: "returned", name: "returned", to: "queue", fails: "author" },
          ],
        }),
        OFFERS,
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
        OFFERS,
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
    expect(problemsOf(ungated, OFFERS)).toEqual([
      "a route from queue reaches author through no gate",
    ]);
  });
});

describe("a check block", () => {
  // The forward drawing with a check between the author and the review.
  const checked: Pipeline = {
    nodes: forwardPipeline.nodes.flatMap((node): ReadonlyArray<PipelineNode> =>
      node.kind === "agent" && node.id === "author"
        ? [
            onward(node, "lint-gate"),
            { kind: "gate", id: "lint-gate", step: "review", next: "lint" },
            {
              kind: "check",
              id: "lint",
              command: "bun run lint",
              exits: [
                { id: "passed", name: "passed", to: "review-gate" },
                { id: "failed", name: "failed", to: "queue", fails: "author" },
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
          status: "in_progress",
          priority: 1,
          parent: Option.none(),
          labels: [],
          runs: [authorDone("cheap", "c1"), ...runs],
          charges: [],
          tip,
        },
        checked,
      ),
    );
  const nodeOf = (placement: ReturnType<typeof place>) =>
    placement._tag === "At" ? `${placement.node.id} ${placement.state}` : placement._tag;

  test("is valid where a gate stands before it and an author before that", () => {
    expect(problemsOf(checked, OFFERS)).toEqual([]);
  });

  test("waits after the author hands off, and counts as a block ahead", () => {
    expect(at(checked, {})).toMatchObject({ node: "author", ahead: 3 });
    expect(
      at(checked, {
        status: "in_progress",
        named: [{ node: "author", id: "done", name: "done", commit: "c1" }],
      }),
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
    expect(nodeOf(handedOver([checkRun("lint", "c1", "failed")], "c1"))).toBe("author running");
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
    expect(problemsOf(unreviewed, OFFERS)).toEqual([
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
    expect(problemsOf(ungated, OFFERS)).toEqual([
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
            { id: "passed", name: "passed", to: "start" },
            { id: "failed", name: "failed", to: "queue", fails: "author" },
          ],
        },
        ...forwardPipeline.nodes.filter(
          (node) => !["queue", "worktree", "retry", "climb"].includes(node.id),
        ),
      ],
    };
    expect(problemsOf(first, OFFERS)).toEqual([
      "a route from queue reaches lint with no author before it",
    ]);

    const silent: Pipeline = {
      nodes: checked.nodes.map((node) => (node.id === "lint" ? { ...node, command: " " } : node)),
    };
    expect(problemsOf(silent, OFFERS)).toEqual(["lint: a check runs a command, and it names none"]);
  });

  test("is drawn with its command", () => {
    expect(toMermaid(checked)).toContain("lint: runs bun run lint");
  });
});

describe("the Mermaid drawing", () => {
  test("draws every block and one arrow per wire", () => {
    const lines = toMermaid(STANDARD_PIPELINES.worktree).split("\n");
    expect(lines[0]).toBe("flowchart LR");
    // The author's done and already-done are two arrows to the same gate.
    expect(lines.filter((line) => line.includes("-->"))).toHaveLength(14);
    expect(lines.some((line) => line.includes('"failed"'))).toBe(true);
    expect(lines.some((line) => line.includes("author: author on ladder"))).toBe(true);
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
  const branchOnly = drop(STANDARD_PIPELINES.worktree, "worktree", "retry");
  const direct = swap(drop(branchOnly, "branch", "retry"), { kind: "done", id: "land" });
  const workspaceOf = (pipeline: Pipeline, over: Partial<Facts> = {}) => {
    const placement = place(pipeline, facts(over));
    return placement._tag === "At"
      ? [placement.node.id, routeWorkspace(pipeline, facts(over))]
      : placement._tag;
  };

  test("each of the three shapes is valid, and places the agent in its workspace", () => {
    for (const pipeline of [STANDARD_PIPELINES.worktree, branchOnly, direct]) {
      expect(problemsOf(pipeline, OFFERS)).toEqual([]);
    }
    expect(workspaceOf(STANDARD_PIPELINES.worktree)).toEqual(["author", "worktree"]);
    expect(workspaceOf(branchOnly)).toEqual(["author", "branch"]);
    expect(workspaceOf(direct)).toEqual(["author", "none"]);
  });

  const done = { node: "author", id: "done", name: "done", commit: "c1" };
  const approved = { node: "review", id: "approved", name: "approved", commit: "c1" };

  test("a task in flight places at the same block as before the workspace blocks", () => {
    const old = drop(drop(STANDARD_PIPELINES.worktree, "worktree", "retry"), "branch", "retry");
    for (const over of [
      {},
      { status: "in_progress" as const },
      { status: "in_progress" as const, named: [done] },
      { status: "in_progress" as const, named: [done, approved] },
    ]) {
      expect(at(STANDARD_PIPELINES.worktree, over)).toEqual(at(old, over));
    }
  });

  test("a direct task completes at done after its review", () => {
    expect(workspaceOf(direct, { status: "in_progress", named: [done, approved] })).toEqual([
      "land",
      "none",
    ]);
  });

  test("refuses a worktree with no branch before it", () => {
    expect(problemsOf(drop(STANDARD_PIPELINES.worktree, "branch", "worktree"), OFFERS)).toEqual([
      "a route from queue reaches worktree with no branch before it",
      "a route from queue reaches land with no branch before it",
    ]);
  });

  test("refuses a land with no branch before it", () => {
    expect(problemsOf(drop(branchOnly, "branch", "retry"), OFFERS)).toEqual([
      "a route from queue reaches land with no branch before it",
    ]);
  });

  test("refuses a route from a branch that ends at done", () => {
    expect(
      problemsOf(swap(STANDARD_PIPELINES.worktree, { kind: "done", id: "land" }), OFFERS),
    ).toEqual(["a route from branch ends at land: work on this branch never lands"]);
  });

  test("refuses a done that skips review, or that no gate stands before", () => {
    const unreviewed = swap(direct, {
      kind: "agent",
      id: "author",
      role: "author",
      model: "ladder",
      exits: [
        { id: "done", name: "done", to: "land-gate" },
        { id: "already-done", name: "already-done", to: "land-gate" },
      ],
    });
    expect(problemsOf(unreviewed, OFFERS)).toContain(
      "a route from author reaches land with no review after it",
    );
    const ungated = swap(direct, {
      kind: "agent",
      id: "review",
      role: "review",
      model: "reviewers",
      exits: [
        { id: "approved", name: "approved", to: "land" },
        { id: "returned", name: "returned", to: "queue", fails: "author" },
      ],
    });
    expect(problemsOf(ungated, OFFERS)).toContain(
      "a route from review reaches land through no gate",
    );
  });
});

test("refuses a workspace block after an agent", () => {
  const late: Pipeline = {
    nodes: forwardPipeline.nodes
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
  expect(problemsOf(late, OFFERS)).toEqual([
    "a route from author reaches late: a route's workspace is set before its first agent",
  ]);
});

describe("a cycle", () => {
  // The review sends a returned task straight back to the author's gate, a
  // wire inside the graph rather than a return to the queue.
  const looped = (returned: Exit): Pipeline => ({
    nodes: STANDARD_PIPELINES.worktree.nodes.map((node) =>
      node.id === "review" && node.kind === "agent"
        ? { ...node, exits: [{ id: "approved", name: "approved", to: "land-gate" }, returned] }
        : node,
    ),
  });

  test("is a problem when no exit on it fails a rung and no router leaves it on a count", () => {
    expect(problemsOf(looped({ id: "returned", name: "returned", to: "start" }), OFFERS)).toEqual([
      "the wires loop through author, start, review, review-gate, and nothing ends the loop: no exit on it fails a rung, and no router leaves it on a count that grows",
    ]);
  });

  test("is a problem when a lap that passes no charging exit can go round, inside a loop one charges", () => {
    const inner: Pipeline = {
      nodes: looped({ id: "returned", name: "returned", to: "start", fails: "author" }).nodes.map(
        (node) =>
          node.id === "author" && node.kind === "agent"
            ? { ...node, exits: [...node.exits, { id: "stuck", name: "stuck", to: "start" }] }
            : node,
      ),
    };
    expect(problemsOf(inner, OFFERS)).toEqual([
      "the wires loop through author, start, and nothing ends the loop: no exit on it fails a rung, and no router leaves it on a count that grows",
    ]);
  });

  test("is valid when an exit on it fails a rung", () => {
    expect(
      problemsOf(
        looped({ id: "returned", name: "returned", to: "start", fails: "author" }),
        OFFERS,
      ),
    ).toEqual([]);
  });

  test("is valid when a router leaves it on a count of exits", () => {
    const counted: Pipeline = {
      nodes: [
        ...looped({ id: "returned", name: "returned", to: "count" }).nodes,
        {
          kind: "router",
          id: "count",
          routes: [{ when: "exits:returned>=3", to: "operator" }],
          else: "start",
        },
        { kind: "park", id: "operator" },
      ],
    };
    expect(problemsOf(counted, OFFERS)).toEqual([]);
  });

  test("is a problem when its router counts an exit no block on it declares", () => {
    const miscounted: Pipeline = {
      nodes: [
        ...looped({ id: "returned", name: "returned", to: "count" }).nodes,
        {
          kind: "router",
          id: "count",
          routes: [{ when: "exits:rejected>=3", to: "operator" }],
          else: "start",
        },
        { kind: "park", id: "operator" },
      ],
    };
    // No block declares the exit, so the count never grows; that is reported
    // before the walk, as a filter that matches nothing.
    expect(problemsOf(miscounted, OFFERS)).toEqual([
      "count: the filter counts the exit rejected, and no block declares it",
    ]);
  });

  test("of only routers and gates is a problem", () => {
    const spin: Pipeline = {
      nodes: [
        ...forwardPipeline.nodes.map((node) =>
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
    expect(problemsOf(spin, OFFERS)).toContainEqual(
      "the wires loop through climb, spin with no work block on the loop",
    );
  });
});

describe("exits", () => {
  const replace = (node: PipelineNode): Pipeline => ({
    nodes: STANDARD_PIPELINES.worktree.nodes.map((n) => (n.id === node.id ? node : n)),
  });
  const review = (exits: ReadonlyArray<Exit>): PipelineNode => ({
    kind: "agent",
    id: "review",
    role: "review",
    model: "reviewers",
    exits,
  });

  test("an agent names at least one, each unique, lower-case and wired", () => {
    expect(problemsOf(replace(review([])), OFFERS)).toContain(
      "review: an agent names an exit to end its run, and it declares none",
    );
    expect(
      problemsOf(
        replace(
          review([
            { id: "approved", name: "approved", to: "land-gate" },
            { id: "approved", name: "approved", to: "queue" },
            { id: "Bad_Name", name: "Bad_Name", to: "land-gate" },
            { id: "stopped", name: "stopped", to: "land-gate" },
            { id: "loose", name: "loose", to: "nowhere" },
          ]),
        ),
        OFFERS,
      ),
    ).toEqual([
      "review is wired to nowhere, which is no block",
      "review: two exits are named approved",
      "review: two exits have the id approved",
      "review: the exit Bad_Name is not lower-case words and hyphens",
      'review: the exit Bad_Name has the id "Bad_Name", not lower-case letters and hyphens',
      "review: stopped is how a run stops with no exit, not an exit",
    ]);
  });

  const author = (exits: ReadonlyArray<Exit>): PipelineNode => ({
    kind: "agent",
    id: "author",
    role: "author",
    model: "ladder",
    exits,
  });

  test("an author has at most one claim, and it leads to a review", () => {
    expect(
      problemsOf(
        replace(
          author([
            { id: "done", name: "done", to: "review-gate", empty: "claim" },
            { id: "already-done", name: "already-done", to: "queue", empty: "claim" },
          ]),
        ),
        OFFERS,
      ),
    ).toEqual([
      "author: the claim already-done returns the task to the queue, and a claim leads to a review",
      "author: an author has at most one claim, and done, already-done are claims",
    ]);
    expect(
      problemsOf(
        replace(review([{ id: "approved", name: "approved", to: "land-gate", empty: "claim" }])),
        OFFERS,
      ),
    ).toContain("review: only an author claims trunk already does the task");
  });

  test("a claim that reaches another author or a park before a review is refused", () => {
    const second: PipelineNode = {
      kind: "agent",
      id: "second",
      role: "author",
      model: "ladder",
      exits: [{ id: "done", name: "done", to: "review-gate" }],
    };
    const pipeline: Pipeline = {
      nodes: [
        ...replace(
          author([
            { id: "done", name: "done", to: "review-gate" },
            { id: "already-done", name: "already-done", to: "second", empty: "claim" },
          ]),
        ).nodes,
        second,
      ],
    };
    expect(problemsOf(pipeline, OFFERS)).toContain(
      "author: the claim already-done reaches second before a review",
    );
    const parked: Pipeline = {
      nodes: [
        ...replace(
          author([
            { id: "done", name: "done", to: "review-gate" },
            { id: "already-done", name: "already-done", to: "operator", empty: "claim" },
          ]),
        ).nodes,
        { kind: "park", id: "operator" },
      ],
    };
    expect(problemsOf(parked, OFFERS)).toContain(
      "author: the claim already-done reaches operator before a review",
    );
  });
});

describe("the branch a task lands on", () => {
  const onto = (pipeline: Pipeline, branch: string | undefined): Pipeline => ({
    nodes: pipeline.nodes.map((node) => (node.kind === "land" ? { ...node, onto: branch } : node)),
  });
  // The worktree pipeline with a router after the land gate, which lands big
  // work through a second land block.
  const twoLands = (big: string | undefined): Pipeline => ({
    nodes: [
      ...onto(STANDARD_PIPELINES.worktree, "develop").nodes.map((node) =>
        node.id === "land-gate" && node.kind === "gate" ? { ...node, next: "size" } : node,
      ),
      { kind: "router", id: "size", routes: [{ when: "size>=3", to: "land-big" }], else: "land" },
      { kind: "land", id: "land-big", how: "merge", onto: big },
    ],
  });

  test("is the onto the route's lands name, else the checkout's branch", () => {
    expect(routeTarget(onto(STANDARD_PIPELINES.worktree, "develop"), facts())).toBe("develop");
    expect(routeTarget(STANDARD_PIPELINES.worktree, facts())).toBeUndefined();
    // A direct route has no branch, so it stays on the checkout's branch.
    expect(routeTarget(onto(STANDARD_PIPELINES.direct, "develop"), facts())).toBeUndefined();
  });

  test("lands a branch reaches must name one target", () => {
    expect(problemsOf(twoLands("develop"), OFFERS)).toEqual([]);
    expect(problemsOf(twoLands(undefined), OFFERS)).toEqual([
      "a route from branch reaches lands on different branches: land onto develop, land-big onto the checkout's branch",
    ]);
    expect(problemsOf(twoLands("main"), OFFERS)).toEqual([
      "a route from branch reaches lands on different branches: land onto develop, land-big onto main",
    ]);
  });

  test("refuses an onto that names a task's branch", () => {
    expect(problemsOf(onto(STANDARD_PIPELINES.worktree, "foreman/ts-123456"), OFFERS)).toContain(
      'land lands onto "foreman/ts-123456", which is no branch a task lands on',
    );
  });

  test("names the targets that must exist, and those the checkout must have out", () => {
    expect(targetsOf(onto(STANDARD_PIPELINES.worktree, "develop"))).toEqual({
      named: ["develop"],
      inCheckout: [],
    });
    expect(targetsOf(onto(STANDARD_PIPELINES.checkout, "develop"))).toEqual({
      named: ["develop"],
      inCheckout: ["develop"],
    });
    expect(targetsOf(STANDARD_PIPELINES.checkout)).toEqual({ named: [], inCheckout: [] });
  });
});
