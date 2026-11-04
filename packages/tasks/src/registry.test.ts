import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAt } from "./connection.ts";
import { importRegistry } from "./registry.ts";

const dir = mkdtempSync(join(tmpdir(), "tasks-registry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
const fresh = () => join(dir, `store-${++files}.db`);

const inStore = <A, E>(file: string, use: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(use.pipe(Effect.provide(connectionAt(file))));

/** A trials database in the herd skill's layout, holding one model, two trials and a defect. */
const herdFile = () => {
  const file = join(dir, `herd-${++files}.db`);
  const db = new Database(file);
  db.run(`CREATE TABLE providers (provider TEXT PRIMARY KEY, models_dev TEXT, note TEXT)`);
  db.run(
    `CREATE TABLE pools (pool TEXT PRIMARY KEY, harness TEXT NOT NULL, quota_cmd TEXT, provider_default TEXT NOT NULL, notes TEXT)`,
  );
  db.run(`CREATE TABLE pool_aliases (alias TEXT PRIMARY KEY, pool TEXT NOT NULL)`);
  db.run(`CREATE TABLE models (model TEXT PRIMARY KEY, provider TEXT NOT NULL, pool TEXT NOT NULL, harness TEXT NOT NULL,
    models_dev TEXT, tier TEXT NOT NULL, limit_scope TEXT NOT NULL, thinking TEXT NOT NULL DEFAULT 'medium',
    retired INTEGER NOT NULL DEFAULT 0, notes TEXT)`);
  db.run(`CREATE TABLE aliases (alias TEXT PRIMARY KEY, model TEXT NOT NULL)`);
  db.run(`CREATE TABLE ladder (rank INTEGER PRIMARY KEY, rung TEXT NOT NULL UNIQUE, model TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, provider TEXT, note TEXT, unmetered INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE prices (model TEXT PRIMARY KEY, source TEXT NOT NULL, input REAL, output REAL,
    cache_read REAL, cache_write REAL, fetched_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE trials (id INTEGER PRIMARY KEY, closed_at TEXT NOT NULL DEFAULT (datetime('now')),
    project TEXT NOT NULL, task TEXT NOT NULL, slice TEXT NOT NULL, kind TEXT NOT NULL, pool TEXT NOT NULL,
    model TEXT NOT NULL, work TEXT NOT NULL, outcome TEXT NOT NULL, rounds INTEGER, report_accurate INTEGER,
    source TEXT NOT NULL DEFAULT 'live', evidence TEXT, notes TEXT, session TEXT, active_minutes REAL,
    input_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, output_tokens INTEGER,
    reasoning_tokens INTEGER, actual_cost_usd REAL, size INTEGER)`);
  db.run(
    `CREATE TABLE defects (trial_id INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`,
  );
  db.run(`INSERT INTO pools VALUES ('Pool', 'pi', NULL, 'prov', NULL)`);
  db.run(
    `INSERT INTO models (model, provider, pool, harness, tier, limit_scope) VALUES ('m1', 'prov', 'Pool', 'pi', 'free', 'pool')`,
  );
  db.run(`INSERT INTO ladder (rank, rung, model) VALUES (1, 'cheap', 'm1')`);
  // Ids with a gap, as deleted trials leave them: a defect must still find its run.
  db.run(`INSERT INTO trials (id, project, task, slice, kind, pool, model, work, outcome)
    VALUES (3, 'p', 'ts-000001', 'one', 'pi', 'Pool', 'm1', 'build', 'committed'),
           (7, 'p', 'ts-000002', 'two', 'pi', 'Pool', 'm1', 'build', 'committed')`);
  db.run(`INSERT INTO defects VALUES (7, 'duplication', 'copied a helper')`);
  db.close();
  return file;
};

describe("importRegistry", () => {
  test("copies every table, keeping run ids so each defect still names its run", async () => {
    const store = fresh();
    const counts = await inStore(store, importRegistry(herdFile()));
    expect(counts).toMatchObject({ models: 1, ladder: 1, runs: 2, defects: 1 });

    const db = new Database(store, { readonly: true });
    expect(db.query("SELECT r.slice FROM defects d JOIN runs r ON r.id = d.run_id").all()).toEqual([
      { slice: "two" },
    ]);
    expect(db.query("SELECT model, slices, succeeded, status FROM model_status").all()).toEqual([
      { model: "m1", slices: 2, succeeded: 2, status: "proven" },
    ]);
    expect(db.query("SELECT rung, thinking FROM ladder").all()).toEqual([
      { rung: "cheap", thinking: "medium" },
    ]);
    db.close();
  });

  test("refuses a store that already holds registry rows", async () => {
    const store = fresh();
    const herd = herdFile();
    await inStore(store, importRegistry(herd));
    const refused = await inStore(store, importRegistry(herd).pipe(Effect.flip));
    expect(refused).toMatchObject({ _tag: "ImportError" });
  });
});

describe("runs", () => {
  test("an open run counts in no summary until it closes", async () => {
    const store = fresh();
    await inStore(store, importRegistry(herdFile()));
    await inStore(
      store,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO runs (project, task, slice, kind, pool, model, rung, work, started_at, closed_at)
          VALUES ('p', 'ts-000003', 'three', 'pi', 'Pool', 'm1', 'cheap', 'build', datetime('now'), NULL)`;
      }),
    );
    const db = new Database(store, { readonly: true });
    expect(db.query("SELECT slices FROM model_summary").all()).toEqual([{ slices: 2 }]);
    expect(db.query("SELECT slices FROM model_status").all()).toEqual([{ slices: 2 }]);
    db.close();
  });

  test("a run has an outcome exactly when it is closed", async () => {
    const store = fresh();
    const insert = (closedAt: string | null, outcome: string | null) =>
      inStore(
        store,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`INSERT INTO runs (project, task, slice, kind, pool, model, work, closed_at, outcome)
            VALUES ('p', 't', 's', 'pi', 'Pool', 'm1', 'build', ${closedAt}, ${outcome})`;
        }),
      );
    await expect(insert(null, "committed")).rejects.toThrow();
    await expect(insert("2026-11-01 00:00:00", null)).rejects.toThrow();
    await insert(null, null);
    await insert("2026-11-01 00:00:00", "dropped");
  });
});
