import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAt } from "./connection.ts";
import { Tasks } from "./store.ts";
import { outcomeOf, Runs, type NewRunInput } from "./runs.ts";

const dir = mkdtempSync(join(tmpdir(), "tasks-runs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
const inRuns = <A, E>(use: Effect.Effect<A, E, Runs | Tasks | SqlClient>) =>
  Effect.runPromise(use.pipe(Effect.provide(Runs.layerAt(join(dir, `store-${++files}.db`)))));

/**
 * Forgets that the named migration and every later one ran, so the next
 * connection runs them again. The migrator runs only ids above the latest
 * recorded row, so a later row left behind would skip the named one.
 */
const rewindTo = (name: string) =>
  `DELETE FROM tasks_migrations
   WHERE migration_id >= (SELECT migration_id FROM tasks_migrations WHERE name = '${name}')`;

const run = (over: Partial<NewRunInput> = {}): NewRunInput => ({
  project: "p",
  task: "ts-1",
  slice: "a slice",
  kind: "pi",
  pool: "Pool",
  model: "m1",
  rung: "cheap",
  node: "author",
  work: "build",
  ...over,
});

describe("runs", () => {
  test("an author on the operator's branch keeps the commit it started from after it closes", async () => {
    const runs = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const id = yield* runs.openRun(run({ base: "start" }));
        yield* runs.closeRun(id, { ending: "done", commit: "end" });
        return (yield* runs.runsOf(["ts-1"])).get("ts-1");
      }),
    );
    expect(runs?.[0]).toMatchObject({ base: Option.some("start"), commit: Option.some("end") });
  });

  test("a run is open until closed, and closes with its outcome and commit", async () => {
    const [open, closed] = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const id = yield* runs.openRun(run());
        const open = (yield* runs.runsOf(["ts-1"])).get("ts-1");
        yield* runs.closeRun(id, { ending: "done", commit: "abc" });
        return [open, (yield* runs.runsOf(["ts-1"])).get("ts-1")] as const;
      }),
    );
    expect(open?.map((r) => [r.open, Option.getOrUndefined(r.ending), r.role])).toEqual([
      [true, undefined, "author"],
    ]);
    expect(
      closed?.map((r) => [
        r.open,
        Option.getOrUndefined(r.ending),
        Option.getOrUndefined(r.commit),
      ]),
    ).toEqual([[false, "done", "abc"]]);
  });

  test("a review run keeps the tip it opened with when it closes", async () => {
    const runs = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const id = yield* runs.openRun(run({ work: "review", node: "review", commit: "tip1" }));
        yield* runs.closeRun(id, { ending: "approved" });
        return (yield* runs.runsOf(["ts-1"])).get("ts-1");
      }),
    );
    expect(runs?.[0]).toMatchObject({
      role: "review",
      ending: Option.some("approved"),
      commit: Option.some("tip1"),
    });
  });

  test("an exit keeps the commit it was named on when settle closes the run", async () => {
    const runs = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const tasks = yield* Tasks;
        const id = yield* tasks.add({ project: "p", title: "t" });
        const review = yield* runs.openRun(
          run({ task: id, work: "review", node: "review", commit: "tip1" }),
        );
        yield* runs.nameExit(id, { ending: "approved", commit: "tip2", event: undefined });
        yield* runs.closeRun(review, { ending: "stopped", commit: "tip3" });
        return (yield* runs.runsOf([id])).get(id);
      }),
    );
    expect(
      runs?.map((r) => [Option.getOrUndefined(r.ending), Option.getOrUndefined(r.commit)]),
    ).toEqual([["approved", "tip2"]]);
  });

  test("runs read oldest first, per task", async () => {
    const byTask = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        yield* runs.openRun(run({ rung: "a" }));
        yield* runs.openRun(run({ task: "ts-2", rung: "x" }));
        yield* runs.openRun(run({ rung: "b" }));
        return yield* runs.runsOf(["ts-1", "ts-2", "ts-3"]);
      }),
    );
    expect(byTask.get("ts-1")?.map((r) => Option.getOrUndefined(r.rung))).toEqual(["a", "b"]);
    expect(byTask.get("ts-2")?.map((r) => Option.getOrUndefined(r.rung))).toEqual(["x"]);
    expect(byTask.has("ts-3")).toBe(false);
  });

  test("an open run that never started can be deleted, a closed one cannot", async () => {
    const result = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const never = yield* runs.openRun(run());
        yield* runs.deleteOpenRun(never);
        const done = yield* runs.openRun(run());
        yield* runs.closeRun(done, { ending: "stopped" });
        const refused = yield* runs.deleteOpenRun(done).pipe(Effect.flip);
        return { left: (yield* runs.runsOf(["ts-1"])).get("ts-1")?.length, refused: refused._tag };
      }),
    );
    expect(result).toEqual({ left: 1, refused: "RunError" });
  });

  test("rounds count on the latest author run, open or closed, and never on a review", async () => {
    const counts = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const author = yield* runs.openRun(run());
        yield* runs.openRun(run({ work: "review" }));
        const first = yield* runs.addRound("ts-1");
        yield* runs.closeRun(author, { ending: "done" });
        const second = yield* runs.addRound("ts-1");
        const none = yield* runs.addRound("ts-none").pipe(Effect.flip);
        return [first, second, none._tag];
      }),
    );
    expect(counts).toEqual([1, 2, "TaskError"]);
  });

  test("an agent ending that is no exit name is refused before it is written, and by the table", async () => {
    const [closed, refused] = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const sql = yield* SqlClient;
        const review = yield* runs.openRun(run({ work: "review" }));
        const closed = yield* runs.closeRun(review, { ending: "Handed Off" }).pipe(Effect.exit);
        const refused = yield* sql`UPDATE runs SET ending = 'Handed Off' WHERE id = ${review}`.pipe(
          Effect.flip,
        );
        return [closed, refused._tag] as const;
      }),
    );
    expect(Exit.hasDies(closed)).toBe(true);
    expect(refused).toBe("SqlError");
  });

  test("only an exit stands on an open run", async () => {
    const sql = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const sql = yield* SqlClient;
        const id = yield* runs.openRun(run());
        const settle = yield* sql`UPDATE runs SET ending = 'stopped' WHERE id = ${id}`.pipe(
          Effect.flip,
        );
        yield* sql`UPDATE runs SET ending = 'already-done' WHERE id = ${id}`;
        return settle._tag;
      }),
    );
    expect(sql).toBe("SqlError");
  });

  test("settle keeps the ending the agent wrote", async () => {
    const closed = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const sql = yield* SqlClient;
        const id = yield* runs.openRun(run({ work: "review", node: "review", commit: "t" }));
        yield* sql`UPDATE runs SET ending = 'approved' WHERE id = ${id}`;
        yield* runs.closeRun(id, { ending: "stopped" });
        return (yield* runs.runsOf(["ts-1"])).get("ts-1");
      }),
    );
    expect(closed?.map((r) => [r.open, Option.getOrUndefined(r.ending)])).toEqual([
      [false, "approved"],
    ]);
  });

  test("the outcome follows the ending, and landing sets the author's outcome", async () => {
    expect(outcomeOf("canceled")).toBe("dropped");
    expect(outcomeOf("approved")).toBe("handed-off");
    const outcomes = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const sql = yield* SqlClient;
        const author = yield* runs.openRun(run());
        yield* runs.closeRun(author, { ending: "done", commit: "x" });
        yield* runs.landAuthorRun("ts-1", false);
        return yield* sql<{ outcome: string }>`SELECT outcome FROM runs`;
      }),
    );
    expect(outcomes.map((r) => r.outcome)).toEqual(["committed"]);
  });
});

describe("check runs", () => {
  const check = { project: "p", task: "ts-1", node: "lint", command: "bun run lint" } as const;

  test("are written closed with their ending and the commit they ran on", async () => {
    const runs = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        yield* runs.recordCheck({ ...check, commit: "c1", ending: "failed" });
        yield* runs.recordCheck({ ...check, commit: "c2", ending: "passed" });
        return (yield* runs.runsOf(["ts-1"])).get("ts-1");
      }),
    );
    expect(
      runs?.map((r) => [
        r.role,
        Option.getOrUndefined(r.node),
        Option.getOrUndefined(r.commit),
        Option.getOrUndefined(r.ending),
        r.open,
      ]),
    ).toEqual([
      ["check", "lint", "c1", "failed", false],
      ["check", "lint", "c2", "passed", false],
    ]);
  });

  test("are never an author's run: rounds and landing pass over them", async () => {
    const [rounds, rows] = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const sql = yield* SqlClient;
        const author = yield* runs.openRun(run());
        yield* runs.closeRun(author, { ending: "done", commit: "c1" });
        yield* runs.recordCheck({ ...check, commit: "c1", ending: "passed" });
        const rounds = yield* runs.addRound("ts-1");
        yield* runs.landAuthorRun("ts-1", false);
        const rows = yield* sql<{ work: string; outcome: string | null; rounds: number | null }>`
          SELECT work, outcome, rounds FROM runs ORDER BY id`;
        return [rounds, rows] as const;
      }),
    );
    expect(rounds).toBe(1);
    expect(rows).toEqual([
      { work: "build", outcome: "committed", rounds: 1 },
      { work: "check", outcome: null, rounds: null },
    ]);
  });

  test("the store refuses a check with a model or an agent's ending", async () => {
    const refused = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const sql = yield* SqlClient;
        const withModel =
          yield* sql`INSERT INTO runs (project, task, slice, model, node, work, ending)
          VALUES ('p', 'ts-1', 'x', 'm1', 'lint', 'check', 'passed')`.pipe(Effect.flip);
        const agentEnding = yield* sql`INSERT INTO runs (project, task, slice, node, work, ending)
          VALUES ('p', 'ts-1', 'x', 'lint', 'check', 'approved')`.pipe(Effect.flip);
        return [withModel._tag, agentEnding._tag];
      }),
    );
    expect(refused).toEqual(["SqlError", "SqlError"]);
  });

  test("count in no view about models", async () => {
    const rows = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const sql = yield* SqlClient;
        const author = yield* runs.openRun(run());
        yield* runs.closeRun(author, { ending: "done", commit: "c1" });
        yield* runs.recordCheck({ ...check, commit: "c1", ending: "passed" });
        const summary = yield* sql<{ model: string | null; slices: number }>`
          SELECT model, slices FROM model_summary`;
        // model_status and herd_roster read their runs through run_identity.
        const identities = yield* sql<{ cmodel: string | null }>`SELECT cmodel FROM run_identity`;
        return { summary, identities };
      }),
    );
    expect(rows).toEqual({ summary: [{ model: "m1", slices: 1 }], identities: [{ cmodel: "m1" }] });
  });
});

describe("naming an exit", () => {
  const filed = Effect.gen(function* () {
    const tasks = yield* Tasks;
    const id = yield* tasks.add({ project: "p", title: "t" });
    return id;
  });

  // Foreman gives a new exit a random id of letters, and the run stores it.
  test("stores an exit id that is no name an agent was ever given", async () => {
    const runs = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const tasks = yield* Tasks;
        const id = yield* filed;
        yield* tasks.send(id, "start");
        yield* runs.openRun(run({ task: id, work: "build", node: "author" }));
        yield* runs.nameExit(id, { ending: "exit-qzvmktrwpa", commit: "c1", event: undefined });
        return (yield* runs.runsOf([id])).get(id)?.map((r) => Option.getOrUndefined(r.ending));
      }),
    );
    expect(runs).toEqual(["exit-qzvmktrwpa"]);
  });

  test("a second exit replaces the first, commit and all, and makes its status move", async () => {
    const [status, runs] = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const tasks = yield* Tasks;
        const id = yield* filed;
        yield* tasks.send(id, "start");
        yield* runs.openRun(run({ task: id, work: "review", node: "review" }));
        yield* runs.nameExit(id, { ending: "approved", commit: "c1", event: undefined });
        yield* runs.nameExit(id, { ending: "returned", commit: "c2", event: "open" });
        const task = yield* tasks.require(id);
        return [
          task.status,
          (yield* runs.runsOf([id]))
            .get(id)
            ?.map((r) => [Option.getOrUndefined(r.ending), Option.getOrUndefined(r.commit)]),
        ];
      }),
    );
    expect(status).toBe("open");
    expect(runs).toEqual([["returned", "c2"]]);
  });

  test("an exit's notes are stored, and a second exit without notes clears them", async () => {
    const [withNotes, cleared] = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const tasks = yield* Tasks;
        const id = yield* filed;
        yield* tasks.send(id, "start");
        yield* runs.openRun(run({ task: id, work: "review", node: "review" }));
        yield* runs.recordExit(id, { ending: "returned", notes: "the new path has no test" });
        const first = (yield* runs.recordsOf([id])).map((r) => Option.getOrUndefined(r.notes));
        yield* runs.recordExit(id, { ending: "approved" });
        const second = (yield* runs.recordsOf([id])).map((r) => Option.getOrUndefined(r.notes));
        return [first, second];
      }),
    );
    expect(withNotes).toEqual(["the new path has no test"]);
    expect(cleared).toEqual([undefined]);
  });

  test("is refused with no open run, or with a process ending's name, and moves nothing", async () => {
    const [none, process, status] = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const tasks = yield* Tasks;
        const id = yield* filed;
        yield* tasks.send(id, "start");
        const none = yield* runs
          .nameExit(id, {
            ending: "returned",
            commit: undefined,
            event: "open",
          })
          .pipe(Effect.flip);
        yield* runs.openRun(run({ task: id }));
        const process = yield* runs
          .nameExit(id, {
            ending: "stopped",
            commit: undefined,
            event: undefined,
          })
          .pipe(Effect.flip);
        return [none._tag, process._tag, (yield* tasks.require(id)).status] as const;
      }),
    );
    expect([none, process, status]).toEqual(["TaskError", "TaskError", "in_progress"]);
  });
});

describe("the exits migration", () => {
  /** The runs table as migration 0003 left it, endings named per kind of work. */
  const OLD_RUNS = `CREATE TABLE runs (
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, task TEXT NOT NULL, slice TEXT NOT NULL,
    kind TEXT, pool TEXT, model TEXT, rung TEXT, node TEXT,
    work TEXT NOT NULL CHECK (work IN ('build', 'correction', 'research', 'review', 'check')),
    started_at TEXT, closed_at TEXT DEFAULT (datetime('now')),
    outcome TEXT CHECK (outcome IN ('committed', 'dropped', 'handed-off', 'answered')),
    "commit" TEXT, ending TEXT, rounds INTEGER,
    report_accurate INTEGER CHECK (report_accurate IN (0, 1)),
    source TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'backfill')),
    evidence TEXT, notes TEXT, session TEXT, active_minutes REAL, input_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, output_tokens INTEGER,
    reasoning_tokens INTEGER, actual_cost_usd REAL, size INTEGER CHECK (size >= 1), base TEXT,
    CHECK (ending IS NULL
      OR (work = 'review' AND ending IN ('approved', 'returned', 'no-verdict', 'walled', 'released'))
      OR (work = 'check' AND ending IN ('passed', 'failed'))
      OR (work IN ('build', 'correction', 'research')
          AND ending IN ('handed-off', 'satisfied', 'unfinished', 'walled', 'vanished', 'released', 'canceled')))
  )`;

  test("renames the author and review endings, and keeps every other column", async () => {
    const file = join(dir, `store-${++files}.db`);
    const at = <A, E>(use: Effect.Effect<A, E, SqlClient>) =>
      Effect.runPromise(use.pipe(Effect.provide(connectionAt(file))));
    await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`DROP VIEW run_cost`);
        yield* sql.unsafe(`DROP VIEW model_summary`);
        yield* sql.unsafe(`DROP VIEW size_summary`);
        yield* sql.unsafe(`DROP VIEW model_status`);
        yield* sql.unsafe(`DROP VIEW run_identity`);
        yield* sql.unsafe(`DROP VIEW herd_roster`);
        yield* sql.unsafe(`DROP TABLE charges`);
        yield* sql.unsafe(`DROP TABLE parks`);
        yield* sql.unsafe(`DROP TABLE runs`);
        yield* sql.unsafe(OLD_RUNS);
        // The models as these migrations found them, with the thinking level
        // the reviewers migration copies.
        yield* sql.unsafe(`ALTER TABLE models ADD COLUMN thinking TEXT NOT NULL DEFAULT 'medium'`);
        yield* sql.unsafe(rewindTo("exits"));
        const endings = [
          ["build", "handed-off"],
          ["build", "satisfied"],
          ["build", "unfinished"],
          ["review", "no-verdict"],
          ["review", "approved"],
          ["review", "returned"],
          ["build", "walled"],
        ];
        for (const [work, ending] of endings) {
          yield* sql.unsafe(`INSERT INTO runs (project, task, slice, kind, pool, model, work,
            "commit", ending, outcome, closed_at, base)
            VALUES ('p', 'ts-1', 's', 'pi', 'Pool', 'm1', '${work}', 'c', '${ending}', 'handed-off',
                    datetime('now'), 'b')`);
        }
      }),
    );
    const rows = await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ ending: string; commit: string; base: string }>`
          SELECT ending, "commit", base FROM runs ORDER BY id`;
      }),
    );
    expect(rows.map((row) => row.ending)).toEqual([
      "done",
      "already-done",
      "stopped",
      "stopped",
      "approved",
      "returned",
      "walled",
    ]);
    expect(new Set(rows.map((row) => `${row.commit} ${row.base}`))).toEqual(new Set(["c b"]));
  });
});

describe("the reviewers migration", () => {
  test("makes each council member a reviewer, and drops the council and review switches", async () => {
    const file = join(dir, `store-${++files}.db`);
    const at = <A, E>(use: Effect.Effect<A, E, SqlClient>) =>
      Effect.runPromise(use.pipe(Effect.provide(connectionAt(file))));
    await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          `INSERT INTO pools (pool, harness, provider_default) VALUES ('P', 'pi', 'p')`,
        );
        // The store as migration 0009 left it: a thinking level and a council
        // switch on the model, and a review switch on the rung.
        yield* sql.unsafe(`ALTER TABLE models ADD COLUMN thinking TEXT NOT NULL DEFAULT 'medium'`);
        yield* sql.unsafe(`INSERT INTO models (model, provider, pool, harness, limit_scope, thinking)
          VALUES ('m1', 'p', 'P', 'pi', 'pool', 'low'),
                 ('m2', 'p', 'P', 'pi', 'pool', 'medium'),
                 ('m3', 'p', 'P', 'pi', 'pool', 'medium')`);
        yield* sql.unsafe(`ALTER TABLE models ADD COLUMN council INTEGER NOT NULL DEFAULT 0`);
        yield* sql.unsafe(`UPDATE models SET council = 1 WHERE model IN ('m1', 'm2')`);
        yield* sql.unsafe(`ALTER TABLE ladder ADD COLUMN review INTEGER NOT NULL DEFAULT 1`);
        yield* sql.unsafe(`INSERT INTO ladder (rank, level, rung, model, provider, review) VALUES
          (1, 1, 'cheap', 'm3', NULL, 1), (2, 2, 'dear', 'm1', 'acct', 0), (3, 3, 'dearer', 'm1', NULL, 1)`);
        yield* sql.unsafe(`DROP TABLE reviewers`);
        yield* sql.unsafe(rewindTo("reviewers"));
      }),
    );
    const after = await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const reviewers = yield* sql<{
          reviewer: string;
          model: string;
          thinking: string;
          provider: string | null;
        }>`SELECT reviewer, model, thinking, provider FROM reviewers ORDER BY reviewer`;
        const columns = yield* sql<{ name: string }>`
          SELECT name FROM pragma_table_info('models')
          UNION ALL SELECT name FROM pragma_table_info('ladder')`;
        const rungs = yield* sql<{ rung: string }>`SELECT rung FROM ladder ORDER BY rank`;
        return { reviewers, columns: columns.map((column) => column.name), rungs };
      }),
    );
    expect(after.reviewers).toEqual([
      { reviewer: "dear", model: "m1", thinking: "low", provider: "acct" },
      { reviewer: "m2", model: "m2", thinking: "medium", provider: null },
    ]);
    expect(after.columns).not.toContain("council");
    expect(after.columns).not.toContain("review");
    expect(after.rungs.map((row) => row.rung)).toEqual(["cheap", "dear", "dearer"]);
  });
});

describe("the price class migration", () => {
  test("drops the models' price class and keeps every row that names a model", async () => {
    const file = join(dir, `store-${++files}.db`);
    const at = <A, E>(use: Effect.Effect<A, E, SqlClient>) =>
      Effect.runPromise(use.pipe(Effect.provide(connectionAt(file))));
    await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        // The models table as migration 0010 left it, with its price class.
        yield* sql.unsafe(`ALTER TABLE models ADD COLUMN tier TEXT NOT NULL DEFAULT 'metered'
          CHECK (tier IN ('free','metered','frontier'))`);
        yield* sql.unsafe(
          `INSERT INTO pools (pool, harness, provider_default) VALUES ('P', 'pi', 'p')`,
        );
        yield* sql.unsafe(`INSERT INTO models (model, provider, pool, harness, tier, limit_scope)
          VALUES ('m1', 'p', 'P', 'pi', 'free', 'pool'), ('m2', 'p', 'P', 'pi', 'frontier', 'pool')`);
        yield* sql.unsafe(
          `INSERT INTO ladder (rank, level, rung, model) VALUES (1, 1, 'cheap', 'm1')`,
        );
        yield* sql.unsafe(
          `INSERT INTO reviewers (reviewer, model, thinking) VALUES ('dear', 'm2', 'high')`,
        );
        yield* sql.unsafe(rewindTo("no_price_class"));
      }),
    );
    const after = await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('models')`;
        const models = yield* sql<{ model: string; rung: string | null }>`
          SELECT model, rung FROM model_status ORDER BY model`;
        const reviewers = yield* sql<{ reviewer: string }>`SELECT reviewer FROM reviewers`;
        return { columns: columns.map((column) => column.name), models, reviewers };
      }),
    );
    expect(after.columns).not.toContain("tier");
    expect(after.models).toEqual([
      { model: "m1", rung: "cheap" },
      { model: "m2", rung: null },
    ]);
    expect(after.reviewers).toEqual([{ reviewer: "dear" }]);
  });
});

describe("the rung thinking migration", () => {
  test("gives each rung its model's level, absent for auto, and drops the model's", async () => {
    const file = join(dir, `store-${++files}.db`);
    const at = <A, E>(use: Effect.Effect<A, E, SqlClient>) =>
      Effect.runPromise(use.pipe(Effect.provide(connectionAt(file))));
    await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        // The store as migration 0011 left it: the level on the model, and a
        // reviewer's level required.
        yield* sql.unsafe(`ALTER TABLE models ADD COLUMN thinking TEXT NOT NULL DEFAULT 'medium'`);
        yield* sql.unsafe(`DROP TABLE reviewers`);
        yield* sql.unsafe(`CREATE TABLE reviewers (reviewer TEXT PRIMARY KEY,
          model TEXT NOT NULL REFERENCES models(model), thinking TEXT NOT NULL, provider TEXT)`);
        yield* sql.unsafe(`DROP TABLE ladder`);
        yield* sql.unsafe(`CREATE TABLE ladder (rank INTEGER PRIMARY KEY, level INTEGER NOT NULL,
          rung TEXT NOT NULL UNIQUE, model TEXT NOT NULL REFERENCES models(model),
          enabled INTEGER NOT NULL DEFAULT 1, provider TEXT, note TEXT,
          unmetered INTEGER NOT NULL DEFAULT 0, author INTEGER NOT NULL DEFAULT 1)`);
        yield* sql.unsafe(
          `INSERT INTO pools (pool, harness, provider_default) VALUES ('P', 'pi', 'p')`,
        );
        yield* sql.unsafe(`INSERT INTO models (model, provider, pool, harness, limit_scope, thinking)
          VALUES ('m1', 'p', 'P', 'pi', 'pool', 'low'), ('auto', 'p', 'P', 'cursor', 'pool', 'auto')`);
        yield* sql.unsafe(`INSERT INTO ladder (rank, level, rung, model) VALUES
          (1, 1, 'picks', 'auto'), (2, 2, 'cheap', 'm1'), (3, 2, 'peer', 'm1')`);
        yield* sql.unsafe(
          `INSERT INTO reviewers (reviewer, model, thinking) VALUES ('deep', 'm1', 'high')`,
        );
        yield* sql.unsafe(rewindTo("rung_thinking"));
      }),
    );
    const after = await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rungs = yield* sql<{ rung: string; thinking: string | null }>`
          SELECT rung, thinking FROM ladder ORDER BY rank`;
        const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('models')`;
        yield* sql`INSERT INTO reviewers (reviewer, model) VALUES ('plain', 'm1')`;
        const reviewers = yield* sql<{ reviewer: string; thinking: string | null }>`
          SELECT reviewer, thinking FROM reviewers ORDER BY reviewer`;
        const statuses = yield* sql<{
          model: string;
        }>`SELECT model FROM model_status ORDER BY model`;
        return { rungs, columns: columns.map((column) => column.name), reviewers, statuses };
      }),
    );
    expect(after.rungs).toEqual([
      { rung: "picks", thinking: null },
      { rung: "cheap", thinking: "low" },
      { rung: "peer", thinking: "low" },
    ]);
    expect(after.columns).not.toContain("thinking");
    expect(after.reviewers).toEqual([
      { reviewer: "deep", thinking: "high" },
      { reviewer: "plain", thinking: null },
    ]);
    expect(after.statuses).toEqual([{ model: "auto" }, { model: "m1" }]);
  });
});

describe("lastStarts", () => {
  test("reads the newest start of each name's runs of one role", async () => {
    const starts = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        const sql = yield* SqlClient;
        yield* sql.unsafe(`INSERT INTO runs (project, task, slice, kind, pool, model, work, rung, started_at, closed_at)
          VALUES
          ('p', 'ts-1', 's', 'k', 'P', 'm', 'build', 'a', '2026-01-01 10:00:00', NULL),
          ('p', 'ts-1', 's', 'k', 'P', 'm', 'build', 'a', '2026-01-02 10:00:00', NULL),
          ('p', 'ts-1', 's', 'k', 'P', 'm', 'review', 'b', '2026-01-03 09:00:00', NULL),
          ('p', 'ts-1', 's', 'k', 'P', 'm', 'review', 'a', '2026-01-05 09:00:00', NULL),
          ('p', 'ts-1', 's', 'k', 'P', 'm', 'build', NULL, '2026-01-04 09:00:00', NULL),
          ('p', 'ts-1', 's', 'k', 'P', 'm', 'build', 'c', NULL, NULL)`);
        return {
          author: yield* runs.lastStarts("author"),
          review: yield* runs.lastStarts("review"),
        };
      }),
    );
    expect(starts.author).toEqual(new Map([["a", new Date("2026-01-02T10:00:00Z")]]));
    expect(starts.review).toEqual(
      new Map([
        ["b", new Date("2026-01-03T09:00:00Z")],
        ["a", new Date("2026-01-05T09:00:00Z")],
      ]),
    );
  });
});

describe("the ladder levels migration", () => {
  test("puts each rung alone in a level of its own rank", async () => {
    const file = join(dir, `store-${++files}.db`);
    const at = <A, E>(use: Effect.Effect<A, E, SqlClient>) =>
      Effect.runPromise(use.pipe(Effect.provide(connectionAt(file))));
    await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          `INSERT INTO pools (pool, harness, provider_default) VALUES ('P', 'pi', 'p')`,
        );
        yield* sql.unsafe(`INSERT INTO models (model, provider, pool, harness, limit_scope)
          VALUES ('m1', 'p', 'P', 'pi', 'pool')`);
        // The ladder as migration 0008 left it, with no level.
        yield* sql.unsafe(`DROP TABLE ladder`);
        yield* sql.unsafe(`CREATE TABLE ladder (
          rank INTEGER PRIMARY KEY, rung TEXT NOT NULL UNIQUE,
          model TEXT NOT NULL REFERENCES models(model), enabled INTEGER NOT NULL DEFAULT 1,
          provider TEXT, note TEXT, unmetered INTEGER NOT NULL DEFAULT 0,
          author INTEGER NOT NULL DEFAULT 1, review INTEGER NOT NULL DEFAULT 1)`);
        yield* sql.unsafe(`INSERT INTO ladder (rank, rung, model, review) VALUES
          (1, 'cheap', 'm1', 1), (2, 'dear', 'm1', 0)`);
        yield* sql.unsafe(rewindTo("ladder_levels"));
      }),
    );
    const rows = await at(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{ rank: number; level: number; rung: string }>`
          SELECT rank, level, rung FROM ladder ORDER BY rank`;
      }),
    );
    expect(rows).toEqual([
      { rank: 1, level: 1, rung: "cheap" },
      { rank: 2, level: 2, rung: "dear" },
    ]);
  });
});
