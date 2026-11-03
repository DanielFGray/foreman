import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * A rung charged with failing a task: an exit that `fails` named it, or a rung
 * spent by its stopped runs, or an operator's floor under a chosen rung.
 */
export interface Charge {
  readonly rung: string;
  /** The newest run on the task when the charge was written; empty when it had none. */
  readonly run: number | undefined;
  /** The operator took the charge back. */
  readonly forgiven: boolean;
}

/** Charges a rung with failing the task, after the runs it has now. */
export const charge = (task: string, rung: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO charges (task, rung, run)
      VALUES (${task}, ${rung}, (SELECT max(id) FROM runs WHERE task = ${task}))`;
  });

/** Takes back every standing charge of one rung on the task. */
export const forgive = (task: string, rung: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE charges SET forgiven_at = datetime('now')
      WHERE task = ${task} AND rung = ${rung} AND forgiven_at IS NULL`;
  });

/** The charges of these tasks, oldest first, keyed by task id. A task with none has no entry. */
export const chargesOf = (tasks: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const grouped = new Map<string, Array<Charge>>();
    if (tasks.length === 0) return grouped as ReadonlyMap<string, ReadonlyArray<Charge>>;
    const rows = yield* sql<{
      task: string;
      rung: string;
      run: number | null;
      forgiven_at: string | null;
    }>`SELECT task, rung, run, forgiven_at FROM charges WHERE ${sql.in("task", tasks)} ORDER BY id`;
    for (const row of rows) {
      const one: Charge = {
        rung: row.rung,
        run: row.run ?? undefined,
        forgiven: row.forgiven_at !== null,
      };
      grouped.set(row.task, [...(grouped.get(row.task) ?? []), one]);
    }
    return grouped as ReadonlyMap<string, ReadonlyArray<Charge>>;
  });
