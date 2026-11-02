import { Effect, Schema as S } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Tasks, TaskError } from "./store.ts";

/**
 * How a run stopped. The agent writes the endings in `VERDICTS` while its run
 * is open; settle writes the others when it closes the run, and keeps the
 * agent's when there is one.
 */
export const AUTHOR_ENDINGS = [
  "satisfied",
  "handed-off",
  "unfinished",
  "walled",
  "vanished",
  "released",
  "canceled",
] as const;
export const REVIEW_ENDINGS = ["approved", "returned", "no-verdict", "walled", "released"] as const;
export type AuthorEnding = (typeof AUTHOR_ENDINGS)[number];
export type ReviewEnding = (typeof REVIEW_ENDINGS)[number];
export type Ending = AuthorEnding | ReviewEnding;

/** What an agent may state about its own run, and the run and status move each one means. */
export const VERDICTS = {
  approved: { role: "review", event: undefined },
  returned: { role: "review", event: "open" },
  satisfied: { role: "author", event: "review" },
} as const;
export type Verdict = keyof typeof VERDICTS;

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
 * outcome and no ending. Landing later sets the author run's outcome to
 * `committed` or `answered`.
 */
export const outcomeOf = (ending: Ending): Outcome =>
  ending === "canceled" ? "dropped" : "handed-off";

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
  /** Correction rounds already counted; absent for a run that starts new. */
  readonly rounds?: number | undefined;
  readonly size?: number | undefined;
  readonly evidence?: string | undefined;
}

/** Opens a run: it has a start and no end. Answers the new run's id. */
export const openRun = (run: NewRun) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: number }>`INSERT INTO runs
      (project, task, slice, kind, pool, model, rung, node, work, "commit", rounds, size, evidence,
       started_at, closed_at, outcome)
      VALUES (${run.project}, ${run.task}, ${run.slice}, ${run.kind}, ${run.pool}, ${run.model},
              ${run.rung ?? null}, ${run.node}, ${run.work}, ${run.commit ?? null},
              ${run.rounds ?? null}, ${run.size ?? null}, ${run.evidence ?? null}, datetime('now'), NULL, NULL)
      RETURNING id`;
    return rows[0]!.id;
  });

/**
 * Closes an open run with its ending and the outcome that goes with it. The
 * ending the agent wrote while the run was open stands; `ending` is written
 * only when there was none. An author run that hands off passes the branch tip
 * as `commit`; a review run keeps the tip it opened with. Fails when the run
 * is not open.
 */
export const closeRun = (
  id: number,
  close: { readonly ending: Ending; readonly commit?: string },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const open = yield* sql<{ ending: Ending | null }>`SELECT ending FROM runs
      WHERE id = ${id} AND closed_at IS NULL`;
    if (open.length === 0) return yield* new RunError({ id, detail: "not an open run" });
    const ending = open[0]!.ending ?? close.ending;
    yield* sql`UPDATE runs
      SET ending = ${ending}, outcome = ${outcomeOf(ending)},
          "commit" = coalesce(${close.commit ?? null}, "commit"), closed_at = datetime('now')
      WHERE id = ${id}`;
  });

/** Deletes an open run: the agent never started, so the run never happened. */
export const deleteOpenRun = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const gone = yield* sql`DELETE FROM runs WHERE id = ${id} AND closed_at IS NULL RETURNING id`;
    if (gone.length === 0) return yield* new RunError({ id, detail: "not an open run" });
  });

/**
 * Counts one more correction round on the task's latest author run, and
 * answers the new count. The run may be closed: a correction goes to the
 * author after its work was handed off to review.
 */
export const addRound = (task: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ rounds: number }>`UPDATE runs SET rounds = coalesce(rounds, 0) + 1
      WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND work <> 'review')
      RETURNING rounds`;
    if (rows.length === 0)
      return yield* new TaskError({ id: task, detail: `${task} has no author run` });
    return rows[0]!.rounds;
  });

/**
 * States how the task's open run ended, and makes the status move that goes
 * with it, in one transaction. A second verdict on the same run replaces the
 * first. Fails when the task has no open run of the matching work: a closed run
 * cannot change its verdict.
 */
export const verdict = (task: string, said: Verdict) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tasks = yield* Tasks;
    const { role, event } = VERDICTS[said];
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const changed = yield* sql`UPDATE runs SET ending = ${said}
          WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND closed_at IS NULL
                        AND (work = 'review') = ${role === "review" ? 1 : 0})
          RETURNING id`;
        if (changed.length === 0)
          return yield* new TaskError({
            id: task,
            detail: `${task} has no open ${role} run to say ${said} on`,
          });
        if (event !== undefined) yield* tasks.send(task, event);
      }),
    );
  });

/**
 * Sets the outcome of the task's latest closed author run to what landing made
 * of its work: code `committed`, a report `answered`. Runs in the transaction
 * that completes the task.
 */
export const landAuthorRun = (task: string, research: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE runs SET outcome = ${research ? "answered" : "committed"}
      WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND work <> 'review')
        AND closed_at IS NOT NULL`;
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

/**
 * Closes every open run of a task that has an ending for its role, keeping the
 * ending an agent wrote. The author run takes the branch tip as `commit` when
 * one is given. A role with no ending is left open.
 */
export const closeOpenRuns = (
  task: string,
  endings: {
    readonly author?: AuthorEnding;
    readonly review?: ReviewEnding;
    readonly commit?: string;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const open = yield* sql<{ id: number; work: Work }>`SELECT id, work FROM runs
      WHERE task = ${task} AND closed_at IS NULL ORDER BY id`;
    for (const { id, work } of open) {
      if (work === "review") {
        if (endings.review !== undefined) yield* closeRun(id, { ending: endings.review });
      } else if (endings.author !== undefined) {
        yield* closeRun(id, { ending: endings.author, commit: endings.commit });
      }
    }
  });

/** Deletes the task's open run of this role: the agent never started, so the run never happened. */
export const deleteOpenRunOf = (task: string, role: Role) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM runs WHERE task = ${task} AND closed_at IS NULL
      AND (work = 'review') = ${role === "review" ? 1 : 0}`;
  });
