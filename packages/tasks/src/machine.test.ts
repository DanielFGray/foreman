import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { TASK_MACHINE, type TaskEvent, type TaskState } from "./item.ts";
import { type Machine, routeTo, toMermaid, transition } from "./machine.ts";

const move = (state: TaskState, event: TaskEvent) =>
  Option.getOrUndefined(transition(TASK_MACHINE, state, event));

describe("the task machine", () => {
  test.each<[TaskState, TaskEvent, TaskState]>([
    ["proposed", "open", "open"],
    ["draft", "open", "open"],
    ["open", "start", "in_progress"],
    ["done", "start", "in_progress"],
    ["canceled", "start", "in_progress"],
    ["in_progress", "open", "open"],
    ["in_progress", "done", "done"],
    ["open", "done", "done"],
    ["done", "open", "open"],
    ["canceled", "open", "open"],
  ])("%s --%s--> %s", (from, event, to) => {
    expect(move(from, event)).toBe(to);
  });

  test.each<[TaskState, TaskEvent]>([
    ["proposed", "start"],
    ["draft", "start"],
    ["in_progress", "start"],
    ["proposed", "done"],
    ["draft", "done"],
    ["done", "cancel"],
    ["canceled", "done"],
    ["open", "open"],
  ])("refuses %s --%s-->", (from, event) => {
    expect(move(from, event)).toBeUndefined();
  });

  test("draws one arrow per allowed move", () => {
    const moves = Object.values(TASK_MACHINE.on).flatMap((targets) => Object.keys(targets));
    const arrows = toMermaid(TASK_MACHINE)
      .split("\n")
      .filter((line) => / --> \w+: /.test(line));
    expect(arrows).toHaveLength(moves.length);
    expect(arrows).toContain("  open --> in_progress: start");
    expect(arrows).toContain("  done --> in_progress: start");
    expect(arrows).toContain("  canceled --> in_progress: start");
    expect(arrows.every((arrow) => !arrow.includes("reviewing"))).toBe(true);
  });
});

describe("routeTo", () => {
  test("one hop: a proposal reaches done through open", () => {
    expect(routeTo(TASK_MACHINE, "proposed", "done")).toEqual(Option.some(["open", "done"]));
  });

  test("two hops: the moves come in order, then the event", () => {
    expect(routeTo(LINE, "a", "fin")).toEqual(Option.some(["go", "go", "fin"]));
  });

  test("none: no move reaches the event", () => {
    expect(routeTo(LINE, "d", "fin")).toEqual(Option.none());
  });
});

/** a -go-> b -go-> c, and `fin` is allowed only at c. */
const LINE: Machine<"a" | "b" | "c" | "d", "go" | "fin"> = {
  id: "line",
  states: ["a", "b", "c", "d"],
  events: ["go", "fin"],
  initial: ["a"],
  on: {
    go: { a: "b", b: "c" },
    fin: { c: "d" },
  },
};
