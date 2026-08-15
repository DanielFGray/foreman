/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { Active, FleetState } from "./dispatcher.ts";
import type { Worker, WorkerState } from "./fleet.ts";
import { decisionKind, Pipeline, staleReview, type Controls } from "./pipeline.tsx";
import { authoredBy, reviewedBy, type Item, type ReadyTask } from "./prog.ts";

const task = (id: string, status: string, labels: ReadonlyArray<string>): Item => ({
  id,
  title: `task ${id}`,
  status,
  project: "fibrae",
  type: "task",
  priority: 1,
  labels,
  description: null,
  last_activity_at: new Date(),
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

const active = (task: Item, worker: Worker | undefined): Active => ({
  task,
  worker,
  kind: reviewedBy(task) ?? authoredBy(task),
});

const state: FleetState = {
  yours: [
    {
      id: "ts-eee111",
      title: "needs a decision",
      priority: 2,
      project: "fibrae",
      labels: ["rung-human"],
    },
  ],
  queue: [
    { id: "ts-aaa111", title: "queue one", priority: 1, project: "fibrae", labels: [] },
    { id: "ts-aaa222", title: "queue two", priority: 2, project: "fibrae", labels: [] },
  ],
  working: [
    active(task("ts-bbb111", "in_progress", ["by-opencode"]), worker("ts-bbb111", "working")),
  ],
  review: [
    active(
      task("ts-bbb222", "reviewing", ["by-opencode", "review-by-claude"]),
      worker("ts-bbb222", "working"),
    ),
  ],
  landed: [task("ts-bbb333", "done", [])],
  decisions: [
    // An author who vanished leaves a claimed task with no workspace behind it.
    active(task("ts-ccc111", "in_progress", ["by-opencode"]), undefined),
    // A reviewer who vanished leaves its pane closed but the workspace intact.
    active(
      task("ts-ccc222", "reviewing", ["by-opencode", "review-by-claude"]),
      worker("ts-ccc222", "gone"),
    ),
    // A workspace whose task is neither claimed nor under review: a failed
    // spawn left it behind while the by-* label stayed on the task.
    active(task("ts-ccc333", "open", ["by-opencode"]), worker("ts-ccc333", "gone")),
  ],
  held: ["fibrae"],
  orphans: [
    {
      project: "fibrae",
      branch: "foreman/ts-ddd111",
      task: "ts-ddd111",
      title: "abandoned work",
      status: "done",
    },
    // A branch whose task was deleted: it still shows, because the commits are
    // real, but there is nothing to send for review.
    {
      project: "fibrae",
      branch: "foreman/ts-ddd222",
      task: "ts-ddd222",
      title: undefined,
      status: undefined,
    },
  ],
  paused: false,
};

// The shapes the corrective keys act on: rows that carry a rung-* label, rows
// that carry a review-by-* label no reviewer is behind, and rows that carry
// neither.
const corrective: FleetState = {
  yours: [],
  queue: [
    { id: "ts-q100", title: "pinned up", priority: 1, project: "fibrae", labels: ["rung-top"] },
    {
      id: "ts-q200",
      title: "stale reviewer",
      priority: 1,
      project: "fibrae",
      labels: ["review-by-claude"],
    },
    { id: "ts-q300", title: "fresh", priority: 1, project: "fibrae", labels: [] },
  ],
  working: [],
  review: [],
  landed: [],
  decisions: [
    // An open task's workspace, carrying a reviewer the world no longer has.
    active(task("ts-d100", "open", ["by-opencode", "review-by-claude"]), worker("ts-d100", "gone")),
  ],
  held: [],
  orphans: [],
  paused: false,
};

interface Calls {
  quit: Array<string>;
  togglePause: Array<string>;
  toggleConsole: Array<string>;
  focus: Array<string>;
  retry: Array<string>;
  release: Array<string>;
  close: Array<string>;
  climb: Array<string>;
  descend: Array<string>;
  unassign: Array<string>;
  onboard: Array<string>;
  adopt: Array<string>;
}

const makeControls = (): { controls: Controls; calls: Calls } => {
  const calls: Calls = {
    quit: [],
    togglePause: [],
    toggleConsole: [],
    focus: [],
    retry: [],
    release: [],
    close: [],
    climb: [],
    descend: [],
    unassign: [],
    onboard: [],
    adopt: [],
  };
  const controls: Controls = {
    quit: () => calls.quit.push("quit"),
    togglePause: () => calls.togglePause.push("pause"),
    toggleConsole: () => calls.toggleConsole.push("console"),
    focus: (w) => calls.focus.push(w.task),
    retry: (t) => calls.retry.push(t.id),
    release: (t) => calls.release.push(t.id),
    close: (t) => calls.close.push(t.id),
    climb: (t) => calls.climb.push(t.id),
    descend: (t) => calls.descend.push(t.id),
    unassign: (t) => calls.unassign.push(t.id),
    onboard: (p) => calls.onboard.push(p),
    adopt: (o) => calls.adopt.push(o.branch),
  };
  return { controls, calls };
};

describe("decisionKind", () => {
  test("names the author when the author vanished", () => {
    expect(decisionKind(task("ts-1", "in_progress", ["by-opencode"]))).toBe("author vanished");
  });

  test("names the reviewer when the reviewer vanished", () => {
    expect(decisionKind(task("ts-1", "reviewing", ["by-opencode", "review-by-claude"]))).toBe(
      "reviewer vanished",
    );
  });

  test("names by status, not by the label a failed spawn left behind", () => {
    // A failed dispatch leaves the by-* label on while the task returns to the
    // queue. Status is what makes it residue, so it reads orphaned either way.
    expect(decisionKind(task("ts-1", "open", ["by-opencode"]))).toBe("orphaned workspace");
    expect(decisionKind(task("ts-1", "done", []))).toBe("orphaned workspace");
  });
});

describe("staleReview", () => {
  test("is stale when the workspace is gone and the task is open", () => {
    expect(staleReview(task("ts-1", "open", ["by-opencode", "review-by-claude"]), undefined)).toBe(
      true,
    );
    expect(
      staleReview(
        task("ts-1", "open", ["by-opencode", "review-by-claude"]),
        worker("ts-1", "gone"),
      ),
    ).toBe(true);
  });

  test("is not stale while a reviewer is behind it", () => {
    // A working or blocked reviewer is still on the job; clearing the label
    // would let a second reviewer be dispatched into the same task.
    expect(
      staleReview(
        task("ts-1", "reviewing", ["by-opencode", "review-by-claude"]),
        worker("ts-1", "working"),
      ),
    ).toBe(false);
    expect(
      staleReview(
        task("ts-1", "reviewing", ["by-opencode", "review-by-claude"]),
        worker("ts-1", "blocked"),
      ),
    ).toBe(false);
  });

  test("is not stale without a review-by-* label", () => {
    expect(staleReview(task("ts-1", "open", ["by-opencode"]), undefined)).toBe(false);
  });

  test("a ready task, which is open by definition, reads stale with the label", () => {
    const ready: ReadyTask = {
      id: "ts-1",
      title: "ready",
      priority: 1,
      project: "fibrae",
      labels: ["review-by-claude"],
    };
    expect(staleReview(ready, undefined)).toBe(true);
  });
});

describe("Pipeline", () => {
  test("renders the pipeline and names each decision", async () => {
    const { controls } = makeControls();
    const t = await testRender(() => <Pipeline state={() => state} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame(
        (f) => f.includes("queue 2") && f.includes("decisions 3") && f.includes("held 1"),
      );
      const frame = t.captureCharFrame();
      expect(frame).toContain("author vanished");
      expect(frame).toContain("reviewer vanished");
      expect(frame).toContain("orphaned workspace");
      expect(frame).toContain("fibrae");
      expect(frame).toContain("awaiting a decision");
    } finally {
      t.renderer.destroy();
    }
  });

  // An idle fleet is the ordinary case, and a screen of bordered boxes all
  // titled zero says nothing the counts do not. Nothing drawn is nothing
  // reachable either: the cursor stays where there is work rather than walking
  // through columns the operator cannot see.
  test("draws no column for an empty list, and does not let the cursor into one", async () => {
    const { controls, calls } = makeControls();
    const quiet: FleetState = {
      ...state,
      working: [],
      review: [],
      landed: [],
      decisions: [],
      yours: [],
      held: [],
      orphans: [],
    };
    const t = await testRender(() => <Pipeline state={() => quiet} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("queue 2"));
      const frame = t.captureCharFrame();
      // A drawn column carries its count in the border title, so that is what
      // must be absent — the key hints below name several of these words.
      for (const empty of ["working", "review", "landed", "decisions", "yours", "held", "stranded"])
        expect(frame).not.toContain(`${empty} 0`);

      // Right from the only column wraps back onto itself, so the queue's own
      // key still lands rather than falling into a column that is not there.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("e");
      await t.waitFor(() => calls.climb.length === 1);
      expect(calls.climb[0]).toBe("ts-aaa111");
    } finally {
      t.renderer.destroy();
    }
  });

  // A scrollbox scrolls itself, which is a second position beside the cursor:
  // one notch used to carry the selected row off the screen, and the next
  // keypress or tick snapped the view back to wherever the cursor still was.
  test("the wheel moves the cursor, and the view follows it", async () => {
    const { controls, calls } = makeControls();
    const long: FleetState = {
      ...corrective,
      queue: Array.from({ length: 30 }, (_, index) => ({
        id: `ts-q${index}`,
        title: `queued ${index}`,
        priority: 1,
        project: "fibrae",
        labels: ["rung-top"],
      })),
      decisions: [],
      yours: [
        { id: "ts-y1", title: "yours one", priority: 2, project: "fibrae", labels: ["rung-top"] },
        { id: "ts-y2", title: "yours two", priority: 2, project: "fibrae", labels: ["rung-top"] },
        { id: "ts-y3", title: "yours three", priority: 2, project: "fibrae", labels: ["rung-top"] },
      ],
    };
    const t = await testRender(() => <Pipeline state={() => long} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("queue 30"));

      await t.mockMouse.scroll(10, 5, "down");
      await t.flush();
      const frame = t.captureCharFrame();
      // The first row is still the first row: the viewport did not move on its
      // own. The cursor did, and it is the only thing that moved.
      expect(frame).toContain("  fibrae  queued 0");
      expect(frame).toContain("> fibrae  queued 1");

      // The column under the pointer becomes the selected one, so the wheel is
      // also the mouse's h and l. The row index carries over and clamps: 1 in a
      // thirty-row queue is 1 in a three-row panel, and one more notch is its
      // last row.
      const yours = frame.split("\n").findIndex((line) => line.includes("yours 3"));
      expect(yours).toBeGreaterThan(0);
      await t.mockMouse.scroll(10, yours + 1, "down");
      await t.flush();

      t.mockInput.pressKey("x");
      await t.waitFor(() => calls.descend.length === 1);
      expect(calls.descend[0]).toBe("ts-y3");
    } finally {
      t.renderer.destroy();
    }
  });

  test("navigates the pipeline and runs the selected action", async () => {
    const { controls, calls } = makeControls();
    const t = await testRender(() => <Pipeline state={() => state} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("queue 2"));

      // queue row 0: a queued task can be pushed a rung up the ladder.
      t.mockInput.pressKey("e");
      await t.waitFor(() => calls.climb.length === 1);
      expect(calls.climb[0]).toBe("ts-aaa111");

      // working: focus jumps to the author's pane.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("f");
      await t.waitFor(() => calls.focus.length === 1);
      expect(calls.focus[0]).toBe("ts-bbb111");

      // review: climbing sends it back for a stronger author.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("e");
      await t.waitFor(() => calls.climb.length === 2);
      expect(calls.climb[1]).toBe("ts-bbb222");

      // landed takes no actions, and a worker-less decision cannot be taken
      // over. Both presses must be silently ignored; the retry below is the
      // barrier proving every earlier key was processed.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("e");
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("t");
      t.mockInput.pressKey("r");
      await t.waitFor(() => calls.retry.length === 1);
      expect(calls.retry[0]).toBe("ts-ccc111");
      expect(calls.climb.length).toBe(2);
      expect(calls.focus.length).toBe(1);

      // decisions row 1: a reviewer-vanished workspace can be taken over.
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("t");
      await t.waitFor(() => calls.focus.length === 2);
      expect(calls.focus[1]).toBe("ts-ccc222");

      // decisions row 2: an orphaned workspace is only ever closed. Retrying,
      // releasing or taking it over are all ignored — the task is unclaimed,
      // so nothing is there to restart, and releasing would reopen it.
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("r");
      t.mockInput.pressKey("d");
      t.mockInput.pressKey("t");
      t.mockInput.pressKey("c");
      await t.waitFor(() => calls.close.length === 1);
      expect(calls.close[0]).toBe("ts-ccc333");
      expect(calls.retry.length).toBe(1);
      expect(calls.release.length).toBe(0);

      // yours: a task waiting on the operator takes no answer key — retry,
      // climb and release would hand the next agent the same unanswered
      // question. The corrections do reach it: a rung-human climb is exactly
      // the sort of rung that can turn out to be unearned, so x lowers it.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("r");
      t.mockInput.pressKey("e");
      t.mockInput.pressKey("d");
      t.mockInput.pressKey("c");
      t.mockInput.pressKey("x");
      await t.waitFor(() => calls.descend.length === 1);
      expect(calls.descend[0]).toBe("ts-eee111");
      // ts-eee111 carries no review-by-* label, so u is ignored.
      t.mockInput.pressKey("u");

      // held: onboard salvages the uncommitted work.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("o");
      await t.waitFor(() => calls.onboard.length === 1);
      expect(calls.onboard[0]).toBe("fibrae");
      expect(calls.climb.length).toBe(2);
      expect(calls.close.length).toBe(1);

      // stranded: s sends the branch back for a review to judge its commits.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("s");
      await t.waitFor(() => calls.adopt.length === 1);
      expect(calls.adopt[0]).toBe("foreman/ts-ddd111");

      // The global keys work from any column.
      t.mockInput.pressKey("p");
      await t.waitFor(() => calls.togglePause.length === 1);
      t.mockInput.pressKey("q");
      await t.waitFor(() => calls.quit.length === 1);
    } finally {
      t.renderer.destroy();
    }
  });

  test("corrects a task's rung and clears a stale reviewer", async () => {
    const { controls, calls } = makeControls();
    const t = await testRender(() => <Pipeline state={() => corrective} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("queue 3") && f.includes("decisions 1"));

      // queue row 0 carries a rung but no reviewer: x lowers it, u is ignored.
      t.mockInput.pressKey("x");
      await t.waitFor(() => calls.descend.length === 1);
      expect(calls.descend[0]).toBe("ts-q100");
      t.mockInput.pressKey("u");

      // queue row 1 carries a stale reviewer but no rung: u clears it, x is
      // ignored — a task without a rung label is at the bottom already.
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("u");
      await t.waitFor(() => calls.unassign.length === 1);
      expect(calls.unassign[0]).toBe("ts-q200");
      t.mockInput.pressKey("x");

      // queue row 2 carries neither: both keys are ignored. The u on the
      // decision below is the barrier proving every earlier key was processed.
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("x");
      t.mockInput.pressKey("u");

      // decisions: an open task's workspace carries a reviewer nothing runs.
      // Its label is unassigned, while release stays refused — an orphaned
      // workspace is close-only. One right reaches it: nothing is working, in
      // review or landed, so none of those columns is drawn to walk past.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("u");
      await t.waitFor(() => calls.unassign.length === 2);
      expect(calls.unassign[1]).toBe("ts-d100");
      expect(calls.descend.length).toBe(1);
      t.mockInput.pressKey("d");

      // The global pause key doubles as the barrier for the ignored release.
      t.mockInput.pressKey("p");
      await t.waitFor(() => calls.togglePause.length === 1);
      expect(calls.release.length).toBe(0);
      expect(calls.unassign.length).toBe(2);
    } finally {
      t.renderer.destroy();
    }
  });
});
