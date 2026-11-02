import { Effect, Schema as S } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { TaskEvent } from "./item.ts";
import { PROCESS_ENDINGS } from "./endings.ts";
import { Tasks, TaskError } from "./store.ts";

/** A check run is written closed: its command exited 0, or it did not. */
export const CHECK_ENDINGS = ["passed", "failed"] as const;
export type CheckEnding = (typeof CHECK_ENDINGS)[number];

/**
 * How a run ended: an exit the agent named, such as `approved`, or a process
 * ending. The store accepts any exit name for an agent run, because only
 * foreman knows the block the run was at and which exits it declares.
 */
export type Ending = string;

/** The form of an exit name. */
export const EXIT_NAME = /^[a-z-]+$/;

/** Whether `ending` names an exit, rather than how a process stopped. */
export const isExit = (ending: Ending | undefined): ending is string =>
  ending !== undefined &&
  EXIT_NAME.test(ending) &&
  !(PROCESS_ENDINGS as ReadonlyArray<string>).includes(ending);

/** The registry's four words for how a run went. */
export type Outcome = "committed" | "dropped" | "handed-off" | "answered";

/**
 * What part a run plays on its task. An author writes the branch, a reviewer
 * reads it, and a check runs a pipeline block's command on it. A check runs no
 * agent.
 */
export type Role = "author" | "review" | "check";

/** The kinds of work an author's run can be. */
const AUTHOR_WORK = ["build", "correction", "research"] as const;

/** The `work` column: an author's run says what kind of work it was. */
export type Work = (typeof AUTHOR_WORK)[number] | "review" | "check";

const roleOf = (work: Work): Role => (work === "review" || work === "check" ? work : "author");

/** The SQL condition that keeps the runs of `role`. */
const ofRole = (sql: SqlClient, role: Role) =>
  role === "author" ? sql.in("work", AUTHOR_WORK) : sql`work = ${role}`;

/** One row of `runs`, as foreman reads it. */
export interface Run {
  readonly id: number;
  readonly task: string;
  readonly role: Role;
  readonly rung: string | undefined;
  readonly node: string | undefined;
  readonly commit: string | undefined;
  /**
   * An author on the operator's branch: the commit it started from. Empty for
   * a run on a task branch, whose fork point git keeps.
   */
  readonly base: string | undefined;
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
  /** An agent's work: a check is written by `recordCheck`, never opened. */
  readonly work: Exclude<Work, "check">;
  /** A review run records the branch tip it reads. */
  readonly commit?: string | undefined;
  /** An author on the operator's branch records the commit it starts from. */
  readonly base?: string | undefined;
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
      (project, task, slice, kind, pool, model, rung, node, work, "commit", base, rounds, size,
       evidence, started_at, closed_at, outcome)
      VALUES (${run.project}, ${run.task}, ${run.slice}, ${run.kind}, ${run.pool}, ${run.model},
              ${run.rung ?? null}, ${run.node}, ${run.work}, ${run.commit ?? null}, ${run.base ?? null},
              ${run.rounds ?? null}, ${run.size ?? null}, ${run.evidence ?? null}, datetime('now'), NULL, NULL)
      RETURNING id`;
    return rows[0]!.id;
  });

/** A check block's run: its command ran on the branch at `commit`. */
export interface CheckRun {
  readonly project: string;
  readonly task: string;
  readonly node: string;
  readonly command: string;
  readonly commit: string;
  readonly ending: CheckEnding;
}

/**
 * Records a check run, closed, with its ending. A check is written only once
 * its command has exited, so a check that never finished leaves no run, and
 * the next reading runs it again.
 */
export const recordCheck = (check: CheckRun) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO runs
      (project, task, slice, node, work, "commit", ending, started_at, closed_at)
      VALUES (${check.project}, ${check.task}, ${check.command}, ${check.node}, 'check',
              ${check.commit}, ${check.ending}, datetime('now'), datetime('now'))`;
  });

/**
 * Closes an open run with its ending and the outcome that goes with it. An
 * exit the agent named while the run was open stands with the commit it was
 * named on; `ending` and `commit` are written only when it named none. A
 * review run keeps the tip it opened with. Fails when the run is not open.
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
    const named = open[0]!.ending;
    const ending = named ?? close.ending;
    const commit = named === null ? (close.commit ?? null) : null;
    yield* sql`UPDATE runs
      SET ending = ${ending}, outcome = ${outcomeOf(ending)},
          "commit" = coalesce(${commit}, "commit"), closed_at = datetime('now')
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
      WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND ${ofRole(sql, "author")})
      RETURNING rounds`;
    if (rows.length === 0)
      return yield* new TaskError({ id: task, detail: `${task} has no author run` });
    return rows[0]!.rounds;
  });

/** An exit an agent names, with the commit it names it on and the status move it makes. */
export interface NamedExit {
  readonly name: string;
  /** The task's tip when the exit is named; absent when the task has no tip to read. */
  readonly commit: string | undefined;
  readonly event: TaskEvent | undefined;
}

/**
 * Names the exit that ends the task's open agent run, records the commit it
 * was named on, and makes the status move that goes with it, in one
 * transaction. A second exit in the same run replaces the first, commit
 * included. Fails when the task has no open agent run, since a closed run
 * cannot change its exit, or when `name` is no exit name.
 */
export const nameExit = (task: string, exit: NamedExit) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tasks = yield* Tasks;
    yield* sql.withTransaction(
      recordExit(task, exit).pipe(
        Effect.andThen(exit.event === undefined ? Effect.void : tasks.send(task, exit.event)),
      ),
    );
  });

/**
 * Writes the exit and its commit on the task's open agent run, and nothing
 * else: the caller makes the status move, in the same transaction when it
 * wants the two together. Fails as `nameExit` does.
 */
export const recordExit = (task: string, exit: Omit<NamedExit, "event">) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    if (!isExit(exit.name))
      return yield* new TaskError({ id: task, detail: `${exit.name} is no exit name` });
    const changed = yield* sql`UPDATE runs
      SET ending = ${exit.name}, "commit" = coalesce(${exit.commit ?? null}, "commit")
      WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND closed_at IS NULL
                    AND work <> 'check')
      RETURNING id`;
    if (changed.length === 0)
      return yield* new TaskError({
        id: task,
        detail: `${task} has no open run to name ${exit.name} on`,
      });
  });

/**
 * Sends the task to review and names `done` on its open author run, when it
 * has one, in one transaction. A task worked without foreman has no run, and
 * moves all the same.
 */
export const handOff = (task: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tasks = yield* Tasks;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE runs SET ending = 'done'
          WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND closed_at IS NULL
                        AND ${ofRole(sql, "author")})`;
        yield* tasks.send(task, "review");
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
      WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND ${ofRole(sql, "author")})
        AND closed_at IS NOT NULL`;
  });

/** The runs of these tasks, oldest first, keyed by task id. A task with none has no entry. */
export const runsOf = (tasks: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const grouped = new Map<string, Array<Run>>();
    if (tasks.length === 0) return grouped as ReadonlyMap<string, ReadonlyArray<Run>>;
    const rows =
      yield* sql<RunRow>`SELECT id, task, work, rung, node, "commit", base, ending, rounds, closed_at
      FROM runs WHERE ${sql.in("task", tasks)} ORDER BY id`;
    for (const row of rows) {
      const run: Run = {
        id: row.id,
        task: row.task,
        role: roleOf(row.work),
        rung: row.rung ?? undefined,
        node: row.node ?? undefined,
        commit: row.commit ?? undefined,
        base: row.base ?? undefined,
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
  readonly base: string | null;
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
    readonly author?: Ending;
    readonly review?: Ending;
    readonly commit?: string;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const open = yield* sql<{ id: number; work: Work }>`SELECT id, work FROM runs
      WHERE task = ${task} AND closed_at IS NULL ORDER BY id`;
    for (const { id, work } of open) {
      const role = roleOf(work);
      if (role === "review") {
        if (endings.review !== undefined) yield* closeRun(id, { ending: endings.review });
      } else if (role === "author" && endings.author !== undefined) {
        yield* closeRun(id, { ending: endings.author, commit: endings.commit });
      }
    }
  });

/** Deletes the task's open run of this role: the agent never started, so the run never happened. */
export const deleteOpenRunOf = (task: string, role: Role) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM runs WHERE task = ${task} AND closed_at IS NULL
      AND ${ofRole(sql, role)}`;
  });
