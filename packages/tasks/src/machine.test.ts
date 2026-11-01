import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { TASK_MACHINE, type TaskEvent, type TaskState } from "./item.ts";
import { toMermaid, transition } from "./machine.ts";

const move = (state: TaskState, event: TaskEvent) =>
  Option.getOrUndefined(transition(TASK_MACHINE, state, event));

describe("the task machine", () => {
  test.each<[TaskState, TaskEvent, TaskState]>([
    ["proposed", "open", "open"],
    ["draft", "open", "open"],
    ["open", "start", "in_progress"],
    ["in_progress", "review", "reviewing"],
    ["reviewing", "open", "open"],
    ["reviewing", "done", "done"],
    ["open", "done", "done"],
    ["done", "open", "open"],
    ["canceled", "open", "open"],
  ])("%s --%s--> %s", (from, event, to) => {
    expect(move(from, event)).toBe(to);
  });

  test.each<[TaskState, TaskEvent]>([
    ["done", "start"],
    ["reviewing", "start"],
    ["proposed", "start"],
    ["draft", "start"],
    ["open", "review"],
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
    expect(arrows).toContain("  in_progress --> reviewing: review");
  });
});
