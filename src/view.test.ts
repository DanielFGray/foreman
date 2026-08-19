import { describe, expect, test } from "bun:test";
import type { Active, FleetState, Held } from "./dispatcher.ts";
import type { Worker, WorkerState } from "./fleet.ts";
import { authoredBy, reviewedBy, type Item, type ReadyTask, type TaskStatus } from "./prog.ts";
import {
  actionsFor,
  BOUND_KEYS,
  commandFor,
  decisionKind,
  drawn,
  keyLine,
  previewOf,
  rowsForView,
  staleReview,
} from "./view.ts";

const task = (id: string, status: TaskStatus, labels: ReadonlyArray<string>): Item => ({
  id,
  title: `task ${id}`,
  status,
  project: "fibrae",
  type: "task",
  priority: 1,
  labels,
  description: null,
  last_activity_at: new Date(),
  created_at: new Date(),
});

const ready = (
  id: string,
  labels: ReadonlyArray<string> = [],
  description: string | null = null,
): ReadyTask => ({
  id,
  title: `task ${id}`,
  priority: 2,
  project: "amux",
  labels,
  description,
  created_at: new Date(),
});

const worker = (task: string, state: WorkerState): Worker => ({
  task,
  workspace: `ws-${task}`,
  pane: `pane-${task}`,
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

// A real description is several paragraphs, and the pane wraps and scrolls
// rather than truncating, so the assertion is that every line survives.
const LONG_DESCRIPTION = [
  "Carry description through ReadyTask and render it whole.",
  "",
  "The pane wraps and scrolls, so nothing here is cut to fit a width the",
  "renderer cannot know.",
].join("\n");

const state: FleetState = {
  queue: [ready("ts-q1", [], LONG_DESCRIPTION), ready("ts-q2", ["rung-pro"])],
  yours: [ready("ts-y1", ["rung-human"])],
  working: [
    active(task("ts-w1", "in_progress", ["by-flash", "rung-flash"]), worker("ts-w1", "working")),
  ],
  review: [
    active(task("ts-r1", "reviewing", ["by-flash", "review-by-pro"]), worker("ts-r1", "working")),
  ],
  landed: [task("ts-l1", "done", [])],
  decisions: [active(task("ts-d1", "in_progress", ["by-flash"]), undefined)],
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
      task: task("ts-s1", "reviewing", ["by-flash", "rung-flash", "review-by-pro"]),
      paths: ["src/old.ts", "src/gone.ts"],
      modifyDelete: true,
    },
  ],
  held: [held("fibrae", "dirty", "uncommitted changes to tracked files")],
  dispatch: "paused",
  observedAt: undefined,
};

const row = (view: Parameters<typeof rowsForView>[0], key: string) => {
  const found = rowsForView(view, state).find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no ${key} in ${view}`);
  return found;
};

describe("decisionKind", () => {
  test("names the kind from the status, and a failure over any of them", () => {
    expect(decisionKind(task("ts-1", "in_progress", ["by-flash"]))).toBe("author vanished");
    expect(decisionKind(task("ts-1", "reviewing", ["by-flash"]))).toBe("reviewer vanished");
    expect(decisionKind(task("ts-1", "done", ["by-flash"]))).toBe("orphaned workspace");
    // A failed spawn leaves the by-* label on a task that is back in the
    // queue, which is the same shape as an author that vanished.
    expect(decisionKind(task("ts-1", "open", ["by-flash"]), "no worktree")).toBe("dispatch failed");
  });
});

describe("staleReview", () => {
  test("is a review-by label on an open task with nobody behind it", () => {
    const label = ["review-by-pro"];
    expect(staleReview({ labels: label, status: "open" }, undefined)).toBe(true);
    expect(staleReview({ labels: label, status: "open" }, worker("ts-1", "settled"))).toBe(true);
    expect(staleReview({ labels: label, status: "open" }, worker("ts-1", "gone"))).toBe(true);
    // A live review is not stale, and neither is a task with no label.
    expect(staleReview({ labels: label, status: "open" }, worker("ts-1", "working"))).toBe(false);
    expect(staleReview({ labels: label, status: "reviewing" }, undefined)).toBe(false);
    expect(staleReview({ labels: [], status: "open" }, undefined)).toBe(false);
  });
});

describe("views", () => {
  test("draws only the views with something in them", () => {
    expect(drawn(state)).toEqual(["queue", "working", "review", "landed", "attention"]);
    expect(drawn({ ...state, landed: [], review: [] })).toEqual(["queue", "working", "attention"]);
    expect(
      drawn({ ...state, decisions: [], yours: [], unreviewed: [], stale: [], held: [] }),
    ).not.toContain("attention");
  });

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
    expect(previewOf(row("attention", "foreman/ts-s1"))).toContain(
      "cause     the trunk deleted what this branch patches",
    );
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
      held: [held("amux", "noBranch", "no bookmark behind the working copy")],
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
      decisions: [active(task("ts-o1", "done", ["by-flash"]), worker("ts-o1", "settled"))],
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
      working: [active(task("ts-w2", "in_progress", ["by-flash"]), undefined)],
    };
    const alone = rowsForView("working", gone).find((each) => each.key === "ts-w2");
    expect(actionsFor("working", alone)).not.toContain("focus");
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

describe("the footer", () => {
  // Two lines: the keys this row takes, and the keys that are always there.
  // One line of both is longer than a list column is wide.
  test("names the row's keys above the ones that never change", () => {
    const [actions = "", always = ""] = keyLine(
      actionsFor("working", row("working", "ts-w1")),
      state,
    ).split("\n");
    expect(actions).toBe("^f focus  ^e intervene  ^x descend  ^b release");
    expect(always).toContain("^q quit");
    expect(always.indexOf("^q quit")).toBeLessThan(always.indexOf("type to filter"));
    expect(always).toContain("^space running");
  });

  // Every command is modified so that no bare letter is spoken for: the
  // operator finds a row by typing its id.
  test("binds no bare letter, and leaves fzf's abort and navigation alone", () => {
    const taken = BOUND_KEYS.filter((key) => key.startsWith("ctrl-"));
    expect(taken).not.toContain("ctrl-c");
    expect(taken).not.toContain("ctrl-n");
    expect(taken).not.toContain("ctrl-p");
    expect(BOUND_KEYS.filter((key) => key.length === 1)).toEqual([]);
    expect(new Set(BOUND_KEYS).size).toBe(BOUND_KEYS.length);
  });

  // The screen binds what BOUND_KEYS lists and reports it back by name, so a
  // key in the list that reads back as nothing is a binding that does nothing.
  test("reads every bound key back as the command that owns it", () => {
    const commands = BOUND_KEYS.filter((key) => key !== "enter" && key !== "esc").map(commandFor);
    expect(commands.filter((command) => command === undefined)).toEqual([]);
    expect(commands).toContain("focus");
    expect(commandFor("left")).toBe("viewLeft");
  });

  test("is the always-there keys alone where the row takes none", () => {
    expect(keyLine([], state).split("\n")).toHaveLength(1);
  });
});

describe("previewOf", () => {
  test("says what the row is, and what a hold or a branch is behind it", () => {
    expect(previewOf(row("working", "ts-w1"))).toContain("labels    by-flash, rung-flash");
    expect(previewOf(row("working", "ts-w1"))).toContain("worker    working");
    expect(previewOf(row("attention", "foreman/ts-u1"))).toContain("branch    foreman/ts-u1");
    expect(previewOf(row("attention", "fibrae"))).toContain("project   fibrae");
  });

  test("gives a queued task's description whole, the same as a claimed one's", () => {
    const preview = previewOf(row("queue", "ts-q1"));
    for (const line of LONG_DESCRIPTION.split("\n")) expect(preview).toContain(line);
    expect(preview).toContain("status    ready");
  });

  test("says nothing where a task has no description", () => {
    expect(previewOf(row("queue", "ts-q2"))).not.toContain("null");
  });
});
