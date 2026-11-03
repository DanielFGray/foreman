import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAt } from "./connection.ts";
import { Tasks } from "./store.ts";
import {
  addRound,
  closeRun,
  deleteOpenRun,
  landAuthorRun,
  openRun,
  recordCheck,
  outcomeOf,
  runsOf,
  nameExit,
  type NewRun,
} from "./runs.ts";

const dir = mkdtempSync(join(tmpdir(), "tasks-runs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
const inStore = <A, E>(use: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(use.pipe(Effect.provide(connectionAt(join(dir, `store-${++files}.db`)))));

const inTasks = <A, E>(use: Effect.Effect<A, E, SqlClient | Tasks>) =>
  Effect.runPromise(
    use.pipe(
      Effect.provide(
        Tasks.layerSql.pipe(Layer.provideMerge(connectionAt(join(dir, `store-${++files}.db`)))),
      ),
    ),
  );

const run = (over: Partial<NewRun> = {}): NewRun => ({
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
    const runs = await inStore(
      Effect.gen(function* () {
        const id = yield* openRun(run({ base: "start" }));
        yield* closeRun(id, { ending: "done", commit: "end" });
        return (yield* runsOf(["ts-1"])).get("ts-1");
      }),
    );
    expect(runs?.[0]).toMatchObject({ base: "start", commit: "end" });
  });

  test("a run is open until closed, and closes with its outcome and commit", async () => {
    const [open, closed] = await inStore(
      Effect.gen(function* () {
        const id = yield* openRun(run());
        const open = (yield* runsOf(["ts-1"])).get("ts-1");
        yield* closeRun(id, { ending: "done", commit: "abc" });
        return [open, (yield* runsOf(["ts-1"])).get("ts-1")] as const;
      }),
    );
    expect(open?.map((r) => [r.open, r.ending, r.role])).toEqual([[true, undefined, "author"]]);
    expect(closed?.map((r) => [r.open, r.ending, r.commit])).toEqual([[false, "done", "abc"]]);
  });

  test("a review run keeps the tip it opened with when it closes", async () => {
    const runs = await inStore(
      Effect.gen(function* () {
        const id = yield* openRun(run({ work: "review", node: "review", commit: "tip1" }));
        yield* closeRun(id, { ending: "approved" });
        return (yield* runsOf(["ts-1"])).get("ts-1");
      }),
    );
    expect(runs?.[0]).toMatchObject({ role: "review", ending: "approved", commit: "tip1" });
  });

  test("an exit keeps the commit it was named on when settle closes the run", async () => {
    const runs = await inTasks(
      Effect.gen(function* () {
        const tasks = yield* Tasks;
        const id = yield* tasks.add({ project: "p", title: "t" });
        const review = yield* openRun(
          run({ task: id, work: "review", node: "review", commit: "tip1" }),
        );
        yield* nameExit(id, { name: "approved", commit: "tip2", event: undefined });
        yield* closeRun(review, { ending: "stopped", commit: "tip3" });
        return (yield* runsOf([id])).get(id);
      }),
    );
    expect(runs?.map((r) => [r.ending, r.commit])).toEqual([["approved", "tip2"]]);
  });

  test("runs read oldest first, per task", async () => {
    const byTask = await inStore(
      Effect.gen(function* () {
        yield* openRun(run({ rung: "a" }));
        yield* openRun(run({ task: "ts-2", rung: "x" }));
        yield* openRun(run({ rung: "b" }));
        return yield* runsOf(["ts-1", "ts-2", "ts-3"]);
      }),
    );
    expect(byTask.get("ts-1")?.map((r) => r.rung)).toEqual(["a", "b"]);
    expect(byTask.get("ts-2")?.map((r) => r.rung)).toEqual(["x"]);
    expect(byTask.has("ts-3")).toBe(false);
  });

  test("an open run that never started can be deleted, a closed one cannot", async () => {
    const result = await inStore(
      Effect.gen(function* () {
        const never = yield* openRun(run());
        yield* deleteOpenRun(never);
        const done = yield* openRun(run());
        yield* closeRun(done, { ending: "stopped" });
        const refused = yield* deleteOpenRun(done).pipe(Effect.flip);
        return { left: (yield* runsOf(["ts-1"])).get("ts-1")?.length, refused: refused._tag };
      }),
    );
    expect(result).toEqual({ left: 1, refused: "RunError" });
  });

  test("rounds count on the latest author run, open or closed, and never on a review", async () => {
    const counts = await inStore(
      Effect.gen(function* () {
        const author = yield* openRun(run());
        yield* openRun(run({ work: "review" }));
        const first = yield* addRound("ts-1");
        yield* closeRun(author, { ending: "done" });
        const second = yield* addRound("ts-1");
        const none = yield* addRound("ts-none").pipe(Effect.flip);
        return [first, second, none._tag];
      }),
    );
    expect(counts).toEqual([1, 2, "TaskError"]);
  });

  test("the store refuses an agent ending that is no exit name", async () => {
    const refused = await inStore(
      Effect.gen(function* () {
        const review = yield* openRun(run({ work: "review" }));
        return yield* closeRun(review, { ending: "Handed Off" }).pipe(Effect.flip);
      }),
    );
    expect(refused._tag).toBe("SqlError");
  });

  test("only an exit stands on an open run", async () => {
    const sql = await inStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = yield* openRun(run());
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
    const closed = await inStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = yield* openRun(run({ work: "review", node: "review", commit: "t" }));
        yield* sql`UPDATE runs SET ending = 'approved' WHERE id = ${id}`;
        yield* closeRun(id, { ending: "stopped" });
        return (yield* runsOf(["ts-1"])).get("ts-1");
      }),
    );
    expect(closed?.map((r) => [r.open, r.ending])).toEqual([[false, "approved"]]);
  });

  test("the outcome follows the ending, and landing sets the author's outcome", async () => {
    expect(outcomeOf("canceled")).toBe("dropped");
    expect(outcomeOf("approved")).toBe("handed-off");
    const outcomes = await inStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const author = yield* openRun(run());
        yield* closeRun(author, { ending: "done", commit: "x" });
        yield* landAuthorRun("ts-1", false);
        return yield* sql<{ outcome: string }>`SELECT outcome FROM runs`;
      }),
    );
    expect(outcomes.map((r) => r.outcome)).toEqual(["committed"]);
  });
});

describe("check runs", () => {
  const check = { project: "p", task: "ts-1", node: "lint", command: "bun run lint" } as const;

  test("are written closed with their ending and the commit they ran on", async () => {
    const runs = await inStore(
      Effect.gen(function* () {
        yield* recordCheck({ ...check, commit: "c1", ending: "failed" });
        yield* recordCheck({ ...check, commit: "c2", ending: "passed" });
        return (yield* runsOf(["ts-1"])).get("ts-1");
      }),
    );
    expect(runs?.map((r) => [r.role, r.node, r.commit, r.ending, r.open])).toEqual([
      ["check", "lint", "c1", "failed", false],
      ["check", "lint", "c2", "passed", false],
    ]);
  });

  test("are never an author's run: rounds and landing pass over them", async () => {
    const [rounds, rows] = await inStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const author = yield* openRun(run());
        yield* closeRun(author, { ending: "done", commit: "c1" });
        yield* recordCheck({ ...check, commit: "c1", ending: "passed" });
        const rounds = yield* addRound("ts-1");
        yield* landAuthorRun("ts-1", false);
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
    const refused = await inStore(
      Effect.gen(function* () {
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
    const rows = await inStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const author = yield* openRun(run());
        yield* closeRun(author, { ending: "done", commit: "c1" });
        yield* recordCheck({ ...check, commit: "c1", ending: "passed" });
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

  test("a second exit replaces the first, commit and all, and makes its status move", async () => {
    const [status, runs] = await inTasks(
      Effect.gen(function* () {
        const tasks = yield* Tasks;
        const id = yield* filed;
        yield* tasks.send(id, "start");
        yield* openRun(run({ task: id, work: "review", node: "review" }));
        yield* nameExit(id, { name: "approved", commit: "c1", event: undefined });
        yield* nameExit(id, { name: "returned", commit: "c2", event: "open" });
        const task = yield* tasks.require(id);
        return [task.status, (yield* runsOf([id])).get(id)?.map((r) => [r.ending, r.commit])];
      }),
    );
    expect(status).toBe("open");
    expect(runs).toEqual([["returned", "c2"]]);
  });

  test("is refused with no open run, or with a process ending's name, and moves nothing", async () => {
    const [none, process, status] = await inTasks(
      Effect.gen(function* () {
        const tasks = yield* Tasks;
        const id = yield* filed;
        yield* tasks.send(id, "start");
        const none = yield* nameExit(id, {
          name: "returned",
          commit: undefined,
          event: "open",
        }).pipe(Effect.flip);
        yield* openRun(run({ task: id }));
        const process = yield* nameExit(id, {
          name: "stopped",
          commit: undefined,
          event: undefined,
        }).pipe(Effect.flip);
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
        yield* sql.unsafe(`DROP TABLE runs`);
        yield* sql.unsafe(OLD_RUNS);
        // The migrator only runs ids above the latest recorded row, so later
        // migrations must go too or exits is skipped and the rename never runs.
        yield* sql.unsafe(
          `DELETE FROM tasks_migrations WHERE name IN ('exits', 'ladder_roles', 'six_statuses')`,
        );
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
