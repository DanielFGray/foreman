import { describe, expect, test } from "bun:test";
import { DateTime, Option, Schema as S } from "effect";
import type { BoardColumn } from "./board.ts";
import { EMPTY_FLEET, placementIn, type FleetState } from "./dispatcher.ts";
import { STANDARD_PIPELINES } from "./pipeline.ts";
import { Policy } from "./policy.ts";
import { Published, publishedOf } from "./published.ts";
import type { Item, TaskStatus } from "./records.ts";
import { approvalOf, authorDone, authorRun, reviewRun, stoppedRun } from "./task-fixture.ts";

const task = (id: string, status: TaskStatus, runs: Item["runs"] = []): Item => ({
  id,
  title: `task ${id}`,
  status,
  project: "fibrae",
  type: "task",
  priority: 2,
  labels: [],
  description: "",
  parent: undefined,
  lastActivityAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  definitionOfDone: undefined,
  runs: runs.map((run) => ({ ...run, task: id })),
  charges: [],
  parked: undefined,
  tip: undefined,
});

const pipelines: FleetState["pipelines"] = new Map([
  ["fibrae", { _tag: "Runs", pipeline: STANDARD_PIPELINES.worktree, drawn: false }],
]);

/** The published board for these tasks, each placed the way the dispatcher places it. */
const board = (tasks: ReadonlyArray<Item>, over: Partial<FleetState> = {}) => {
  const published = publishedOf(
    {
      ...EMPTY_FLEET,
      projects: [
        {
          name: "fibrae",
          directory: "/build/fibrae",
          verify: undefined,
          preview: undefined,
          open: true,
        },
      ],
      pipelines,
      placed: tasks.map((one) => ({ task: one, placement: placementIn(pipelines, one) })),
      ...over,
    },
    Option.none(),
  );
  expect(S.decodeUnknownSync(Published)(JSON.parse(JSON.stringify(published)))).toEqual(published);
  return published;
};

const columns = (published: Published) =>
  Object.fromEntries(published.placements.map(({ key, column }) => [key, column]));

describe("the task board", () => {
  test("puts each task in the column its work is in", () => {
    const published = board([
      task("ts-new", "open"),
      task("ts-retry", "open", [stoppedRun("cheap")]),
      task("ts-writing", "in_progress", [authorRun("cheap")]),
      task("ts-waits-review", "in_progress", [authorDone("cheap", "c1")]),
      task("ts-reviewing", "in_progress", [authorDone("cheap", "c1"), reviewRun("mid")]),
      task("ts-lands", "in_progress", [authorDone("cheap", "c1"), approvalOf("mid", "c1")]),
      task("ts-returned", "in_progress", [
        authorDone("cheap", "c1"),
        reviewRun("mid", { open: false, ending: "returned" }),
      ]),
      task("ts-refixing", "in_progress", [
        authorDone("cheap", "c1"),
        reviewRun("mid", { open: false, ending: "returned" }),
        authorRun("mid"),
      ]),
    ]);
    const expected: Record<string, BoardColumn> = {
      "ts-new": "queue",
      // A retry with no verdict against it waits for an author like a new task.
      "ts-retry": "queue",
      "ts-writing": "authoring",
      "ts-waits-review": "review",
      "ts-reviewing": "review",
      "ts-lands": "review",
      // Back at the author after a review returned it, whether one runs yet or not.
      "ts-returned": "fixing",
      "ts-refixing": "fixing",
    };
    expect(columns(published)).toEqual(expected);
    // In the order the dispatcher placed them, so a Queue card above another goes first.
    expect(published.placements.map(({ key }) => key)).toEqual(Object.keys(expected));
  });

  test("a review foreman released sends nothing back", () => {
    // Released back to the queue in review: no reviewer named an exit.
    const published = board([
      task("ts-released", "open", [
        authorDone("cheap", "c1"),
        reviewRun("mid", { open: false, ending: "released" }),
      ]),
    ]);
    expect(columns(published)).toEqual({ "ts-released": "queue" });
  });

  test("a verdict from before the task last landed sends nothing back", () => {
    // Done once, then reopened: the approval belongs to the work that landed.
    const published = board([
      task("ts-reopened", "open", [
        authorDone("cheap", "c1"),
        approvalOf("mid", "c1"),
        authorRun("cheap", { open: false, ending: "done", landed: true }),
      ]),
    ]);
    expect(columns(published)).toEqual({ "ts-reopened": "queue" });
  });

  test("a task a gate holds for approval needs you", () => {
    const asked = task("ts-asked", "open");
    const published = board([asked], {
      asks: [{ task: asked, step: "author", rung: "cheap" }],
    });
    expect(columns(published)).toEqual({ "ts-asked": "needs-you" });
  });

  test("a claim no agent works on needs you, not Authoring", () => {
    const claimed = task("ts-claimed", "in_progress");
    const published = board([claimed], {
      decisions: [{ task: claimed, worker: undefined, kind: undefined }],
    });
    expect(columns(published)).toEqual({ "ts-claimed": "needs-you" });
    // The report says why, and retry sends an agent to it.
    expect(published.rows.find((row) => row.key === "ts-claimed")).toMatchObject({
      view: "attention",
      label: "author vanished",
      detail: "claimed outside foreman",
      actions: expect.arrayContaining(["retry"]),
    });
  });

  test("a grant gives the gated steps that are not on, and says which task it covers", () => {
    const policy = S.decodeSync(Policy)({
      default: { author: "off", climb: "ask", review: "on", land: "on" },
      grants: [{ scope: "ts-granted", steps: ["author", "climb"] }],
    });
    const published = board([task("ts-granted", "open"), task("ts-plain", "open")], {
      policy,
      scopes: new Map([["ts-granted", new Set(["ts-granted"])]]),
    });
    expect(published.projects.map(({ grantSteps }) => grantSteps)).toEqual([["author", "climb"]]);
    expect(Object.fromEntries(published.placements.map(({ key, grant }) => [key, grant]))).toEqual({
      "ts-granted": { scope: "ts-granted", steps: ["author", "climb"], left: null },
      "ts-plain": null,
    });
  });

  test("a grant gives nothing where every gated step is on, or the pipeline is stopped", () => {
    const on = S.decodeSync(Policy)({
      default: { author: "on", climb: "on", review: "on", land: "on" },
    });
    expect(board([], { policy: on }).projects[0]?.grantSteps).toEqual([]);
    const stopped = board([], {
      pipelines: new Map([["fibrae", { _tag: "Stopped", problems: ["no source"] }]]),
    });
    expect(stopped.projects[0]?.grantSteps).toEqual([]);
  });

  test("publishes each step's mode for the project, its own before the default", () => {
    const policy = S.decodeSync(Policy)({
      default: { author: "off", climb: "ask", review: "on", land: "on" },
      projects: { fibrae: { steps: { review: "ask" } } },
    });
    expect(board([], { policy }).projects[0]?.steps).toEqual({
      author: "off",
      climb: "ask",
      review: "ask",
      publish: policy.default.publish,
      land: "on",
    });
  });

  test("publishes each account with the rungs it pays for", () => {
    const published = board([], {
      providers: [
        {
          provider: "claude",
          plan: undefined,
          allowances: [],
          rungs: ["opus"],
          unreadable: undefined,
        },
      ],
    });
    expect(published.accounts).toEqual([{ provider: "claude", rungs: ["opus"] }]);
  });

  test("shows the tasks that landed in the last day, newest first", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const landedAt = (id: string, when: string): Item => ({
      ...task(id, "done"),
      lastActivityAt: new Date(when),
    });
    const landed = [
      landedAt("ts-new", "2026-11-03T11:00:00Z"),
      landedAt("ts-mid", "2026-11-02T13:00:00Z"),
      landedAt("ts-old", "2026-11-02T11:00:00Z"),
    ];
    const published = board([], { landed, observedAt: DateTime.fromDateUnsafe(now) });
    expect(published.landed).toEqual([
      {
        key: "ts-new",
        label: "task ts-new",
        project: "fibrae",
        parent: null,
        landedAt: "2026-11-03T11:00:00.000Z",
      },
      {
        key: "ts-mid",
        label: "task ts-mid",
        project: "fibrae",
        parent: null,
        landedAt: "2026-11-02T13:00:00.000Z",
      },
    ]);
    // Before the first reading there is no "now" to count a day back from.
    expect(board([], { landed }).landed).toEqual([]);
  });

  test("names each task's epic, and how far the epic has come", () => {
    const epic: Item = { ...task("ep-1", "in_progress"), type: "epic" };
    const under = { ...task("ts-under", "open"), parent: "ep-1" };
    const published = board([under, task("ts-loose", "open")], {
      epics: [{ epic, children: [under, { ...task("ts-shipped", "done"), parent: "ep-1" }] }],
    });
    expect(published.placements.map(({ key, parent }) => [key, parent])).toEqual([
      ["ts-under", "ep-1"],
      ["ts-loose", null],
    ]);
    expect(published.epics).toEqual([
      { key: "ep-1", label: "task ep-1", project: "fibrae", done: 1, total: 2 },
    ]);
  });
});
