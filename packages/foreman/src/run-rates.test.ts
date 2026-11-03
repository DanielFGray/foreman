import { describe, expect, test } from "bun:test";
import { type AgentSample, drawMinutes, ratesOf } from "./run-rates.ts";

const run = (rung: string, ending: string, minutes?: number): AgentSample => ({
  rung,
  role: "author",
  ending,
  minutes,
});

describe("ratesOf", () => {
  const rates = ratesOf({
    agents: [
      run("a", "done", 10),
      run("a", "stopped", 2),
      run("b", "done", 30),
      run("b", "done", 40),
      // Released by a replacement: not the agent's outcome, so not counted.
      run("a", "released", 1),
    ],
    checks: [
      { node: "test", passed: true },
      { node: "test", passed: true },
      { node: "test", passed: true },
      { node: "test", passed: false },
    ],
  });

  test("blends a rung's own shares toward its role's pool, five runs weighing as much as the pool", () => {
    // The pool: done 3/4, stopped 1/4. Rung a has done 1/2, stopped 1/2 over n = 2.
    const a = rates.agent("a", "author");
    expect(a.n).toBe(2);
    expect(a.label).toBe("Measured");
    expect(a.endings.get("done")).toBeCloseTo((0.5 * 2 + 5 * 0.75) / 7);
    expect(a.endings.get("stopped")).toBeCloseTo((0.5 * 2 + 5 * 0.25) / 7);
    expect(a.endings.has("released")).toBe(false);
    expect(a.success).toBeCloseTo((0.5 * 2 + 5 * 0.75) / 7);
    expect(a.own).toEqual([10, 2]);
  });

  test("reads a rung with no run of its own from the pool, labelled Assumed", () => {
    const c = rates.agent("c", "author");
    expect(c.n).toBe(0);
    expect(c.label).toBe("Assumed");
    expect(c.endings.get("done")).toBeCloseTo(0.75);
    expect(c.own).toEqual([]);
    expect(c.pool).toEqual([10, 2, 30, 40]);
  });

  test("passes a check at its block's measured rate, else every time", () => {
    expect(rates.check("test")).toEqual({ node: "test", n: 4, label: "Measured", pass: 0.75 });
    expect(rates.check("lint")).toEqual({ node: "lint", n: 0, label: "Assumed", pass: 1 });
  });

  test("assumes success and an hour when the role has no run at all", () => {
    const review = rates.agent("a", "review");
    expect(review.success).toBe(1);
    expect(drawMinutes(review, () => 0.5)).toBe(60);
  });

  test("draws a run's minutes, at least one", () => {
    const quick = ratesOf({ agents: [run("a", "stopped", 0)], checks: [] }).agent("a", "author");
    expect(drawMinutes(quick, () => 0)).toBe(1);
  });
});
