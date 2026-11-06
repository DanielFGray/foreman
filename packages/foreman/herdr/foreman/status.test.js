import { describe, expect, test } from "bun:test";
import { dispatcherState, newlyLanded, projectOfCommonDir, pullRequestLine, refusalOf, rowsShownIn, STALE_MS, touches } from "./status.js";

// The pane's row selection over published rows, as main.js's rows() makes it.
describe("rowsShownIn", () => {
  // The rows a published reading carries: a stranded project's row has no
  // project (its space is closed, so no pane is scoped to it), and a held row
  // belongs to its project.
  const published = [
    { view: "attention", key: "pg", label: "stranded", project: null },
    { view: "attention", key: "ts-own", label: "stale", project: "foreman" },
    { view: "attention", key: "ts-held", label: "held", project: "pg" },
    { view: "attention", key: "ts-other", label: "stale", project: "test" },
    { view: "quota", key: "openai", label: "out of quota", project: null },
  ];

  test("a pane on another open project still shows a stranded row", () => {
    expect(rowsShownIn(published, "foreman").map((row) => row.key)).toEqual(["pg", "ts-own", "openai"]);
  });

  test("a pane with no open space shows the stranded row and fleet rows only", () => {
    expect(rowsShownIn(published, null).map((row) => row.key)).toEqual(["pg", "openai"]);
  });
});

describe("dispatcherState", () => {
  const at = "2026-11-03T12:00:00.000Z";
  const now = Date.parse(at) + 5000;
  test("no file is offline", () => expect(dispatcherState(null, now).state).toBe("offline"));
  test("a one-shot file names no dispatcher", () =>
    expect(dispatcherState({ observedAt: at, dispatcher: null }, now).state).toBe("no dispatcher"));
  test("failed wins over age", () =>
    expect(dispatcherState({ observedAt: at, dispatcher: { state: "failed" } }, now + STALE_MS).state).toBe("failed"));
  test("an old reading is stale", () =>
    expect(dispatcherState({ observedAt: at, dispatcher: { state: "running" } }, now + STALE_MS).state).toBe("stale"));
  test("a fresh reading names its own state", () =>
    expect(dispatcherState({ observedAt: at, dispatcher: { state: "paused" } }, now)).toEqual({ state: "paused", age: 5000 }));
});

describe("projectOfCommonDir", () => {
  test("names the checkout folder", () => expect(projectOfCommonDir("/home/u/build/foreman/.git")).toBe("foreman"));
  test("no common dir is no project", () => expect(projectOfCommonDir("")).toBe(null));
});

describe("newlyLanded", () => {
  test("the first reading only records", () => expect(newlyLanded(null, ["ts-aaaaaa"])).toEqual([]));
  test("answers the keys not landed before", () =>
    expect(newlyLanded(new Set(["ts-aaaaaa"]), ["ts-aaaaaa", "ts-bbbbbb"])).toEqual(["ts-bbbbbb"]));
});

test("pullRequestLine joins what is known", () =>
  expect(pullRequestLine({ number: 7, state: "open", checks: "passing", waiting: "you", url: "u" }))
    .toBe("PR #7 open · checks passing · waits for your approval · u"));

describe("refusalOf", () => {
  const stack = "    at <anonymous> (/repo/packages/foreman/src/pipeline-command.ts:141:56)";
  test("a one-line refusal is its message", () =>
    expect(refusalOf({
      code: 1,
      stderr: `[09:18:18.988] ERROR (#2): PipelineError: author cannot lead to nowhere: one of them is not in the pipeline\n${stack}\n`,
    })).toBe("author cannot lead to nowhere: one of them is not in the pipeline"));
  test("a listed refusal reads on one line, its reasons after the heading", () =>
    expect(refusalOf({
      code: 1,
      stderr: [
        "[09:18:17.864] ERROR (#2): PipelineError: the pipeline cannot run:",
        "  a route from queue reaches worktree with no branch before it",
        "  a route from queue reaches land with no branch before it",
        stack,
      ].join("\n"),
    })).toBe("the pipeline cannot run: a route from queue reaches worktree with no branch before it; a route from queue reaches land with no branch before it"));
  test("a silent refusal names the exit code", () =>
    expect(refusalOf({ code: 3, stderr: "" })).toBe("foreman exited 3"));
});

describe("touches", () => {
  const folder = "/s/foreman";
  const file = "/s/foreman/state.json";
  test("a batch naming the file", () => expect(touches([`${folder}/foreman.jsonl`, file], folder, file)).toBe(true));
  test("a batch naming only the folder stands for any change", () => expect(touches([folder], folder, file)).toBe(true));
  test("a batch of siblings only", () =>
    expect(touches([`${folder}/foreman.jsonl`, `${folder}/worktrees/a/x.ts`, `${folder}/.state.json.tmp`], folder, file)).toBe(false));
});
