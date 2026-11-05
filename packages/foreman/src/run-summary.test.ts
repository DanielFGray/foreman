import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import type { RunRecord } from "tasks";
import { summarizeRuns } from "./run-summary.ts";

const at = (iso: string) => Option.some(new Date(iso));

const run = (fields: Partial<RunRecord> & Pick<RunRecord, "id" | "work">): RunRecord => ({
  project: "p",
  task: "t",
  rung: Option.none(),
  model: Option.none(),
  node: Option.none(),
  commit: Option.none(),
  ending: Option.none(),
  outcome: Option.none(),
  rounds: Option.none(),
  startedAt: Option.none(),
  closedAt: Option.none(),
  costUsd: Option.none(),
  ...fields,
});

const NOW = new Date("2026-06-01T12:00:00Z");

describe("summarizeRuns", () => {
  test("a task with no runs has no elapsed time and no sums", () => {
    expect(summarizeRuns([], "open", NOW)).toEqual({
      elapsedMinutes: Option.none(),
      agentMinutes: Option.none(),
      authorRuns: 0,
      returned: 0,
      rounds: Option.none(),
    });
  });

  test("runs that predate start times give no elapsed time or agent minutes", () => {
    const summary = summarizeRuns(
      [run({ id: 1, work: "build", ending: Option.some("done"), rounds: Option.some(1) })],
      "done",
      NOW,
    );
    expect(summary.elapsedMinutes).toEqual(Option.none());
    expect(summary.agentMinutes).toEqual(Option.none());
    expect(summary.authorRuns).toBe(1);
    expect(summary.rounds).toEqual(Option.some(1));
  });

  test("a done task spans its first start to its last close", () => {
    const summary = summarizeRuns(
      [
        run({
          id: 1,
          work: "build",
          startedAt: at("2026-06-01T10:00:00Z"),
          closedAt: at("2026-06-01T10:30:00Z"),
        }),
        run({
          id: 2,
          work: "review",
          startedAt: at("2026-06-01T10:40:00Z"),
          closedAt: at("2026-06-01T11:00:00Z"),
        }),
      ],
      "done",
      NOW,
    );
    expect(summary.elapsedMinutes).toEqual(Option.some(60));
    expect(summary.agentMinutes).toEqual(Option.some(50));
  });

  test("a task in progress runs its elapsed time to now, and an open run is not in the agent sum", () => {
    const summary = summarizeRuns(
      [
        run({
          id: 1,
          work: "build",
          startedAt: at("2026-06-01T11:00:00Z"),
          closedAt: at("2026-06-01T11:15:00Z"),
        }),
        run({ id: 2, work: "review", startedAt: at("2026-06-01T11:30:00Z") }),
      ],
      "in_progress",
      NOW,
    );
    expect(summary.elapsedMinutes).toEqual(Option.some(60));
    expect(summary.agentMinutes).toEqual(Option.some(15));
  });

  test("check runs count toward neither author runs nor agent minutes", () => {
    const summary = summarizeRuns(
      [
        run({
          id: 1,
          work: "check",
          startedAt: at("2026-06-01T11:00:00Z"),
          closedAt: at("2026-06-01T11:10:00Z"),
        }),
      ],
      "in_progress",
      NOW,
    );
    expect(summary.authorRuns).toBe(0);
    expect(summary.agentMinutes).toEqual(Option.none());
  });

  test("returned counts review runs that ended returned, and rounds sums author rounds", () => {
    const summary = summarizeRuns(
      [
        run({ id: 1, work: "build", rounds: Option.some(2) }),
        run({ id: 2, work: "correction", rounds: Option.some(1) }),
        run({ id: 3, work: "review", ending: Option.some("returned") }),
        run({ id: 4, work: "review", ending: Option.some("approved") }),
      ],
      "in_progress",
      NOW,
    );
    expect(summary.authorRuns).toBe(2);
    expect(summary.returned).toBe(1);
    expect(summary.rounds).toEqual(Option.some(3));
  });
});
