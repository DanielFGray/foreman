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
  verdict,
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
  test("a run is open until closed, and closes with its outcome and commit", async () => {
    const [open, closed] = await inStore(
      Effect.gen(function* () {
        const id = yield* openRun(run());
        const open = (yield* runsOf(["ts-1"])).get("ts-1");
        yield* closeRun(id, { ending: "handed-off", commit: "abc" });
        return [open, (yield* runsOf(["ts-1"])).get("ts-1")] as const;
      }),
    );
    expect(open?.map((r) => [r.open, r.ending, r.role])).toEqual([[true, undefined, "author"]]);
    expect(closed?.map((r) => [r.open, r.ending, r.commit])).toEqual([
      [false, "handed-off", "abc"],
    ]);
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
        yield* closeRun(done, { ending: "unfinished" });
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
        yield* closeRun(author, { ending: "handed-off" });
        const second = yield* addRound("ts-1");
        const none = yield* addRound("ts-none").pipe(Effect.flip);
        return [first, second, none._tag];
      }),
    );
    expect(counts).toEqual([1, 2, "TaskError"]);
  });

  test("the store refuses an ending its kind of run cannot have", async () => {
    const refused = await inStore(
      Effect.gen(function* () {
        const review = yield* openRun(run({ work: "review" }));
        return yield* closeRun(review, { ending: "satisfied" }).pipe(Effect.flip);
      }),
    );
    expect(refused._tag).toBe("SqlError");
  });

  test("only the agent's endings stand on an open run", async () => {
    const sql = await inStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const id = yield* openRun(run());
        const settle = yield* sql`UPDATE runs SET ending = 'handed-off' WHERE id = ${id}`.pipe(
          Effect.flip,
        );
        yield* sql`UPDATE runs SET ending = 'satisfied' WHERE id = ${id}`;
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
        yield* closeRun(id, { ending: "no-verdict" });
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
        yield* closeRun(author, { ending: "handed-off", commit: "x" });
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
        yield* closeRun(author, { ending: "handed-off", commit: "c1" });
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
        yield* closeRun(author, { ending: "handed-off", commit: "c1" });
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

describe("verdict", () => {
  const filed = Effect.gen(function* () {
    const tasks = yield* Tasks;
    const id = yield* tasks.add({ project: "p", title: "t" });
    return id;
  });

  test("returned reopens the task, and a second verdict replaces the first", async () => {
    const [status, endings] = await inTasks(
      Effect.gen(function* () {
        const tasks = yield* Tasks;
        const id = yield* filed;
        yield* tasks.send(id, "start");
        yield* tasks.send(id, "review");
        yield* openRun(run({ task: id, work: "review", node: "review" }));
        yield* verdict(id, "approved");
        yield* verdict(id, "returned");
        const task = yield* tasks.require(id);
        return [task.status, (yield* runsOf([id])).get(id)?.map((r) => r.ending)] as const;
      }),
    );
    expect(status).toBe("open");
    expect(endings).toEqual(["returned"]);
  });

  test("satisfied sends an author's task to review; approved leaves the status", async () => {
    const statuses = await inTasks(
      Effect.gen(function* () {
        const tasks = yield* Tasks;
        const id = yield* filed;
        yield* tasks.send(id, "start");
        yield* openRun(run({ task: id }));
        yield* verdict(id, "satisfied");
        const afterAuthor = (yield* tasks.require(id)).status;
        yield* openRun(run({ task: id, work: "review", node: "review" }));
        yield* verdict(id, "approved");
        return [afterAuthor, (yield* tasks.require(id)).status];
      }),
    );
    expect(statuses).toEqual(["reviewing", "reviewing"]);
  });

  test("a verdict with no open run of its work is refused and moves nothing", async () => {
    const [refused, status] = await inTasks(
      Effect.gen(function* () {
        const tasks = yield* Tasks;
        const id = yield* filed;
        yield* tasks.send(id, "start");
        const refused = yield* verdict(id, "returned").pipe(Effect.flip);
        return [refused._tag, (yield* tasks.require(id)).status] as const;
      }),
    );
    expect(refused).toBe("TaskError");
    expect(status).toBe("in_progress");
  });
});
