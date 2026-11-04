import { describe, expect, test } from "bun:test";
import type { Ladder } from "./ladder.ts";
import { type Pipeline, STANDARD_PIPELINES, standardExits } from "./pipeline.ts";
import { simulate, simulateReport, type Frame, type SimulateWorld } from "./pipeline-simulate.ts";
import type { Item } from "./records.ts";
import { type AgentSample, type Measured, ratesOf } from "./run-rates.ts";

const RULES = {
  ladder: [
    { name: "cheap", harness: "test", level: 0, model: undefined, provider: undefined },
    { name: "dear", harness: "test", level: 1, model: undefined, provider: undefined },
  ] as Ladder,
  // The reviewer has the upper rung's name, so one sample name covers both roles.
  reviewers: [
    { name: "dear", harness: "test", model: "m-dear", provider: undefined, thinking: "high" },
  ],
  attemptsPerLevel: 2,
};

const item = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  title: `Task ${id}`,
  project: "p",
  type: "task",
  status: "open",
  priority: 2,
  parent: undefined,
  labels: [],
  description: "",
  definitionOfDone: undefined,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastActivityAt: new Date(0),
  runs: [],
  charges: [],
  parked: undefined,
  tip: undefined,
  ...over,
});

const world = (count: number, slots = 2): SimulateWorld => ({
  project: "p",
  ready: Array.from({ length: count }, (_, index) => item(`ts-${index}`)),
  claimed: [],
  epics: [],
  now: new Date(0),
  slots,
  pollSeconds: 60,
});

const sample = (
  rung: string,
  role: AgentSample["role"],
  ending: string,
  minutes: number,
): AgentSample => ({ rung, role, ending, minutes });

/** Rates where every author names `done` and every reviewer names `review`. */
const always = (review: string): Measured => ({
  agents: [sample("cheap", "author", "done", 30), sample("dear", "review", review, 10)],
  checks: [],
});

/** Where each task stands after the frame at `index`: the fold of the moves up to it. */
const boardAt = (frames: ReadonlyArray<Frame>, index: number) =>
  new Map(
    frames.slice(0, index + 1).flatMap((frame) => frame.moves.map((move) => [move.task, move])),
  );

const played = (pipeline: Pipeline, measured: Measured, count = 5) =>
  simulate({
    world: world(count),
    pipeline,
    drawn: true,
    rates: ratesOf(measured),
    rules: RULES,
    seed: 1,
    hours: 72,
  });

/** The standard pipeline with its author block changed by `change`. */
const withAuthor = (change: object): Pipeline => ({
  nodes: STANDARD_PIPELINES.worktree.nodes.map((node) =>
    node.id === "author" ? { ...node, ...change } : node,
  ),
});

/** A pipeline with no review: the author's work lands as soon as it is done. */
const NO_REVIEW: Pipeline = {
  nodes: [
    { kind: "source", id: "queue", filter: "", next: "author" },
    {
      kind: "agent",
      id: "author",
      role: "author",
      model: "ladder",
      exits: standardExits({ kind: "agent", role: "author" }, "land"),
    },
    { kind: "land", id: "land", how: "merge" },
  ],
};

describe("simulate", () => {
  test("repeats a check that fails back into itself once a tick, and ends at the horizon", () => {
    const looping: Pipeline = {
      nodes: [
        { kind: "source", id: "queue", filter: "", next: "author" },
        {
          kind: "agent",
          id: "author",
          role: "author",
          model: "ladder",
          exits: [{ id: "done", name: "done", to: "lint" }],
        },
        {
          kind: "check",
          id: "lint",
          command: "false",
          exits: [
            { id: "passed", name: "passed", to: "land" },
            { id: "failed", name: "failed", to: "lint" },
          ],
        },
        { kind: "land", id: "land", how: "merge" },
      ],
    };
    const run = simulate({
      world: world(1),
      pipeline: looping,
      drawn: true,
      rates: ratesOf({ ...always("approved"), checks: [{ node: "lint", passed: false }] }),
      rules: RULES,
      seed: 1,
      hours: 2,
    });
    expect(run.landed).toBe(0);
    expect(run.inFlight).toBe(1);
    expect(boardAt(run.frames, run.frames.length - 1).get("ts-0")?.node).toBe("lint");
  });

  test("gives the same run for the same seed", () => {
    const measured: Measured = {
      agents: [
        sample("cheap", "author", "done", 20),
        sample("cheap", "author", "stopped", 1),
        sample("dear", "review", "approved", 5),
        sample("dear", "review", "returned", 8),
      ],
      checks: [],
    };
    const report = () =>
      simulateReport(
        world(4),
        {
          draft: undefined,
          live: { pipeline: STANDARD_PIPELINES.worktree, drawn: false, problems: [] },
        },
        ratesOf(measured),
        RULES,
        { seed: 7, hours: 48 },
      );
    expect(report()).toEqual(report());
  });

  test("lands every task when every run succeeds, never running more agents than slots", () => {
    const run = played(STANDARD_PIPELINES.worktree, always("approved"));
    expect(run.landed).toBe(5);
    expect(run.tasks.every((task) => task.landedAt !== null)).toBe(true);
    for (const index of run.frames.keys()) {
      const running = [...boardAt(run.frames, index).values()].filter(
        (standing) => standing.state === "running",
      );
      expect(running.length).toBeLessThanOrEqual(2);
    }
    expect(run.runsBySeat).toEqual({ author: { cheap: 5 }, review: { dear: 5 } });
  });

  for (const shape of ["checkout", "direct"] as const) {
    test(`${shape}: the checkout runs one task at a time, whatever the slots`, () => {
      const run = played(STANDARD_PIPELINES[shape], always("approved"));
      expect(run.landed).toBe(5);
      for (const index of run.frames.keys()) {
        const running = [...boardAt(run.frames, index).values()].filter(
          (standing) => standing.state === "running",
        );
        expect(running.length).toBeLessThanOrEqual(1);
      }
    });
  }

  test("parks a task whose author stops at a block that parks a stop", () => {
    const stops: Measured = { agents: [sample("cheap", "author", "stopped", 3)], checks: [] };
    const run = played(withAuthor({ stopped: "park" }), stops, 3);
    expect(run.parked).toBe(3);
    expect(run.landed).toBe(0);
    expect(run.runsBySeat).toEqual({ author: { cheap: 3 }, review: {} });
    expect(run.tasks.every((task) => task.parkedAt !== null && task.at === null)).toBe(true);
  });

  test("ends when every rung has stopped on every task, which parks them", () => {
    const stops: Measured = { agents: [sample("cheap", "author", "stopped", 3)], checks: [] };
    const run = played(STANDARD_PIPELINES.worktree, stops, 3);
    expect(run.parked).toBe(3);
    // Two tries on each rung before the climb, as attemptsPerLevel says.
    expect(run.runsBySeat).toEqual({ author: { cheap: 6, dear: 6 }, review: {} });
  });

  test("counts a task parked before the start as parked from the start", () => {
    const run = simulate({
      world: { ...world(1), ready: [item("ts-0", { parked: "the operator's" })] },
      pipeline: STANDARD_PIPELINES.worktree,
      drawn: false,
      rates: ratesOf(always("approved")),
      rules: RULES,
      seed: 1,
      hours: 72,
    });
    expect(run.tasks[0]).toMatchObject({ parkedAt: 0, landedAt: null });
  });
});

describe("simulateReport", () => {
  test("plays the draft and the saved pipeline on the same seed", () => {
    const report = simulateReport(
      world(3),
      {
        draft: { pipeline: NO_REVIEW, problems: [] },
        live: { pipeline: STANDARD_PIPELINES.worktree, drawn: true, problems: [] },
      },
      ratesOf(always("returned")),
      RULES,
      { seed: 1, hours: 72 },
    );
    // Without the review, nothing sends the work back.
    expect(report.draft?.source).toBe("draft");
    expect(report.draft?.landed).toBe(3);
    expect(report.saved.source).toBe("saved");
    expect(report.saved.landed).toBe(0);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  test("plays only the saved pipeline when the project has no draft", () => {
    const report = simulateReport(
      world(1),
      {
        draft: undefined,
        live: { pipeline: STANDARD_PIPELINES.worktree, drawn: false, problems: [] },
      },
      ratesOf(always("approved")),
      RULES,
      { seed: 1, hours: 72 },
    );
    expect(report.draft).toBeNull();
    expect(report.saved.source).toBe("standard");
    expect(report.rates.map((rate) => [rate.rung, rate.role, rate.label])).toEqual([
      ["cheap", "author", "Measured"],
      ["dear", "author", "Assumed"],
      ["dear", "review", "Measured"],
    ]);
  });
});
