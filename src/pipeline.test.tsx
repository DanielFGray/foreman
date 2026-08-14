/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { Active, FleetState } from "./dispatcher.ts";
import type { Worker, WorkerState } from "./fleet.ts";
import { decisionKind, Pipeline, type Controls } from "./pipeline.tsx";
import { authoredBy, reviewedBy, type Item } from "./prog.ts";

const task = (id: string, status: string, labels: ReadonlyArray<string>): Item => ({
  id,
  title: `task ${id}`,
  status,
  project: "fibrae",
  type: "task",
  priority: 1,
  labels,
  last_activity_at: new Date(),
});

const worker = (task: string, state: WorkerState): Worker => ({
  task,
  workspace: `ws-${task}`,
  pane: `pane-${task}`,
  directory: `/tmp/${task}`,
  worktree: `/tmp/wt-${task}`,
  state,
  authorState: state,
  reviewState: undefined,
});

const active = (task: Item, worker: Worker | undefined): Active => ({
  task,
  worker,
  kind: reviewedBy(task) ?? authoredBy(task),
});

const state: FleetState = {
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

interface Calls {
  quit: Array<string>;
  togglePause: Array<string>;
  toggleConsole: Array<string>;
  focus: Array<string>;
  retry: Array<string>;
  release: Array<string>;
  escalate: Array<string>;
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
    escalate: [],
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
    escalate: (t) => calls.escalate.push(t.id),
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

  test("names a task with no attribution an orphaned workspace", () => {
    expect(decisionKind(task("ts-1", "in_progress", []))).toBe("orphaned workspace");
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
        (f) => f.includes("queue 2") && f.includes("decisions 2") && f.includes("held 1"),
      );
      const frame = t.captureCharFrame();
      expect(frame).toContain("author vanished");
      expect(frame).toContain("reviewer vanished");
      expect(frame).toContain("fibrae");
      expect(frame).toContain("awaiting a decision");
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

      // queue row 0: escalate forces frontier for a queued task.
      t.mockInput.pressKey("e");
      await t.waitFor(() => calls.escalate.length === 1);
      expect(calls.escalate[0]).toBe("ts-aaa111");

      // working: focus jumps to the author's pane.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("f");
      await t.waitFor(() => calls.focus.length === 1);
      expect(calls.focus[0]).toBe("ts-bbb111");

      // review: escalate sends it back for a stronger author.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("e");
      await t.waitFor(() => calls.escalate.length === 2);
      expect(calls.escalate[1]).toBe("ts-bbb222");

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
      expect(calls.escalate.length).toBe(2);
      expect(calls.focus.length).toBe(1);

      // decisions row 1: a reviewer-vanished workspace can be taken over.
      t.mockInput.pressArrow("down");
      t.mockInput.pressKey("t");
      await t.waitFor(() => calls.focus.length === 2);
      expect(calls.focus[1]).toBe("ts-ccc222");

      // held: onboard salvages the uncommitted work.
      t.mockInput.pressArrow("right");
      t.mockInput.pressKey("o");
      await t.waitFor(() => calls.onboard.length === 1);
      expect(calls.onboard[0]).toBe("fibrae");

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
});
