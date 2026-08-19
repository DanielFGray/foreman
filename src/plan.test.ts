import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import type { WorkerState } from "./fleet.ts";
import { decide, resolveProject, stageFor, titleFor } from "./plan.ts";

describe("stageFor", () => {
  test("routes by the epic's derived status", () => {
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

  test("waits while the agent is working", () => {
    expect(decide("planning", working, "draft", false)).toBe("wait");
    expect(decide("tasking", working, "open", true)).toBe("wait");
  });

  test("a blocked agent without its deliverable is an interview, so it waits", () => {
    expect(decide("planning", "blocked", "draft", false)).toBe("wait");
    expect(decide("tasking", "blocked", "open", true)).toBe("wait");
  });

  test("a blocked agent whose deliverable exists is done, not stuck", () => {
    // herdr can keep reporting an agent as blocked after it finished (opencode
    // idles at its prompt), so the deliverable is what tells an interview from
    // a finished run.
    expect(decide("planning", "blocked", "draft", true)).toBe("advance");
    expect(decide("tasking", "blocked", "done", true)).toBe("advance");
  });

  test("planning advances when the planner settles with a written spec", () => {
    // The epic's status does not move while the planner works — it is a draft
    // until the tasker's children exist — so the spec in the description is
    // the planner's deliverable, and a settled planner with one advances.
    expect(decide("planning", settled, "draft", true)).toBe("advance");
    expect(decide("planning", settled, "open", true)).toBe("advance");
    expect(decide("planning", settled, "done", true)).toBe("advance");
    expect(decide("planning", settled, "canceled", true)).toBe("advance");
  });

  test("tasking advances only when the epic is complete", () => {
    expect(decide("tasking", settled, "done", true)).toBe("advance");
    expect(decide("tasking", settled, "canceled", true)).toBe("advance");
  });

  test("fails when the agent settles without its deliverable", () => {
    expect(decide("planning", settled, "draft", false)).toBe("failed");
    expect(decide("planning", gone, "draft", false)).toBe("failed");
    expect(decide("tasking", settled, "open", true)).toBe("failed");
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
