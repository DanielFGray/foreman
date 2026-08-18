/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { DateTime } from "effect";
import { createSignal, type Accessor } from "solid-js";
import type { Active, FleetState } from "./dispatcher.ts";
import type { Worker, WorkerState } from "./fleet.ts";
import {
  decisionKind,
  Pipeline as DashboardPipeline,
  staleReview,
  type Controls,
} from "./pipeline.tsx";
import { authoredBy, reviewedBy, type Item, type ReadyTask, type TaskStatus } from "./prog.ts";

const RUNGS = ["flash", "pro", "sol"];
const Pipeline = (props: { readonly state: Accessor<FleetState>; readonly controls: Controls }) => (
  <DashboardPipeline {...props} rungs={RUNGS} />
);

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

const held = (project: string) => ({
  project,
  reason: "dirty" as const,
  detail: "uncommitted changes to tracked files",
});

const state: FleetState = {
  yours: [
    {
      id: "ts-eee111",
      title: "needs a decision",
      priority: 2,
      project: "fibrae",
      labels: ["rung-human"],
      last_activity_at: new Date(),
    },
  ],
  queue: [
    {
      id: "ts-aaa111",
      title: "queue one",
      priority: 1,
      project: "fibrae",
      labels: [],
      last_activity_at: new Date(),
    },
    {
      id: "ts-aaa222",
      title: "queue two",
      priority: 2,
      project: "fibrae",
      labels: [],
      last_activity_at: new Date(),
    },
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
  held: [held("fibrae")],
  unreviewed: [
    {
      project: "fibrae",
      branch: "foreman/ts-ddd111",
      task: "ts-ddd111",
      title: "abandoned work",
      status: "done",
      activity: new Date("2026-08-15T10:00:00Z"),
    },
    // A branch whose task was deleted: it still shows, because the commits are
    // real, but there is nothing to send for review.
    {
      project: "fibrae",
      branch: "foreman/ts-ddd222",
      task: "ts-ddd222",
      title: undefined,
      status: undefined,
      activity: undefined,
    },
  ],
  committed: new Set(["ts-bbb222"]),
  resumable: new Set(["ts-bbb111", "ts-bbb222"]),
  dispatch: "running",
  observedAt: undefined,
};

// The shapes the corrective keys act on: rows that carry a rung-* label, rows
// that carry a review-by-* label no reviewer is behind, and rows that carry
// neither.
const corrective: FleetState = {
  yours: [],
  queue: [
    {
      id: "ts-q100",
      title: "pinned up",
      priority: 1,
      project: "fibrae",
      labels: ["rung-top"],
      last_activity_at: new Date(),
    },
    {
      id: "ts-q200",
      title: "stale reviewer",
      priority: 1,
      project: "fibrae",
      labels: ["review-by-claude"],
      last_activity_at: new Date(),
    },
    {
      id: "ts-q300",
      title: "fresh",
      priority: 1,
      project: "fibrae",
      labels: [],
      last_activity_at: new Date(),
    },
  ],
  working: [],
  review: [],
  landed: [],
  decisions: [
    // An open task's workspace, carrying a reviewer the world no longer has.
    active(task("ts-d100", "open", ["by-opencode", "review-by-claude"]), worker("ts-d100", "gone")),
  ],
  held: [],
  unreviewed: [],
  committed: new Set(),
  resumable: new Set(["ts-d100"]),
  dispatch: "running",
  observedAt: undefined,
};

interface Calls {
  quit: Array<string>;
  cycleDispatch: Array<string>;
  toggleConsole: Array<string>;
  focus: Array<string>;
  retry: Array<string>;
  release: Array<string>;
  close: Array<string>;
  descend: Array<string>;
  unassign: Array<string>;
  onboard: Array<string>;
  adopt: Array<string>;
  complete: Array<string>;
  diagnose: Array<string>;
  reviewIntervention: Array<string>;
  continueAt: Array<string>;
}

const makeControls = (): { controls: Controls; calls: Calls } => {
  const calls: Calls = {
    quit: [],
    cycleDispatch: [],
    toggleConsole: [],
    focus: [],
    retry: [],
    release: [],
    close: [],
    descend: [],
    unassign: [],
    onboard: [],
    adopt: [],
    complete: [],
    diagnose: [],
    reviewIntervention: [],
    continueAt: [],
  };
  const controls: Controls = {
    quit: () => calls.quit.push("quit"),
    cycleDispatch: () => calls.cycleDispatch.push("cycle"),
    toggleConsole: () => calls.toggleConsole.push("console"),
    focus: (w) => calls.focus.push(w.task),
    retry: (t) => calls.retry.push(t.id),
    release: (t) => calls.release.push(t.id),
    close: (t) => calls.close.push(t.id),
    descend: (t) => calls.descend.push(t.id),
    unassign: (t) => calls.unassign.push(t.id),
    onboard: (p) => calls.onboard.push(p),
    adopt: (o) => calls.adopt.push(o.branch),
    complete: (t, reason) => calls.complete.push(`${t.id}:${reason}`),
    diagnose: (target, intent, rung) => calls.diagnose.push(`${target.task.id}:${intent}:${rung}`),
    reviewIntervention: (target, rung) =>
      calls.reviewIntervention.push(`${target.task.id}:${rung ?? "formal"}`),
    continueAt: (target, rung) => calls.continueAt.push(`${target.task.id}:${rung}`),
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

  test("names a dispatch failure from the error, not the status", () => {
    // A task whose dispatch failed is ordinary queue work — open, unclaimed —
    // so only the failure itself distinguishes it from an orphaned workspace.
    expect(decisionKind(task("ts-1", "open", ["by-opencode"]), "open: already exists")).toBe(
      "dispatch failed",
    );
    expect(decisionKind(task("ts-1", "open", ["by-opencode"]))).toBe("orphaned workspace");
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
      last_activity_at: new Date(),
    };
    expect(staleReview(ready, undefined)).toBe(true);
  });
});

describe("Pipeline", () => {
  test("renders the pipeline and names each decision", async () => {
    const { controls } = makeControls();
    const t = await testRender(() => <Pipeline state={() => state} controls={controls} />, {
      width: 92,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 2") && f.includes("Attention 7"));
      const frame = t.captureCharFrame();
      expect(frame).toContain("author vanished");
      expect(frame).toContain("reviewer vanished");
      expect(frame).toContain("orphaned workspace");
      expect(frame.indexOf("author vanished")).toBeLessThan(frame.indexOf("needs you"));
      expect(frame.indexOf("needs you")).toBeLessThan(frame.indexOf("unreviewed"));
      expect(frame.indexOf("unreviewed")).toBeLessThan(frame.indexOf("held"));
      expect(frame).toContain("fibrae");
      expect(frame).toContain("7 need attention");
      expect(frame).not.toContain("selection");
    } finally {
      t.renderer.destroy();
    }
  });

  // The whole point of the held column: the same word must not cover a tree
  // that clears itself and a checkout no command in the fleet can clear. The
  // row names which of the four causes is holding the project.
  test("says why each held project is held", async () => {
    const { controls } = makeControls();
    const heldState: FleetState = {
      ...state,
      decisions: [],
      yours: [],
      unreviewed: [],
      held: [
        held("fibrae"),
        {
          project: "amux",
          reason: "noBranch",
          detail: "2 bookmark candidates behind the working copy: develop, test-setup",
        },
        { project: "pty", reason: "unreadable", detail: "could not read the checkout" },
      ],
    };
    const t = await testRender(() => <Pipeline state={() => heldState} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Attention 3"));
      const frame = t.captureCharFrame();
      expect(frame).toContain("uncommitted changes to tracked files");
      // The row truncates at the terminal edge, so the assertion reads the
      // prefix that is on screen; the candidates are what the fix names.
      expect(frame).toContain("2 bookmark candidates behind the working copy: develop,");
      expect(frame).toContain("could not read the checkout");
    } finally {
      t.renderer.destroy();
    }
  });

  // Onboarding salvages uncommitted work, so a hold that is not uncommitted
  // work has nothing for it: offering the top-rung run on a clean tree would
  // spend it discovering there is nothing there.
  test("offers onboarding only for a hold that is uncommitted work", async () => {
    const { controls } = makeControls();
    const heldState: FleetState = {
      ...state,
      decisions: [],
      yours: [],
      unreviewed: [],
      held: [
        held("fibrae"),
        {
          project: "amux",
          reason: "noBranch",
          detail: "no bookmark behind the working copy",
        },
      ],
    };
    const t = await testRender(() => <Pipeline state={() => heldState} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Attention 2"));
      expect(t.captureCharFrame()).toContain("o onboard");

      t.mockInput.pressKey("j");
      await t.flush();
      expect(t.captureCharFrame()).not.toContain("o onboard");
    } finally {
      t.renderer.destroy();
    }
  });

  // A tick that is landing runs a project's whole test suite before it reads
  // the world again, and a fleet doing that was indistinguishable from a wedged
  // one. The age of the last read is the only thing that tells them apart.
  test("says how long ago the dispatcher last read the world", async () => {
    const { controls } = makeControls();
    const stale: FleetState = {
      ...state,
      observedAt: DateTime.subtract(DateTime.unsafeNow(), { minutes: 4 }),
    };
    const t = await testRender(() => <Pipeline state={() => stale} controls={controls} />, {
      width: 92,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("read 4m ago"));
    } finally {
      t.renderer.destroy();
    }
  });

  // Before the first tick completes there is no reading to be old, and the
  // status line must not imply one was taken at startup.
  test("says it is starting before the first reading", async () => {
    const { controls } = makeControls();
    const t = await testRender(() => <Pipeline state={() => state} controls={controls} />, {
      width: 92,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("running  ·  starting"));
    } finally {
      t.renderer.destroy();
    }
  });

  test("uses extra width for selected-task details", async () => {
    const { controls } = makeControls();
    const t = await testRender(() => <Pipeline state={() => state} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 2") && f.includes("selection"));
      const frame = t.captureCharFrame();
      expect(frame).toContain("ts-ccc111");
      expect(frame).toContain("status    in_progress");
      expect(frame).toContain("priority  1");
    } finally {
      t.renderer.destroy();
    }
  });

  test("opens attention only when it changes from empty to non-empty", async () => {
    const { controls } = makeControls();
    const quiet: FleetState = {
      ...state,
      working: [],
      review: [],
      landed: [],
      decisions: [],
      yours: [],
      held: [],
      unreviewed: [],
    };
    const [current, setCurrent] = createSignal(quiet);
    const t = await testRender(() => <Pipeline state={current} controls={controls} />, {
      width: 92,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 1/2"));

      setCurrent({ ...quiet, held: [held("fibrae")] });
      await t.waitForFrame((f) => f.includes("Attention 1/1"));

      t.mockInput.pressArrow("left");
      await t.waitForFrame((f) => f.includes("Queue 1/2"));
      setCurrent({ ...quiet, held: [held("fibrae"), held("amux")] });
      await t.flush();
      expect(t.captureCharFrame()).toContain("Queue 1/2");

      setCurrent(quiet);
      await t.flush();
      setCurrent({ ...quiet, held: [held("amux")] });
      await t.waitForFrame((f) => f.includes("Attention 1/1"));
    } finally {
      t.renderer.destroy();
    }
  });

  test("shows only actions valid for the selected row", async () => {
    const { controls } = makeControls();
    const t = await testRender(() => <Pipeline state={() => corrective} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 3"));
      t.mockInput.pressArrow("left");
      await t.flush();
      expect(t.captureCharFrame()).toContain("e intervene");
      expect(t.captureCharFrame()).not.toContain("u unassign");

      t.mockInput.pressArrow("down");
      await t.flush();
      expect(t.captureCharFrame()).not.toContain("x descend");
      expect(t.captureCharFrame()).toContain("u unassign");

      t.mockInput.pressArrow("down");
      await t.flush();
      expect(t.captureCharFrame()).not.toContain("u unassign");
      expect(t.captureCharFrame()).not.toContain("x descend");
    } finally {
      t.renderer.destroy();
    }
  });

  test("surfaces a dispatch failure with the error, and retries it", async () => {
    const { controls, calls } = makeControls();
    const failed: FleetState = {
      ...corrective,
      decisions: [
        {
          task: task("ts-f100", "open", ["by-opencode"]),
          worker: undefined,
          kind: undefined,
          failure: "FleetError: open: worktree_create_failed: already exists",
        },
      ],
    };
    const t = await testRender(() => <Pipeline state={() => failed} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Attention 1"));
      const frame = t.captureCharFrame();
      expect(frame).toContain("dispatch failed");
      expect(frame).toContain("worktree_create_failed");

      // The decision opens as the selected view, so retry reaches it directly.
      t.mockInput.pressKey("r");
      await t.waitFor(() => calls.retry.length === 1);
      expect(calls.retry[0]).toBe("ts-f100");
    } finally {
      t.renderer.destroy();
    }
  });

  test("asks for a reason before marking a queued task done", async () => {
    const { controls, calls } = makeControls();
    const t = await testRender(() => <Pipeline state={() => corrective} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 3"));
      t.mockInput.pressArrow("left");
      await t.flush();
      t.mockInput.pressKey("D");
      await t.flush();
      expect(t.captureCharFrame()).toContain("Reason for ts-q100");
      await t.mockInput.typeText("obsolete task");
      t.mockInput.pressEnter();
      await t.waitFor(() => calls.complete.length === 1);
      expect(calls.complete[0]).toBe("ts-q100:obsolete task");
    } finally {
      t.renderer.destroy();
    }
  });

  test("offers only continuation when queued work has no prior attempt", async () => {
    const { controls, calls } = makeControls();
    const quiet = { ...corrective, decisions: [], resumable: new Set<string>() };
    const t = await testRender(() => <Pipeline state={() => quiet} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 1/3"));
      t.mockInput.pressKey("e");
      await t.waitForFrame((f) => f.includes("c continue"));
      const menu = t.captureCharFrame();
      expect(menu).not.toContain("d diagnose");
      expect(menu).not.toContain("r review");

      t.mockInput.pressKey("c");
      await t.waitForFrame((f) => f.includes("continue rung"));
      t.mockInput.pressArrow("down");
      t.mockInput.pressEnter();
      await t.waitFor(() => calls.continueAt.length === 1);
      expect(calls.continueAt[0]).toBe("ts-q100:pro");
    } finally {
      t.renderer.destroy();
    }
  });

  test("diagnoses uncommitted work and formally reviews committed work", async () => {
    const { controls, calls } = makeControls();
    const worked: FleetState = {
      ...corrective,
      decisions: [],
      resumable: new Set(["ts-q100", "ts-q200"]),
      committed: new Set(["ts-q200"]),
    };
    const t = await testRender(() => <Pipeline state={() => worked} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 1/3"));
      t.mockInput.pressKey("e");
      await t.waitForFrame((f) => f.includes("d diagnose") && f.includes("r review"));
      t.mockInput.pressKey("d");
      await t.waitForFrame((f) => f.includes("diagnose rung"));
      t.mockInput.pressArrow("down");
      t.mockInput.pressEnter();
      await t.waitFor(() => calls.diagnose.length === 1);
      expect(calls.diagnose[0]).toBe("ts-q100:diagnose:pro");

      t.mockInput.pressKey("e");
      t.mockInput.pressKey("r");
      await t.waitForFrame((f) => f.includes("review rung"));
      t.mockInput.pressEnter();
      await t.waitFor(() => calls.reviewIntervention.length === 1);
      expect(calls.reviewIntervention[0]).toBe("ts-q100:flash");

      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("e");
      await t.waitForFrame((f) => f.includes("r review"));
      t.mockInput.pressKey("r");
      await t.waitFor(() => calls.reviewIntervention.length === 2);
      expect(calls.reviewIntervention[1]).toBe("ts-q200:formal");
    } finally {
      t.renderer.destroy();
    }
  });

  test("selects a row by clicking it", async () => {
    const { controls, calls } = makeControls();
    const t = await testRender(() => <Pipeline state={() => corrective} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 3"));
      t.mockInput.pressArrow("left");
      await t.flush();
      await t.mockMouse.click(10, 3);
      t.mockInput.pressKey("u");
      await t.waitFor(() => calls.unassign.length === 1);
      expect(calls.unassign[0]).toBe("ts-q200");
    } finally {
      t.renderer.destroy();
    }
  });

  // An idle fleet is the ordinary case, and a screen of bordered boxes all
  // titled zero says nothing the counts do not. Nothing drawn is nothing
  // reachable either: the cursor stays where there is work rather than walking
  // through columns the operator cannot see.
  test("draws no column for an empty list, and does not let the cursor into one", async () => {
    const { controls } = makeControls();
    const quiet: FleetState = {
      ...state,
      working: [],
      review: [],
      landed: [],
      decisions: [],
      yours: [],
      held: [],
      unreviewed: [],
    };
    const t = await testRender(() => <Pipeline state={() => quiet} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 2"));
      const frame = t.captureCharFrame();
      // A drawn column carries its count in the border title, so that is what
      // must be absent — the key hints below name several of these words.
      for (const empty of ["Working", "Review", "Landed", "Attention"])
        expect(frame).not.toContain(`${empty} 0`);

      // Right from the only column wraps back onto itself, so its menu still
      // opens rather than targeting an invisible view.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("e");
      await t.waitForFrame((f) => f.includes("c continue"));
    } finally {
      t.renderer.destroy();
    }
  });

  test("an empty fleet keeps only its status and controls", async () => {
    const { controls } = makeControls();
    const empty: FleetState = {
      ...state,
      queue: [],
      working: [],
      review: [],
      landed: [],
      decisions: [],
      yours: [],
      held: [],
      unreviewed: [],
    };
    const t = await testRender(() => <Pipeline state={() => empty} controls={controls} />, {
      width: 92,
      height: 20,
    });
    try {
      await t.waitForFrame((f) => f.includes("0 need attention"));
      const frame = t.captureCharFrame();
      expect(frame).not.toContain("Queue 0");
      expect(frame).not.toContain("1/0");
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
        last_activity_at: new Date(),
      })),
      decisions: [],
      yours: [
        {
          id: "ts-y1",
          title: "yours one",
          priority: 2,
          project: "fibrae",
          labels: ["rung-top"],
          last_activity_at: new Date(),
        },
        {
          id: "ts-y2",
          title: "yours two",
          priority: 2,
          project: "fibrae",
          labels: ["rung-top"],
          last_activity_at: new Date(),
        },
        {
          id: "ts-y3",
          title: "yours three",
          priority: 2,
          project: "fibrae",
          labels: ["rung-top"],
          last_activity_at: new Date(),
        },
      ],
    };
    const t = await testRender(() => <Pipeline state={() => long} controls={controls} />, {
      width: 120,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 30"));
      t.mockInput.pressArrow("left");
      await t.flush();

      await t.mockMouse.scroll(10, 5, "down");
      await t.flush();
      const frame = t.captureCharFrame();
      // The first row is still the first row: the viewport did not move on its
      // own. The cursor did, and it is the only thing that moved.
      expect(frame).toContain("  fibrae  queued 0");
      expect(frame).toContain("> fibrae  queued 1");

      t.mockInput.pressKey("\x1b[6~");
      await t.flush();
      expect(t.captureCharFrame()).toContain("> fibrae  queued 6");

      // Changing tabs resets the row; two steps reach the last attention item.
      t.mockInput.pressArrow("right");
      t.mockInput.pressArrow("down");
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("x");
      await t.waitFor(() => calls.descend.length === 1);
      expect(calls.descend[0]).toBe("ts-y3");
    } finally {
      t.renderer.destroy();
    }
  });

  test("follows a tracked task from queue through working to review", async () => {
    const { controls } = makeControls();
    const alpha: ReadyTask = {
      id: "ts-a",
      title: "alpha",
      priority: 1,
      project: "fibrae",
      labels: [],
      last_activity_at: new Date(),
    };
    const beta: ReadyTask = {
      id: "ts-b",
      title: "beta",
      priority: 1,
      project: "fibrae",
      labels: [],
      last_activity_at: new Date(),
    };
    const base: FleetState = {
      ...state,
      working: [],
      review: [],
      landed: [],
      decisions: [],
      yours: [],
      held: [],
      unreviewed: [],
      queue: [alpha, beta],
    };
    const [current, setCurrent] = createSignal(base);
    const t = await testRender(() => <Pipeline state={current} controls={controls} />, {
      width: 92,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 1/2"));

      // A tick claims ts-a: it leaves the queue and the highlight follows it
      // into working, instead of a positional cursor sitting on whatever now
      // holds the old spot in the queue.
      setCurrent({
        ...base,
        queue: [beta],
        working: [active(task("ts-a", "in_progress", ["by-opencode"]), worker("ts-a", "working"))],
      });
      await t.waitForFrame((f) => f.includes("Working 1/1"));
      expect(t.captureCharFrame()).toContain("> opencode  task ts-a");

      // It settles, and the follow carries it into review the same way.
      setCurrent({
        ...base,
        queue: [beta],
        review: [active(task("ts-a", "reviewing", ["by-opencode"]), worker("ts-a", "working"))],
      });
      await t.waitForFrame((f) => f.includes("Review 1/1"));
      expect(t.captureCharFrame()).toContain("> opencode  task ts-a");
    } finally {
      t.renderer.destroy();
    }
  });

  test("gives up the cursor to the nearest surviving row when the tracked task lands", async () => {
    const { controls } = makeControls();
    const queued = (id: string, title: string): ReadyTask => ({
      id,
      title,
      priority: 1,
      project: "fibrae",
      labels: [],
      last_activity_at: new Date(),
    });
    const base: FleetState = {
      ...state,
      working: [],
      review: [],
      landed: [],
      decisions: [],
      yours: [],
      held: [],
      unreviewed: [],
      queue: [queued("ts-a", "queued a"), queued("ts-b", "queued b"), queued("ts-c", "queued c")],
    };
    const [current, setCurrent] = createSignal(base);
    const t = await testRender(() => <Pipeline state={current} controls={controls} />, {
      width: 92,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 1/3"));
      t.mockInput.pressArrow("down");
      await t.flush();

      // ts-b lands: the follow stops at the review gate, so the cursor stays
      // in the queue on the row that survived next to it rather than chasing
      // the finished task into history.
      setCurrent({
        ...base,
        queue: [queued("ts-a", "queued a"), queued("ts-c", "queued c")],
        landed: [task("ts-b", "done", [])],
      });
      await t.waitForFrame((f) => f.includes("Queue 2/2"));
      const frame = t.captureCharFrame();
      expect(frame).toContain("> fibrae  queued c");
      expect(frame).not.toContain("Landed 1/1");
    } finally {
      t.renderer.destroy();
    }
  });

  test("keeps the highlight on the tracked task when rows shift under it", async () => {
    const { controls } = makeControls();
    const base: FleetState = {
      ...state,
      working: [],
      review: [],
      landed: [],
      decisions: [],
      yours: [],
      held: [],
      unreviewed: [],
      queue: ["a", "b", "c"].map((letter) => ({
        id: `ts-${letter}`,
        title: `queued ${letter}`,
        priority: 1,
        project: "fibrae",
        labels: [],
        last_activity_at: new Date(),
      })),
    };
    const [current, setCurrent] = createSignal(base);
    const t = await testRender(() => <Pipeline state={current} controls={controls} />, {
      width: 92,
      height: 30,
    });
    try {
      await t.waitForFrame((f) => f.includes("Queue 1/3"));
      t.mockInput.pressArrow("down");
      t.mockInput.pressArrow("down");
      await t.flush();

      // A higher-priority task arrives at the head of the queue. A positional
      // cursor would now sit on ts-b; the id cursor stays on ts-c, which moved
      // to the fourth row.
      setCurrent({
        ...base,
        queue: [
          {
            id: "ts-x",
            title: "pinned",
            priority: 1,
            project: "fibrae",
            labels: [],
            last_activity_at: new Date(),
          },
          ...base.queue,
        ],
      });
      await t.waitForFrame((f) => f.includes("Queue 4/4"));
      expect(t.captureCharFrame()).toContain("> fibrae  queued c");
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
      await t.waitForFrame((f) => f.includes("Queue 2"));
      t.mockInput.pressArrow("right");

      // working: focus jumps to the author's pane.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("f");
      await t.waitFor(() => calls.focus.length === 1);
      expect(calls.focus[0]).toBe("ts-bbb111");

      // review: focus jumps to the review workspace too.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("f");
      await t.waitFor(() => calls.focus.length === 2);
      expect(calls.focus[1]).toBe("ts-bbb222");

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
      expect(calls.focus.length).toBe(2);

      // decisions row 1: a reviewer-vanished workspace can be taken over.
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("t");
      await t.waitFor(() => calls.focus.length === 3);
      expect(calls.focus[2]).toBe("ts-ccc222");

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

      // The next attention row is yours. A task waiting on the operator takes no answer key — retry,
      // climb and release would hand the next agent the same unanswered
      // question. The corrections do reach it: a rung-human climb is exactly
      // the sort of rung that can turn out to be unearned, so x lowers it.
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("r");
      t.mockInput.pressKey("d");
      t.mockInput.pressKey("c");
      t.mockInput.pressKey("x");
      await t.waitFor(() => calls.descend.length === 1);
      expect(calls.descend[0]).toBe("ts-eee111");
      // ts-eee111 carries no review-by-* label, so u is ignored.
      t.mockInput.pressKey("u");

      // Stranded follows yours in urgency order.
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("s");
      await t.waitFor(() => calls.adopt.length === 1);
      expect(calls.adopt[0]).toBe("foreman/ts-ddd111");

      // Held is last; two more rows pass the deleted-task branch and reach it.
      t.mockInput.pressArrow("down");
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("o");
      await t.waitFor(() => calls.onboard.length === 1);
      expect(calls.onboard[0]).toBe("fibrae");
      expect(calls.close.length).toBe(1);

      // The global keys work from any column.
      t.mockInput.pressKey("p");
      await t.waitFor(() => calls.cycleDispatch.length === 1);
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
      await t.waitForFrame((f) => f.includes("Queue 3") && f.includes("Attention 1"));
      t.mockInput.pressArrow("left");

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

      // The global dispatch key doubles as the barrier for the ignored release.
      t.mockInput.pressKey("p");
      await t.waitFor(() => calls.cycleDispatch.length === 1);
      expect(calls.release.length).toBe(0);
      expect(calls.unassign.length).toBe(2);
    } finally {
      t.renderer.destroy();
    }
  });
});
