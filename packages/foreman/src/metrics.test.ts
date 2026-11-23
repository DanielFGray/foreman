import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { connectionAt } from "tasks";
import { metricsRuns } from "./metrics-command.ts";
import {
  endingsByRung,
  launchedBy,
  runningTotal,
  runTimes,
  shareByModel,
  type MetricsRun,
} from "./metrics.ts";
import { Records } from "./records.ts";

const at = (day: number) => Date.UTC(2026, 10, day);

const metricsRun = (over: Partial<MetricsRun> = {}): MetricsRun => ({
  id: 1,
  project: "p",
  task: "ts-1",
  model: "m1",
  rung: "cheap",
  work: "build",
  closedAt: at(1),
  wallMinutes: null,
  activeMinutes: null,
  tokens: null,
  costUsd: null,
  outcome: "committed",
  ending: "done",
  ...over,
});

describe("the metrics folds", () => {
  test("a running total climbs in close order over only the runs that report the measure", () => {
    const total = runningTotal(
      [
        metricsRun({ closedAt: at(3), costUsd: 2 }),
        metricsRun({ closedAt: at(1), costUsd: 1 }),
        metricsRun({ closedAt: at(2) }),
      ],
      "costUsd",
    );
    expect(total).toEqual({
      points: [
        { at: at(1), total: 1 },
        { at: at(3), total: 3 },
      ],
      covered: 2,
      of: 3,
    });
  });

  test("a model's share counts a run with no model as unknown, largest first", () => {
    const share = shareByModel(
      [metricsRun({ model: "b" }), metricsRun({ model: null }), metricsRun({ model: "b" })],
      "runs",
    );
    expect(share.rows).toEqual([
      { key: "b", value: 2 },
      { key: "unknown", value: 1 },
    ]);
  });

  test("a run time on a bin's edge falls in the bin above, and one past the last edge in the open bin", () => {
    const times = runTimes(
      [1, 2, 300, null].map((wallMinutes) => metricsRun({ wallMinutes })),
      "wallMinutes",
    );
    const counted = times.bins.filter((bin) => bin.count > 0);
    expect(counted).toEqual([
      { from: 1, to: 2, count: 1 },
      { from: 2, to: 5, count: 1 },
      { from: 240, to: null, count: 1 },
    ]);
    expect({ p50: times.p50, p90: times.p90, covered: times.covered }).toEqual({
      p50: 2,
      p90: 300,
      covered: 3,
    });
  });

  test("a rung fails on a run that ended with no exit, no pane or no allowance, and not on an operator's release", () => {
    const endings = endingsByRung(
      ["done", "stopped", "vanished", "walled", "released"].map((ending) => metricsRun({ ending })),
    );
    expect(endings.rows).toEqual([{ key: "cheap", ended: 5, failed: 3 }]);
  });

  test("a hand run and an unsettled run say nothing of a rung's endings", () => {
    const endings = endingsByRung([
      metricsRun({ rung: null }),
      metricsRun({ ending: null }),
      metricsRun(),
    ]);
    expect(endings).toEqual({ rows: [{ key: "cheap", ended: 1, failed: 0 }], covered: 1, of: 3 });
  });

  test("foreman launched a run with a rung; a hand run has none", () => {
    const runs = [metricsRun({ id: 1 }), metricsRun({ id: 2, rung: null })];
    expect(launchedBy(runs, "foreman").map((run) => run.id)).toEqual([1]);
    expect(launchedBy(runs, "hand").map((run) => run.id)).toEqual([2]);
    expect(launchedBy(runs, "all")).toBe(runs);
  });
});

describe("metricsRuns", () => {
  const directory = mkdtempSync(join(tmpdir(), "foreman-metrics-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const store = Layer.mergeAll(connectionAt(join(directory, "tasks.db")), BunServices.layer);

  test("reads the window's closed agent runs, without its checks, timed start to close", async () => {
    const runs = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO runs (project, task, slice, kind, pool, model, work, started_at, closed_at, outcome)
          VALUES ('p', 'ts-1', 's', 'pi', 'Pool', 'm1', 'build',
            datetime('now', '-1 day', '-30 minutes'), datetime('now', '-1 day'), 'committed'),
          ('p', 'ts-2', 's', 'pi', 'Pool', 'm1', 'build', NULL, datetime('now', '-40 days'), 'committed')`;
        yield* sql`INSERT INTO runs (project, task, slice, work, closed_at, ending)
          VALUES ('p', 'ts-1', 's', 'check', datetime('now', '-1 day'), 'passed')`;
        return yield* metricsRuns(30);
      }).pipe(Effect.provide(Layer.merge(Records.layer.pipe(Layer.provide(store)), store))),
    );
    expect(runs.map(({ task, work, wallMinutes }) => ({ task, work, wallMinutes }))).toEqual([
      { task: "ts-1", work: "build", wallMinutes: 30 },
    ]);
  });
});
