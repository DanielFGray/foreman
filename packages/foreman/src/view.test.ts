import { describe, expect, test } from "bun:test";
import type { Active, FleetState, Held, Provider } from "./dispatcher.ts";
import type { Usage } from "./quota.ts";
import type { Worker, WorkerState } from "./fleet.ts";
import { type Item, type TaskStatus } from "./prog.ts";
import { authoredBy, reviewedBy } from "./lap.ts";
import { authoredOn, reviewRun, withRuns } from "./task-fixture.ts";
import { actionsFor, decisionKind, queueRow, rowsForView, staleReview } from "./view.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import { STANDARD_PIPELINE, type AgentNode } from "./pipeline.ts";
import {
  Published,
  publishedOf,
  publishedQueue,
  publishedRow,
  statusOf,
  writePublished,
  type DispatcherStatus,
} from "./published.ts";
import { BunServices } from "@effect/platform-bun";
import { Effect, Option, Schema as S } from "effect";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const task = (id: string, status: TaskStatus, labels: ReadonlyArray<string>): Item => ({
  id,
  title: `task ${id}`,
  status,
  project: "fibrae",
  type: "task",
  priority: 1,
  labels,
  description: "",
  parent: undefined,
  lastActivityAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(0),
  definitionOfDone: undefined,
  runs: [],
  tip: undefined,
});

const ready = (id: string, labels: ReadonlyArray<string> = [], description = ""): Item => ({
  id,
  title: `task ${id}`,
  priority: 2,
  project: "amux",
  labels,
  description,
  parent: undefined,
  createdAt: new Date(),
  updatedAt: new Date(0),
  lastActivityAt: new Date(0),
  definitionOfDone: undefined,
  type: "task",
  status: "open",
  runs: [],
  tip: undefined,
});

const worker = (task: string, state: WorkerState): Worker => ({
  task,
  repository: "/home/dan/build/amux",
  directory: `/tmp/${task}`,
  worktree: `/tmp/wt-${task}`,
  state,
  roles: new Map([["author", state]]),
});

const active = (item: Item, on: Worker | undefined): Active => ({
  task: item,
  worker: on,
  kind: reviewedBy(item) ?? authoredBy(item),
});

const held = (project: string, reason: Held["reason"], detail: string): Held => ({
  project,
  reason,
  detail,
});

const provider = (
  usage: Usage,
  rungs: ReadonlyArray<string> = [],
  unreadable: string | undefined = undefined,
): Provider => ({ ...usage, rungs, unreadable });

// A real description is several paragraphs, and the pane wraps and scrolls
// rather than truncating, so the assertion is that every line survives.
const LONG_DESCRIPTION = [
  "Carry description through Item and render it whole.",
  "",
  "The pane wraps and scrolls, so nothing here is cut to fit a width the",
  "renderer cannot know.",
].join("\n");

const state: FleetState = {
  projects: [],
  providers: [],
  orphans: [],
  queue: [ready("ts-q1", [], LONG_DESCRIPTION), ready("ts-q2", ["failed-by:pro"])],
  yours: [ready("ts-y1", ["needs-you"])],
  working: [
    active(
      authoredOn(task("ts-w1", "in_progress", ["failed-by:flash"]), "flash"),
      worker("ts-w1", "working"),
    ),
  ],
  review: [
    active(
      withRuns(authoredOn(task("ts-r1", "reviewing", []), "flash"), [reviewRun("pro")]),
      worker("ts-r1", "working"),
    ),
  ],
  landed: [task("ts-l1", "done", [])],
  decisions: [active(authoredOn(task("ts-d1", "in_progress", []), "flash"), undefined)],
  committed: new Set<string>(),
  resumable: new Set<string>(),
  unreviewed: [
    {
      project: "pty",
      branch: "foreman/ts-u1",
      task: "ts-u1",
      title: "unread commits",
      status: "done",
      activity: new Date(),
    },
  ],
  stale: [
    {
      project: "fibrae",
      branch: "foreman/ts-s1",
      task: withRuns(authoredOn(task("ts-s1", "reviewing", ["failed-by:flash"]), "flash"), [
        reviewRun("pro"),
      ]),
      paths: ["src/old.ts", "src/gone.ts"],
      modifyDelete: true,
    },
  ],
  held: [held("fibrae", "dirty", "uncommitted changes to tracked files")],
  policy: DEFAULT_POLICY,
  policyError: undefined,
  pipelines: new Map(),
  placed: [],
  scopes: new Map(),
  asks: [],
  observedAt: undefined,
};

const row = (view: Parameters<typeof rowsForView>[0], key: string) => {
  const found = rowsForView(view, state).find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no ${key} in ${view}`);
  return found;
};

describe("decisionKind", () => {
  test("names the kind from the status, and a failure over any of them", () => {
    expect(decisionKind(authoredOn(task("ts-1", "in_progress", []), "flash"))).toBe(
      "author vanished",
    );
    expect(decisionKind(authoredOn(task("ts-1", "reviewing", []), "flash"))).toBe(
      "reviewer vanished",
    );
    expect(decisionKind(authoredOn(task("ts-1", "done", []), "flash"))).toBe("orphaned workspace");
    // A failed spawn leaves the by-* label on a task that is back in the
    // queue, which is the same shape as an author that vanished.
    expect(decisionKind(authoredOn(task("ts-1", "open", []), "flash"), "no worktree")).toBe(
      "dispatch failed",
    );
  });
});

describe("staleReview", () => {
  test("is an open review run on an open task with nobody behind it", () => {
    const runs = [reviewRun("pro")];
    expect(staleReview({ runs, status: "open" }, undefined)).toBe(true);
    expect(staleReview({ runs, status: "open" }, worker("ts-1", "settled"))).toBe(true);
    expect(staleReview({ runs, status: "open" }, worker("ts-1", "gone"))).toBe(true);
    // A live review is not stale, and neither is a task with no open review run.
    expect(staleReview({ runs, status: "open" }, worker("ts-1", "working"))).toBe(false);
    expect(staleReview({ runs, status: "reviewing" }, undefined)).toBe(false);
    expect(staleReview({ runs: [], status: "open" }, undefined)).toBe(false);
  });
});

describe("views", () => {
  test("orders attention by urgency, and keeps each row's own column", () => {
    const rows = rowsForView("attention", state);
    expect(rows.map((each) => each.column)).toEqual([
      "decisions",
      "yours",
      "stale",
      "unreviewed",
      "held",
    ]);
  });

  // An overtaken branch under review is about to cost a review that could
  // never land, which is why it outranks an unreviewed one — and the cause
  // goes on the row's own second line, named so the two problems are told
  // apart.
  test("a stale row names its branch and the cause on the second line", () => {
    expect(row("attention", "foreman/ts-s1").label).toBe("stale");
    expect(row("attention", "foreman/ts-s1").detail).toBe(
      "cannot land: trunk deleted src/old.ts, src/gone.ts",
    );
    expect(row("attention", "foreman/ts-s1").task?.status).toBe("reviewing");
  });

  // The reason is why the row exists. On its own line it survives a narrow
  // pane, which is the whole reason rows may be more than one line.
  test("puts what a row raises on its second line", () => {
    expect(row("attention", "fibrae").detail).toBe("uncommitted changes to tracked files");
    expect(row("attention", "ts-d1").detail).toBe("flash");
    expect(row("attention", "foreman/ts-u1").detail).toBe("unread commits");
    // Ordinary work needs no second line: its label already says everything
    // one line can hold.
    expect(row("queue", "ts-q1").detail).toBeUndefined();
  });
});

describe("actionsFor", () => {
  test("landed history takes no action at all", () => {
    expect(actionsFor("landed", row("landed", "ts-l1"))).toEqual([]);
  });

  test("a rung can only be lowered where one was written", () => {
    expect(actionsFor("queue", row("queue", "ts-q2"))).toContain("descend");
    expect(actionsFor("queue", row("queue", "ts-q1"))).not.toContain("descend");
  });

  // Onboarding salvages uncommitted work, so a hold that is not uncommitted
  // work has nothing for it: the top-rung run would be spent discovering
  // there is nothing there.
  test("offers onboarding only for a hold that is uncommitted work", () => {
    expect(actionsFor("held", row("attention", "fibrae"))).toEqual(["onboard"]);
    const clean = {
      ...state,
      held: [held("amux", "noBranch", "no checked-out branch (detached HEAD)")],
    };
    const stuck = rowsForView("attention", clean).find((each) => each.key === "amux");
    expect(actionsFor("held", stuck)).toEqual([]);
  });

  // A vanished author can be handed back; an orphaned workspace has no claim
  // to undo, so releasing it would reopen a task somebody finished.
  test("allows only the answers each decision has", () => {
    expect(actionsFor("decisions", row("attention", "ts-d1"))).toEqual([
      "retry",
      "intervene",
      "release",
    ]);
    const orphan = {
      ...state,
      decisions: [
        active(authoredOn(task("ts-o1", "done", []), "flash"), worker("ts-o1", "settled")),
      ],
    };
    const left = rowsForView("attention", orphan).find((each) => each.key === "ts-o1");
    // Nothing to intervene in either: the task is finished, and the workspace
    // behind it is residue rather than an attempt to resume.
    expect(actionsFor("decisions", left)).toEqual(["close"]);
  });

  // A task parked at the operator leaves by them writing the decision into it,
  // never by one key that would hand the next agent the same question.
  test("gives the operator's own column no answer key", () => {
    expect(actionsFor("yours", row("attention", "ts-y1"))).not.toContain("release");
    expect(actionsFor("yours", row("attention", "ts-y1"))).toContain("descend");
  });

  test("only offers focus where there is a worker to focus", () => {
    expect(actionsFor("working", row("working", "ts-w1"))).toContain("focus");
    const gone = {
      ...state,
      working: [active(authoredOn(task("ts-w2", "in_progress", []), "flash"), undefined)],
    };
    const alone = rowsForView("working", gone).find((each) => each.key === "ts-w2");
    expect(actionsFor("working", alone)).not.toContain("focus");
  });

  test("offers kill only for a live worker", () => {
    expect(actionsFor("working", row("working", "ts-w1"))).toContain("kill");
    const blocked = {
      ...row("working", "ts-w1"),
      worker: worker("ts-w2", "blocked"),
    };
    expect(actionsFor("review", blocked)).toContain("kill");
    const settled = {
      ...state,
      working: [
        active(authoredOn(task("ts-w2", "in_progress", []), "flash"), worker("ts-w2", "settled")),
      ],
    };
    const alone = rowsForView("working", settled).find((each) => each.key === "ts-w2");
    expect(actionsFor("working", alone)).not.toContain("kill");
  });

  // A stale row's answers are the corrections and the release that sends the
  // work back to the queue instead of paying for a review that cannot land.
  // No focus or takeover: the row carries the task, not a worker.
  test("a stale row can be released, descended or intervened on, but not focused", () => {
    expect(actionsFor("stale", row("attention", "foreman/ts-s1"))).toEqual([
      "intervene",
      "descend",
      "release",
    ]);
  });
});

describe("quota view and accounts", () => {
  const spent: Usage = {
    provider: "opencode-go",
    plan: undefined,
    allowances: [
      { window: "rolling", usedPercent: 0, resetsAt: new Date(Date.now() + 3_600_000) },
      { window: "monthly", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * 86_400_000) },
    ],
  };
  const spare: Usage = {
    provider: "openai",
    plan: "plus",
    allowances: [{ window: "primary (1w)", usedPercent: 29, resetsAt: undefined }],
  };
  const withQuota: FleetState = {
    ...state,
    providers: [provider(spent, ["pro", "sonnet"]), provider(spare, ["plus"])],
  };

  test("a spent account is the last thing in attention", () => {
    // Every other row there is something a person can act on now. This one is
    // a wait, so it goes under them rather than above the work.
    const rows = rowsForView("attention", withQuota);
    expect(rows[rows.length - 1]?.column).toBe("quota");
  });

  test("an account with room is not an attention row", () => {
    expect(
      rowsForView("attention", withQuota).some(
        (each) => each.column === "quota" && each.key === "openai",
      ),
    ).toBe(false);
  });

  test("the row says which windows are spent, their resets, and the rungs they stop", () => {
    // All three halves are what the operator decides on: whether to wait it
    // out, or to move the work onto a rung spending a different account — and
    // which rungs those are.
    const row = rowsForView("attention", withQuota).find(
      (each) => each.column === "quota" && each.key === "opencode-go",
    );
    expect(row?.label).toContain("out of quota");
    expect(row?.label).toContain("opencode-go");
    expect(row?.detail).toContain("monthly 100%");
    expect(row?.detail).toContain("resets in 2d");
    expect(row?.detail).toContain("stops: pro, sonnet");
  });

  test("the quota view lists every account, healthy and spent", () => {
    const rows = rowsForView("quota", withQuota);
    expect(rows.map((each) => each.key)).toEqual(["opencode-go", "openai"]);
    expect(rows[0]?.label).toContain("out of quota");
    // An account with room is just itself: the windows carry the story.
    expect(rows[1]?.label).toBe("openai [plus]");
    expect(rows[1]?.detail).toContain("primary (1w) 29%");
  });

  test("an unreadable account is a quota-view row that attention passes over", () => {
    const broken = provider(
      { provider: "claude", plan: undefined, allowances: [] },
      ["claude"],
      "oauth token expired — run claude once",
    );
    const rows = rowsForView("quota", { ...state, providers: [broken] });
    expect(rows[0]?.label).toContain("unreadable");
    expect(rows[0]?.detail).toContain("token expired");
    expect(
      rowsForView("attention", { ...state, providers: [broken] }).some(
        (each) => each.column === "quota",
      ),
    ).toBe(false);
  });

  test("takes no key, because nothing on this row is the fix", () => {
    const row = rowsForView("attention", withQuota).find((each) => each.column === "quota");
    expect(actionsFor("quota", row)).toEqual([]);
  });
});

describe("orphaned workspaces", () => {
  // A task can be deleted while its workspace is open. Nothing in the pipeline
  // mentions it after that — no column, no slot, no dispatch — so without this
  // row it stays open forever holding a worktree nobody can name.
  const orphaned: FleetState = {
    ...state,
    orphans: [{ ...worker("ts-gone", "gone"), directory: "/tmp/worktrees/ts-gone" }],
  };

  test("sits between the unread branches and the held projects", () => {
    expect(rowsForView("attention", orphaned).map((each) => each.column)).toEqual([
      "decisions",
      "yours",
      "stale",
      "unreviewed",
      "orphans",
      "held",
    ]);
  });

  test("names the workspace and the directory to look in", () => {
    const found = rowsForView("attention", orphaned).find((each) => each.key === "ts-gone");
    expect(found?.label).toBe("no such task");
    expect(found?.detail).toBe("/tmp/worktrees/ts-gone");
  });

  // Nothing remains to retry, release or lower: the store has forgotten the
  // task, so closing the workspace is the only thing left that is true.
  test("takes only the close key", () => {
    const found = rowsForView("attention", orphaned).find((each) => each.key === "ts-gone");
    expect(found && actionsFor(found.column, found)).toEqual(["close"]);
  });
});

describe("publishedOf", () => {
  test("publishes every view's rows with the commands each takes, in a shape its schema reads back", () => {
    const published = publishedOf(
      {
        ...state,
        projects: [{ name: "pty", directory: "/build/pty", verify: undefined, open: true }],
      },
      Option.some(statusOf(state)),
    );
    expect(S.decodeUnknownSync(Published)(JSON.parse(JSON.stringify(published)))).toEqual(
      published,
    );
    // No step is on and no grant exists under the default policy.
    expect(published.dispatcher).toEqual({ state: "idle" });
    expect(published.policy).toEqual(DEFAULT_POLICY);
    // The queue is read with `foreman queue`, not published.
    expect(published.rows.some((row) => row.view === "queue")).toBe(false);
    const parked = published.rows.find((row) => row.key === "ts-y1");
    expect(parked?.view).toBe("attention");
    // The panel filters to the shown space by this, and a ready task carries
    // its project only on the task.
    expect(parked?.project).toBe(state.yours[0]!.project);
  });

  test("publishes where each task stands and which projects are stopped", () => {
    const author = STANDARD_PIPELINE.nodes.find(
      (node): node is AgentNode => node.kind === "agent" && node.role === "author",
    )!;
    const published = publishedOf(
      {
        ...state,
        pipelines: new Map([["fibrae", { _tag: "Stopped", problems: ["no source"] }]]),
        placed: [
          {
            task: task("ts-a", "open", []),
            placement: {
              _tag: "At",
              node: author,
              state: "waiting",
              gates: [{ id: "start", step: "author" }],
              ahead: 3,
              workspace: "worktree",
            },
          },
          { task: task("ts-b", "open", []), placement: { _tag: "Parked", node: "attention" } },
          { task: task("ts-c", "open", []), placement: { _tag: "Outside" } },
        ],
      },
      Option.none(),
    );
    expect(published.placements).toEqual([
      {
        key: "ts-a",
        label: "task ts-a",
        project: "fibrae",
        node: author.id,
        state: "waiting",
        gates: [{ id: "start", step: "author" }],
      },
      {
        key: "ts-b",
        label: "task ts-b",
        project: "fibrae",
        node: "attention",
        state: "parked",
        gates: [],
      },
    ]);
    expect(published.stopped).toEqual([{ project: "fibrae", problems: ["no source"] }]);
    expect(S.decodeUnknownSync(Published)(JSON.parse(JSON.stringify(published)))).toEqual(
      published,
    );
  });

  test("prints a queued task with the commands its queue row takes", () => {
    const failed = state.queue[1]!;
    expect(publishedRow("queue")(queueRow(failed))).toEqual({
      view: "queue",
      key: failed.id,
      label: `${failed.project}  ${failed.title}`,
      detail: null,
      project: failed.project,
      parent: null,
      epic: false,
      actions: ["complete", "intervene", "descend"],
    });
  });

  test("leads each queued epic's first task with the epic, keeping the tasks' order", () => {
    const epic = {
      ...task("ep-drive", "in_progress", []),
      type: "epic" as const,
      title: "Drive the release",
    };
    const [first, second] = state.queue;
    const queue = [
      { ...first!, parent: undefined },
      { ...second!, parent: "ep-drive" },
      { ...first!, id: "ts-q9", parent: "ep-drive" },
    ];
    const rows = publishedQueue(queue, [
      { epic, children: [task("ts-done", "done", []), task("ts-open", "open", [])] },
    ]);
    expect(rows.map((row) => row.key)).toEqual([first!.id, "ep-drive", second!.id, "ts-q9"]);
    expect(rows[1]).toMatchObject({ epic: true, parent: null, actions: [] });
    expect(rows[1]?.label).toContain("1/2");
    expect(rows[2]).toMatchObject({ epic: false, parent: "ep-drive" });
  });

  test("names no dispatcher for a one-shot read", () => {
    expect(publishedOf(state, Option.none()).dispatcher).toBeNull();
  });

  test("carries why a dispatcher failed, in a shape its schema reads back", () => {
    const published = publishedOf(
      state,
      Option.some({ state: "failed", detail: "prog: command not found" }),
    );
    expect(S.decodeUnknownSync(Published)(JSON.parse(JSON.stringify(published)))).toEqual(
      published,
    );
  });

  test("replaces the file whole, leaving no temporary beside it", async () => {
    const folder = await mkdtemp(`${tmpdir()}/published-`);
    const path = `${folder}/state.json`;
    const write = (dispatcher: Option.Option<DispatcherStatus>) =>
      Effect.runPromise(
        writePublished(path, publishedOf(state, dispatcher)).pipe(
          Effect.provide(BunServices.layer),
        ),
      );
    await write(Option.some({ state: "running" }));
    await write(Option.none());
    expect(JSON.parse(await readFile(path, "utf8")).dispatcher).toBeNull();
    expect(await readdir(folder)).toEqual(["state.json"]);
  });
});

describe("asks", () => {
  const askState: FleetState = {
    ...state,
    asks: [
      {
        task: withRuns(
          authoredOn(task("ts-k1", "reviewing", []), "cheap"),
          [reviewRun("cheap", { ending: "approved", commit: "c1" })],
          "c1",
        ),
        step: "land",
        rung: "cheap",
      },
    ],
  };

  test("an ask is an attention row after the decisions and before the needs-you row", () => {
    const columns = rowsForView("attention", askState).map((each) => each.column);

    expect(columns.indexOf("asks")).toBeGreaterThan(columns.indexOf("decisions"));
    expect(columns.indexOf("asks")).toBeLessThan(columns.indexOf("yours"));
  });

  test("the row says what approving starts, and takes approve and nothing else", () => {
    const ask = rowsForView("attention", askState).find((each) => each.key === "ts-k1");

    expect(ask?.detail).toBe("reviewed by cheap and approved; approve to land it");
    expect(ask && actionsFor(ask.column, ask)).toEqual(["approve"]);
  });

  test("a row without an ask takes no approve", () => {
    expect(actionsFor("asks", row("attention", "ts-d1"))).toEqual([]);
  });
});
