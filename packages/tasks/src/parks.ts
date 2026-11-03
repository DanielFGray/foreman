import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/** Parks a task for the operator, saying why; a second park replaces the reason. */
export const park = (task: string, reason: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO parks (task, reason) VALUES (${task}, ${reason})
      ON CONFLICT (task) DO UPDATE SET reason = excluded.reason, at = excluded.at`;
  });

/** Takes a task out of the operator's column. */
export const unpark = (task: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM parks WHERE task = ${task}`;
  });

/** Why each of these tasks is parked, keyed by task id. A task not parked has no entry. */
export const parksOf = (tasks: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    if (tasks.length === 0) return new Map<string, string>() as ReadonlyMap<string, string>;
    const rows = yield* sql<{ task: string; reason: string }>`SELECT task, reason FROM parks
      WHERE ${sql.in("task", tasks)}`;
    return new Map(rows.map((row) => [row.task, row.reason])) as ReadonlyMap<string, string>;
  });
