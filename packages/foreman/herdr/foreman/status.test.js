import { describe, expect, test } from "bun:test";
import { dispatcherState, newlyLanded, projectOfCommonDir, pullRequestLine, STALE_MS } from "./status.js";

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
