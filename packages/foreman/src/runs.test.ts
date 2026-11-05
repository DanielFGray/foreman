import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import type { RunRecord } from "tasks";
import { tablesFor } from "./runs.ts";

const at = (time: string) => Option.some(new Date(`2026-01-01T${time}Z`));

function run(fields: Partial<RunRecord> & Pick<RunRecord, "id" | "work">): RunRecord {
  return {
    project: "foreman",
    task: "ts-a",
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
    notes: Option.none(),
    ...fields,
  };
}

const runs: ReadonlyArray<RunRecord> = [
  run({
    id: 1,
    work: "build",
    rung: Option.some("cheap"),
    startedAt: at("10:00:00"),
    closedAt: at("10:00:10"),
    outcome: Option.some("committed"),
  }),
  run({
    id: 2,
    work: "build",
    rung: Option.some("cheap"),
    closedAt: at("10:00:20"),
    outcome: Option.some("handed-off"),
  }),
  run({
    id: 3,
    work: "correction",
    rung: Option.some("standard"),
    startedAt: at("10:00:00"),
  }),
  run({
    id: 4,
    work: "review",
    rung: Option.some("reviewer-x"),
    ending: Option.some("returned"),
    startedAt: at("10:00:00"),
    closedAt: at("10:00:30"),
  }),
  run({
    id: 5,
    work: "review",
    rung: Option.some("reviewer-x"),
    startedAt: at("10:00:00"),
  }),
  run({
    id: 6,
    work: "review",
    rung: Option.some("reviewer-x"),
    ending: Option.some("approved"),
    startedAt: at("10:00:00"),
    closedAt: at("10:01:00"),
  }),
];

const tables = tablesFor(runs);

describe("run tables", () => {
  test("counts a run with no start in runs but not in durations", () => {
    const cheap = tables.rung.find((row) => row.key === "cheap");

    expect(cheap?.metrics).toMatchObject({ runs: 2, medianDuration: 10_000 });
  });

  test("leaves a review with no verdict out of the return rate", () => {
    const reviewer = tables.rung.find((row) => row.key === "reviewer-x");

    expect(reviewer?.metrics.reviewReturnRate).toBe(0.5);
  });

  test("leaves an open author run out of the land rate", () => {
    expect(tables.project[0]?.metrics.landRate).toBe(0.5);
  });

  test("reads durations over every run that has both times", () => {
    expect(tables.project[0]?.metrics).toMatchObject({
      runs: 6,
      medianDuration: 30_000,
      p90Duration: 60_000,
    });
  });

  test("shows a rate with nothing to divide as absent", () => {
    const standard = tables.rung.find((row) => row.key === "standard");

    expect(standard?.metrics).toMatchObject({ runs: 1, landRate: undefined });
  });

  test("groups by rung, project and task", () => {
    expect(tables.rung.map((row) => row.key).sort()).toEqual(["cheap", "reviewer-x", "standard"]);
    expect(tables.project.map((row) => row.key)).toEqual(["foreman"]);
    expect(tables.task).toEqual([expect.objectContaining({ key: "ts-a" })]);
  });
});
