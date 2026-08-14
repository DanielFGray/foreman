import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import type { WorkerState } from "./fleet.ts";
import { decide, resolveProject, stageFor, titleFor } from "./plan.ts";

describe("stageFor", () => {
  test("routes by stored epic status", () => {
    expect(stageFor("draft")).toBe("planning");
    expect(stageFor("open")).toBe("tasking");
    expect(stageFor("in_progress")).toBe("tasking");
    expect(stageFor("done")).toBe("complete");
    expect(stageFor("canceled")).toBe("complete");
  });
});

describe("decide", () => {
  const working: WorkerState = "working";
  const settled: WorkerState = "settled";
  const gone: WorkerState = "gone";

  test("waits while the agent is working or blocked", () => {
    expect(decide("planning", working, "draft")).toBe("wait");
    expect(decide("planning", "blocked", "draft")).toBe("wait");
    expect(decide("tasking", working, "open")).toBe("wait");
  });

  test("planning advances when the spec is written", () => {
    expect(decide("planning", settled, "open")).toBe("advance");
    expect(decide("planning", settled, "done")).toBe("advance");
    expect(decide("planning", settled, "canceled")).toBe("advance");
  });

  test("tasking advances only when the epic is complete", () => {
    expect(decide("tasking", settled, "done")).toBe("advance");
    expect(decide("tasking", settled, "canceled")).toBe("advance");
  });

  test("fails when the agent settles without the transition", () => {
    expect(decide("planning", settled, "draft")).toBe("failed");
    expect(decide("planning", gone, "draft")).toBe("failed");
    expect(decide("tasking", settled, "open")).toBe("failed");
  });
});

describe("titleFor", () => {
  test("derives from the first non-empty line", () => {
    expect(titleFor("")).toBe("Plan");
    expect(titleFor("   \n\n")).toBe("Plan");
    expect(titleFor("\n\n# Build auth\n\nbody")).toBe("Build auth");
    expect(titleFor("- Install foo\nrest")).toBe("Install foo");
    expect(titleFor("plain line\nmore")).toBe("plain line");
  });

  test("truncates an over-long first line", () => {
    expect(titleFor("x".repeat(120))).toBe("x".repeat(80));
  });
});

describe("resolveProject", () => {
  test("an explicit project wins", () => {
    expect(resolveProject(Option.some("foreman"), ["foreman", "prog"])).toEqual(
      Option.some("foreman"),
    );
  });

  test("the sole configured project is used when none requested", () => {
    expect(resolveProject(Option.none(), ["foreman"])).toEqual(Option.some("foreman"));
  });

  test("is unknown when ambiguous or not configured", () => {
    expect(resolveProject(Option.none(), ["foreman", "prog"])).toEqual(Option.none());
    expect(resolveProject(Option.some("nope"), ["foreman"])).toEqual(Option.none());
  });
});
