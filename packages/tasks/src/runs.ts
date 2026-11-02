import { Effect, Schema as S } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/** What a run did, as foreman saw it end; an author run and a review run end differently. */
export const AUTHOR_ENDINGS = [
  "handed-off",
  "satisfied",
  "unfinished",
  "walled",
  "vanished",
  "released",
  "canceled",
  "landed",
] as const;
export const REVIEW_ENDINGS = ["approved", "returned", "no-verdict", "walled", "released"] as const;
export type AuthorEnding = (typeof AUTHOR_ENDINGS)[number];
export type ReviewEnding = (typeof REVIEW_ENDINGS)[number];
export type Ending = AuthorEnding | ReviewEnding;

/** The registry's four words for how a run went. */
export type Outcome = "committed" | "dropped" | "handed-off" | "answered";

export type Role = "author" | "review";

/** The `work` column: a review is its own kind, every other run is an author's. */
export type Work = "build" | "correction" | "research" | "review";

/** One row of `runs`, as foreman reads it. */
export interface Run {
  readonly id: number;
  readonly task: string;
  readonly role: Role;
  readonly rung: string | undefined;
  readonly node: string | undefined;
  readonly commit: string | undefined;
  /** Empty while the run is open, and for a run foreman did not settle. */
  readonly ending: Ending | undefined;
  readonly rounds: number | undefined;
  /** A run is open until it closes. */
  readonly open: boolean;
}

/**
 * The registry outcome a closing run is written with.
 *
 * Stored with the ending, not derived in a view: a run launched by hand has an
 * outcome and no ending.
 */
export const outcomeOf = (ending: Ending, research: boolean): Outcome => {
  switch (ending) {
    case "landed":
      return research ? "answered" : "committed";
    case "canceled":
      return "dropped";
    default:
      return "handed-off";
  }
};

export interface NewRun {
  readonly project: string;
  readonly task: string;
  readonly slice: string;
  readonly kind: string;
  readonly pool: string;
  readonly model: string;
  readonly rung: string | undefined;
  readonly node: string;
  readonly work: Work;
  /** A review run records the branch tip it reads. */
  readonly commit?: string | undefined;
  readonly size?: number | undefined;
  readonly evidence?: string | undefined;
}

/** Opens a run: it has a start and no end. Answers the new run's id. */
export const openRun = (run: NewRun) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: number }>`INSERT INTO runs
      (project, task, slice, kind, pool, model, rung, node, work, "commit", size, evidence,
       started_at, closed_at, outcome)
      VALUES (${run.project}, ${run.task}, ${run.slice}, ${run.kind}, ${run.pool}, ${run.model},
              ${run.rung ?? null}, ${run.node}, ${run.work}, ${run.commit ?? null},
              ${run.size ?? null}, ${run.evidence ?? null}, datetime('now'), NULL, NULL)
      RETURNING id`;
    return rows[0]!.id;
  });

/**
 * Closes an open run with its ending and the outcome that goes with it. An
 * author run that hands off passes the branch tip as `commit`; a review run
 * keeps the tip it opened with. Fails when the run is not open.
 */
export const closeRun = (
  id: number,
  close: { readonly ending: Ending; readonly research?: boolean; readonly commit?: string },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const changed = yield* sql`UPDATE runs
      SET ending = ${close.ending}, outcome = ${outcomeOf(close.ending, close.research ?? false)},
          "commit" = coalesce(${close.commit ?? null}, "commit"), closed_at = datetime('now')
      WHERE id = ${id} AND closed_at IS NULL RETURNING id`;
    if (changed.length === 0)
      return yield* Effect.fail(new RunError({ id, detail: "not an open run" }));
  });

/** Deletes an open run: the agent never started, so the run never happened. */
export const deleteOpenRun = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const gone = yield* sql`DELETE FROM runs WHERE id = ${id} AND closed_at IS NULL RETURNING id`;
    if (gone.length === 0)
      return yield* Effect.fail(new RunError({ id, detail: "not an open run" }));
  });

/** Counts one more correction round on an open author run. Answers the new count. */
export const addRound = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ rounds: number }>`UPDATE runs SET rounds = coalesce(rounds, 0) + 1
      WHERE id = ${id} AND closed_at IS NULL AND work <> 'review' RETURNING rounds`;
    if (rows.length === 0)
      return yield* Effect.fail(new RunError({ id, detail: "not an open author run" }));
    return rows[0]!.rounds;
  });

/** The runs of these tasks, oldest first, keyed by task id. A task with none has no entry. */
export const runsOf = (tasks: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const grouped = new Map<string, Array<Run>>();
    if (tasks.length === 0) return grouped as ReadonlyMap<string, ReadonlyArray<Run>>;
    const rows =
      yield* sql<RunRow>`SELECT id, task, work, rung, node, "commit", ending, rounds, closed_at
      FROM runs WHERE ${sql.in("task", tasks)} ORDER BY id`;
    for (const row of rows) {
      const run: Run = {
        id: row.id,
        task: row.task,
        role: row.work === "review" ? "review" : "author",
        rung: row.rung ?? undefined,
        node: row.node ?? undefined,
        commit: row.commit ?? undefined,
        ending: row.ending ?? undefined,
        rounds: row.rounds ?? undefined,
        open: row.closed_at === null,
      };
      grouped.set(row.task, [...(grouped.get(row.task) ?? []), run]);
    }
    return grouped as ReadonlyMap<string, ReadonlyArray<Run>>;
  });

export class RunError extends S.TaggedError<RunError>()("RunError", {
  id: S.Number,
  detail: S.String,
}) {}

interface RunRow {
  readonly id: number;
  readonly task: string;
  readonly work: Work;
  readonly rung: string | null;
  readonly node: string | null;
  readonly commit: string | null;
  readonly ending: Ending | null;
  readonly rounds: number | null;
  readonly closed_at: string | null;
}
