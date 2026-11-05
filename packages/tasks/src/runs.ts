/**
 * The records of work on a task: its runs, the rungs charged with failing it,
 * and its park. `Runs` reads and writes them in the task store's connection.
 */
import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { SqlClient } from "effect/sql";
import { connectionAt, store } from "./connection.ts";
import { Ending, isExit } from "./endings.ts";
import { TaskEvent } from "./item.ts";
import { Tasks, TaskError } from "./store.ts";
import { parseStored } from "./time.ts";

export { Ending, isExit } from "./endings.ts";

/** A check run is written closed: its command exited 0, or it did not. */
export const CHECK_ENDINGS = ["passed", "failed"] as const;
export const CheckEnding = S.Literals(CHECK_ENDINGS);
export type CheckEnding = typeof CheckEnding.Type;

/** The registry's four words for how a run went. */
export const Outcome = S.Literals(["committed", "dropped", "handed-off", "answered"]);
export type Outcome = typeof Outcome.Type;

/**
 * What part a run plays on its task. An author writes the branch, a reviewer
 * reads it, and a check runs a pipeline block's command on it. A check runs no
 * agent.
 */
export const Role = S.Literals(["author", "review", "check"]);
export type Role = typeof Role.Type;

/** The kinds of work an author's run can be. */
const AUTHOR_WORK = ["build", "correction", "research"] as const;

/** The `work` column: an author's run says what kind of work it was. */
export const Work = S.Literals([...AUTHOR_WORK, "review", "check"]);
export type Work = typeof Work.Type;

/** An agent's work: a check is written by `recordCheck`, never opened. */
const AgentWork = S.Literals([...AUTHOR_WORK, "review"]);

export const roleOf = (work: Work): Role =>
  work === "review" || work === "check" ? work : "author";

/** One row of `runs`, as foreman reads it. */
export const Run = S.Struct({
  id: S.Int,
  task: S.String,
  role: Role,
  rung: S.Option(S.String),
  node: S.Option(S.String),
  commit: S.Option(S.String),
  /**
   * An author on the operator's branch: the commit it started from. Absent for
   * a run on a task branch, whose fork point git keeps.
   */
  base: S.Option(S.String),
  /** Absent while the run is open, and for a run foreman did not settle. */
  ending: S.Option(Ending),
  rounds: S.Option(S.Int),
  /** A run is open until it closes. */
  open: S.Boolean,
  /** The author run foreman landed when the task completed. */
  landed: S.Boolean,
});
export type Run = typeof Run.Type;

/**
 * The registry outcome a closing run is written with.
 *
 * Stored with the ending, not derived in a view: a run launched by hand has an
 * outcome and no ending. Landing later sets the author run's outcome to
 * `committed` or `answered`.
 */
export const outcomeOf = (ending: Ending): Outcome =>
  ending === "canceled" ? "dropped" : "handed-off";

/** A new run as callers write it; decoded once at `openRun`. */
export const NewRun = S.Struct({
  project: S.String,
  task: S.String,
  slice: S.String,
  kind: S.String,
  pool: S.String,
  model: S.String,
  rung: S.OptionFromOptional(S.String),
  node: S.String,
  work: AgentWork,
  /** A review run records the branch tip it reads. */
  commit: S.OptionFromOptional(S.String),
  /** An author on the operator's branch records the commit it starts from. */
  base: S.OptionFromOptional(S.String),
  /** Correction rounds already counted; absent for a run that starts new. */
  rounds: S.OptionFromOptional(S.Int),
  size: S.OptionFromOptional(S.Int),
  evidence: S.OptionFromOptional(S.String),
});
export type NewRun = typeof NewRun.Type;
export type NewRunInput = typeof NewRun.Encoded;

/** A check block's run: its command ran on the branch at `commit`. */
export const CheckRun = S.Struct({
  project: S.String,
  task: S.String,
  node: S.String,
  command: S.String,
  commit: S.String,
  ending: CheckEnding,
});
export type CheckRun = typeof CheckRun.Type;

/** The ending a run closes with, and the branch tip it leaves. */
export const RunClose = S.Struct({
  ending: Ending,
  commit: S.OptionFromOptional(S.String),
});
export type RunClose = typeof RunClose.Type;
export type RunCloseInput = typeof RunClose.Encoded;

/**
 * The endings that close a task's open runs, per role. A role with no ending
 * is left open. The author run takes `commit` as the branch tip it leaves.
 */
export const RoleEndings = S.Struct({
  author: S.OptionFromOptional(Ending),
  review: S.OptionFromOptional(Ending),
  commit: S.OptionFromOptional(S.String),
});
export type RoleEndings = typeof RoleEndings.Type;
export type RoleEndingsInput = typeof RoleEndings.Encoded;

/**
 * An exit an agent names, with the commit it names it on. `ending` is what the
 * run stores: the exit's id in the drawing, which is never a process ending.
 * It is checked when written, so a process ending fails as a `TaskError`.
 */
export const ExitRecord = S.Struct({
  ending: S.String,
  /** The task's tip when the exit is named; absent when the task has no tip to read. */
  commit: S.OptionFromOptional(S.String),
});
export type ExitRecord = typeof ExitRecord.Type;
export type ExitRecordInput = typeof ExitRecord.Encoded;

/** An exit an agent names, and the status move it makes. */
export const NamedExit = S.Struct({
  ...ExitRecord.fields,
  event: S.OptionFromOptional(TaskEvent),
});
export type NamedExit = typeof NamedExit.Type;
export type NamedExitInput = typeof NamedExit.Encoded;

/**
 * A rung charged with failing a task: an exit that `fails` named it, or a rung
 * spent by its stopped runs, or an operator's floor under a chosen rung.
 */
export const Charge = S.Struct({
  rung: S.String,
  /** The newest run on the task when the charge was written; absent when it had none. */
  run: S.Option(S.Int),
  /** The operator took the charge back. */
  forgiven: S.Boolean,
});
export type Charge = typeof Charge.Type;

export class RunError extends S.TaggedError<RunError>()("RunError", {
  id: S.Number,
  detail: S.String,
}) {}

const RunRow = S.Struct({
  id: S.Int,
  task: S.String,
  work: Work,
  rung: S.OptionFromNullOr(S.String),
  node: S.OptionFromNullOr(S.String),
  commit: S.OptionFromNullOr(S.String),
  base: S.OptionFromNullOr(S.String),
  ending: S.OptionFromNullOr(Ending),
  rounds: S.OptionFromNullOr(S.Int),
  outcome: S.OptionFromNullOr(Outcome),
  closed_at: S.OptionFromNullOr(S.String),
});

const runOf = (row: typeof RunRow.Type): Run => ({
  id: row.id,
  task: row.task,
  role: roleOf(row.work),
  rung: row.rung,
  node: row.node,
  commit: row.commit,
  base: row.base,
  ending: row.ending,
  rounds: row.rounds,
  open: Option.isNone(row.closed_at),
  landed: Option.exists(
    row.outcome,
    (outcome) => outcome === "committed" || outcome === "answered",
  ),
});

/**
 * One run as a history reader sees it: the whole row with its times, for a
 * report, a trace or a task's record. Placement reads `Run`, which leaves the
 * times out.
 */
export const RunRecord = S.Struct({
  id: S.Int,
  project: S.String,
  task: S.String,
  work: Work,
  rung: S.OptionFromNullOr(S.String),
  model: S.OptionFromNullOr(S.String),
  node: S.OptionFromNullOr(S.String),
  commit: S.OptionFromNullOr(S.String),
  ending: S.OptionFromNullOr(S.String),
  outcome: S.OptionFromNullOr(Outcome),
  rounds: S.OptionFromNullOr(S.Int),
  /** Absent for a run recorded before starts were kept. */
  startedAt: S.OptionFromNullOr(S.Date),
  /** Absent while the run is open. */
  closedAt: S.OptionFromNullOr(S.Date),
  costUsd: S.OptionFromNullOr(S.Finite),
});
export type RunRecord = typeof RunRecord.Type;

/** How long a closed run took, in milliseconds; absent without both times. */
export const durationOf = (run: RunRecord): Option.Option<number> =>
  Option.zipWith(
    run.startedAt,
    run.closedAt,
    (started, closed) => closed.getTime() - started.getTime(),
  );

/** A `runs` row with the columns a `RunRecord` reads, times as stored. */
const RecordRow = S.Struct({
  id: S.Int,
  project: S.String,
  task: S.String,
  work: Work,
  rung: S.OptionFromNullOr(S.String),
  model: S.OptionFromNullOr(S.String),
  node: S.OptionFromNullOr(S.String),
  commit: S.OptionFromNullOr(S.String),
  ending: S.OptionFromNullOr(S.String),
  outcome: S.OptionFromNullOr(Outcome),
  rounds: S.OptionFromNullOr(S.Int),
  started_at: S.OptionFromNullOr(S.String),
  closed_at: S.OptionFromNullOr(S.String),
  actual_cost_usd: S.OptionFromNullOr(S.Finite),
});

const recordOf = ({
  started_at,
  closed_at,
  actual_cost_usd,
  ...row
}: typeof RecordRow.Type): RunRecord => ({
  ...row,
  startedAt: Option.flatMap(started_at, parseStored),
  closedAt: Option.flatMap(closed_at, parseStored),
  costUsd: actual_cost_usd,
});

/** `date` in the layout SQLite's `datetime('now')` writes, which the run times use. */
const sqliteTime = (date: Date): string => date.toISOString().slice(0, 19).replace("T", " ");

const IdRow = S.Struct({ id: S.Int });
const OpenRow = S.Struct({ id: S.Int, work: Work });
const OpenEndingRow = S.Struct({ ending: S.OptionFromNullOr(Ending) });
const RoundsRow = S.Struct({ rounds: S.Int });
const StartRow = S.Struct({ rung: S.String, started_at: S.String });
const ChargeRow = S.Struct({
  task: S.String,
  rung: S.String,
  run: S.OptionFromNullOr(S.Int),
  forgiven_at: S.OptionFromNullOr(S.String),
});
const ParkRow = S.Struct({ task: S.String, reason: S.String });

/** Decodes the rows a query answered; a row the schema refuses is a defect. */
const rowsOf =
  <A, I>(schema: S.Codec<A, I>) =>
  (rows: ReadonlyArray<unknown>) =>
    S.decodeUnknownEffect(S.Array(schema))(rows).pipe(Effect.orDie);

/** Appends `value` to the list `key` holds in `grouped`. */
const pushTo = <A>(grouped: Map<string, Array<A>>, key: string, value: A): void => {
  grouped.set(key, [...(grouped.get(key) ?? []), value]);
};

export class Runs extends Context.Service<Runs>()("Runs", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* Tasks;

    /** The SQL condition that keeps the runs of `role`. */
    const ofRole = (role: Role) =>
      role === "author" ? sql.in("work", AUTHOR_WORK) : sql`work = ${role}`;

    /** Opens a run: it has a start and no end. Answers the new run's id. */
    const openRun = (input: NewRunInput) =>
      Effect.gen(function* () {
        const run = yield* S.decodeEffect(NewRun)(input).pipe(Effect.orDie);
        const rows = yield* sql`INSERT INTO runs
          (project, task, slice, kind, pool, model, rung, node, work, "commit", base, rounds, size,
           evidence, started_at, closed_at, outcome)
          VALUES (${run.project}, ${run.task}, ${run.slice}, ${run.kind}, ${run.pool}, ${run.model},
                  ${Option.getOrNull(run.rung)}, ${run.node}, ${run.work},
                  ${Option.getOrNull(run.commit)}, ${Option.getOrNull(run.base)},
                  ${Option.getOrNull(run.rounds)}, ${Option.getOrNull(run.size)},
                  ${Option.getOrNull(run.evidence)}, datetime('now'), NULL, NULL)
          RETURNING id`.pipe(Effect.flatMap(rowsOf(IdRow)));
        const created = yield* Effect.fromOption(Option.fromIterable(rows)).pipe(Effect.orDie);
        return created.id;
      });

    /**
     * Records a check run, closed, with its ending. A check is written only once
     * its command has exited, so a check that never finished leaves no run, and
     * the next reading runs it again.
     */
    const recordCheck = (check: CheckRun) =>
      sql`INSERT INTO runs
        (project, task, slice, node, work, "commit", ending, started_at, closed_at)
        VALUES (${check.project}, ${check.task}, ${check.command}, ${check.node}, 'check',
                ${check.commit}, ${check.ending}, datetime('now'), datetime('now'))`.pipe(
        Effect.asVoid,
      );

    /**
     * Closes an open run with `ending` and the outcome that goes with it. An
     * exit the agent named while the run was open stands with the commit it was
     * named on; `ending` and `commit` are written only when it named none. A
     * review run keeps the tip it opened with. Fails when the run is not open.
     */
    const settle = (id: number, ending: Ending, commit: Option.Option<string>) =>
      Effect.gen(function* () {
        const open = yield* sql`SELECT ending FROM runs
          WHERE id = ${id} AND closed_at IS NULL`.pipe(Effect.flatMap(rowsOf(OpenEndingRow)));
        const found = yield* Option.match(Option.fromIterable(open), {
          onNone: () => Effect.fail(new RunError({ id, detail: "not an open run" })),
          onSome: Effect.succeed,
        });
        const closing = Option.getOrElse(found.ending, () => ending);
        const tip = Option.match(found.ending, {
          onNone: () => Option.getOrNull(commit),
          onSome: () => null,
        });
        yield* sql`UPDATE runs
          SET ending = ${closing}, outcome = ${outcomeOf(closing)},
              "commit" = coalesce(${tip}, "commit"), closed_at = datetime('now')
          WHERE id = ${id}`;
      });

    const closeRun = (id: number, input: RunCloseInput) =>
      S.decodeEffect(RunClose)(input).pipe(
        Effect.orDie,
        Effect.flatMap((close) => settle(id, close.ending, close.commit)),
      );

    /** Deletes an open run: the agent never started, so the run never happened. */
    const deleteOpenRun = (id: number) =>
      Effect.gen(function* () {
        const gone =
          yield* sql`DELETE FROM runs WHERE id = ${id} AND closed_at IS NULL RETURNING id`;
        if (gone.length === 0) return yield* new RunError({ id, detail: "not an open run" });
      });

    /**
     * Counts one more correction round on the task's latest author run, and
     * answers the new count. The run may be closed: a correction goes to the
     * author after its work was handed off to review.
     */
    const addRound = (task: string) =>
      Effect.gen(function* () {
        const rows = yield* sql`UPDATE runs SET rounds = coalesce(rounds, 0) + 1
          WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND ${ofRole("author")})
          RETURNING rounds`.pipe(Effect.flatMap(rowsOf(RoundsRow)));
        const counted = yield* Option.match(Option.fromIterable(rows), {
          onNone: () =>
            Effect.fail(new TaskError({ id: task, detail: `${task} has no author run` })),
          onSome: Effect.succeed,
        });
        return counted.rounds;
      });

    /**
     * Writes the exit and its commit on the task's open agent run, and nothing
     * else: the caller makes the status move, in the same transaction when it
     * wants the two together. Fails when the task has no open agent run, since
     * a closed run cannot change its exit, or when `ending` is no exit.
     */
    const writeExit = (task: string, exit: ExitRecord) =>
      Effect.gen(function* () {
        if (!isExit(exit.ending))
          return yield* new TaskError({ id: task, detail: `${exit.ending} is no exit` });
        const changed = yield* sql`UPDATE runs
          SET ending = ${exit.ending}, "commit" = coalesce(${Option.getOrNull(exit.commit)}, "commit")
          WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND closed_at IS NULL
                        AND work <> 'check')
          RETURNING id`;
        if (changed.length === 0)
          return yield* new TaskError({
            id: task,
            detail: `${task} has no open run to name ${exit.ending} on`,
          });
      });

    const recordExit = (task: string, input: ExitRecordInput) =>
      S.decodeEffect(ExitRecord)(input).pipe(
        Effect.orDie,
        Effect.flatMap((exit) => writeExit(task, exit)),
      );

    /**
     * Names the exit that ends the task's open agent run, records the commit it
     * was named on, and makes the status move that goes with it, in one
     * transaction. A second exit in the same run replaces the first, commit
     * included. Fails as `recordExit` does.
     */
    const nameExit = (task: string, input: NamedExitInput) =>
      Effect.gen(function* () {
        const named = yield* S.decodeEffect(NamedExit)(input).pipe(Effect.orDie);
        yield* sql.withTransaction(
          writeExit(task, named).pipe(
            Effect.andThen(
              Option.match(named.event, {
                onNone: () => Effect.void,
                onSome: (event) => tasks.send(task, event),
              }),
            ),
          ),
        );
      });

    /**
     * Sets the outcome of the task's latest closed author run to what landing
     * made of its work: code `committed`, a report `answered`. Runs in the
     * transaction that completes the task.
     */
    const landAuthorRun = (task: string, research: boolean) =>
      sql`UPDATE runs SET outcome = ${research ? "answered" : "committed"}
        WHERE id = (SELECT max(id) FROM runs WHERE task = ${task} AND ${ofRole("author")})
          AND closed_at IS NOT NULL`.pipe(Effect.asVoid);

    /** The runs of these tasks, oldest first, keyed by task id. A task with none has no entry. */
    const runsOf = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const grouped = new Map<string, Array<Run>>();
        if (ids.length === 0) return grouped as ReadonlyMap<string, ReadonlyArray<Run>>;
        const rows =
          yield* sql`SELECT id, task, work, rung, node, "commit", base, ending, rounds, outcome, closed_at
          FROM runs WHERE ${sql.in("task", ids)} ORDER BY id`.pipe(Effect.flatMap(rowsOf(RunRow)));
        for (const row of rows) pushTo(grouped, row.task, runOf(row));
        return grouped as ReadonlyMap<string, ReadonlyArray<Run>>;
      });

    const RECORD_COLUMNS = sql.literal(`id, project, task, work, rung, model, node, "commit",
      ending, outcome, rounds, started_at, closed_at, actual_cost_usd`);

    /** The history of these tasks' runs, oldest first. */
    const recordsOf = (ids: ReadonlyArray<string>) =>
      ids.length === 0
        ? Effect.succeed<ReadonlyArray<RunRecord>>([])
        : sql`SELECT ${RECORD_COLUMNS} FROM runs WHERE ${sql.in("task", ids)} ORDER BY id`.pipe(
            Effect.flatMap(rowsOf(RecordRow)),
            Effect.map((rows): ReadonlyArray<RunRecord> => rows.map(recordOf)),
          );

    /**
     * The runs that closed at or after `since`, oldest close first. Run times
     * are stored to the second, so a reader that polls passes the last close it
     * read and skips the ids it already has.
     */
    const closedSince = (since: Date) =>
      sql`SELECT ${RECORD_COLUMNS} FROM runs
        WHERE closed_at >= ${sqliteTime(since)} ORDER BY closed_at, id`.pipe(
        Effect.flatMap(rowsOf(RecordRow)),
        Effect.map((rows): ReadonlyArray<RunRecord> => rows.map(recordOf)),
      );

    /**
     * The latest start of the runs of `role`, keyed by the name they record: a
     * rung for an author, a reviewer for a review. The two are separate lists, so
     * one name may stand in both. A name with no run that recorded its start has
     * no entry.
     */
    const lastStarts = Effect.fnUntraced(function* (role: "author" | "review") {
      const rows = yield* sql`
        SELECT rung, max(started_at) AS started_at FROM runs
         WHERE rung IS NOT NULL AND started_at IS NOT NULL AND ${ofRole(role)}
         GROUP BY rung`.pipe(Effect.flatMap(rowsOf(StartRow)));
      const starts: ReadonlyMap<string, Date> = new Map(
        rows.flatMap((row) =>
          Option.match(parseStored(row.started_at), {
            onNone: () => [] as ReadonlyArray<readonly [string, Date]>,
            onSome: (started) => [[row.rung, started] as const],
          }),
        ),
      );
      return starts;
    });

    /**
     * Closes every open run of a task that has an ending for its role, keeping
     * the ending an agent wrote. The author run takes the branch tip as `commit`
     * when one is given. A role with no ending is left open.
     */
    const closeOpenRuns = (task: string, input: RoleEndingsInput) =>
      Effect.gen(function* () {
        const endings = yield* S.decodeEffect(RoleEndings)(input).pipe(Effect.orDie);
        const open = yield* sql`SELECT id, work FROM runs
          WHERE task = ${task} AND closed_at IS NULL ORDER BY id`.pipe(
          Effect.flatMap(rowsOf(OpenRow)),
        );
        for (const { id, work } of open) {
          const role = roleOf(work);
          if (role === "review") {
            yield* Option.match(endings.review, {
              onNone: () => Effect.void,
              onSome: (ending) => settle(id, ending, Option.none()),
            });
          } else if (role === "author") {
            yield* Option.match(endings.author, {
              onNone: () => Effect.void,
              onSome: (ending) => settle(id, ending, endings.commit),
            });
          }
        }
      });

    /** Deletes the task's open run of this role: the agent never started, so the run never happened. */
    const deleteOpenRunOf = (task: string, role: Role) =>
      sql`DELETE FROM runs WHERE task = ${task} AND closed_at IS NULL
        AND ${ofRole(role)}`.pipe(Effect.asVoid);

    /** Charges a rung with failing the task, after the runs it has now. */
    const charge = (task: string, rung: string) =>
      sql`INSERT INTO charges (task, rung, run)
        VALUES (${task}, ${rung}, (SELECT max(id) FROM runs WHERE task = ${task}))`.pipe(
        Effect.asVoid,
      );

    /** Takes back every standing charge of one rung on the task. */
    const forgive = (task: string, rung: string) =>
      sql`UPDATE charges SET forgiven_at = datetime('now')
        WHERE task = ${task} AND rung = ${rung} AND forgiven_at IS NULL`.pipe(Effect.asVoid);

    /** The charges of these tasks, oldest first, keyed by task id. A task with none has no entry. */
    const chargesOf = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const grouped = new Map<string, Array<Charge>>();
        if (ids.length === 0) return grouped as ReadonlyMap<string, ReadonlyArray<Charge>>;
        const rows = yield* sql`SELECT task, rung, run, forgiven_at FROM charges
          WHERE ${sql.in("task", ids)} ORDER BY id`.pipe(Effect.flatMap(rowsOf(ChargeRow)));
        for (const row of rows) {
          pushTo(grouped, row.task, {
            rung: row.rung,
            run: row.run,
            forgiven: Option.isSome(row.forgiven_at),
          });
        }
        return grouped as ReadonlyMap<string, ReadonlyArray<Charge>>;
      });

    /** Parks a task for the operator, saying why; a second park replaces the reason. */
    const park = (task: string, reason: string) =>
      sql`INSERT INTO parks (task, reason) VALUES (${task}, ${reason})
        ON CONFLICT (task) DO UPDATE SET reason = excluded.reason, at = excluded.at`.pipe(
        Effect.asVoid,
      );

    /** Takes a task out of the operator's column. */
    const unpark = (task: string) =>
      sql`DELETE FROM parks WHERE task = ${task}`.pipe(Effect.asVoid);

    /** Why each of these tasks is parked, keyed by task id. A task not parked has no entry. */
    const parksOf = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (ids.length === 0) return new Map<string, string>() as ReadonlyMap<string, string>;
        const rows = yield* sql`SELECT task, reason FROM parks
          WHERE ${sql.in("task", ids)}`.pipe(Effect.flatMap(rowsOf(ParkRow)));
        return new Map(rows.map((row) => [row.task, row.reason])) as ReadonlyMap<string, string>;
      });

    return {
      openRun,
      recordCheck,
      closeRun,
      deleteOpenRun,
      addRound,
      recordExit,
      nameExit,
      landAuthorRun,
      runsOf,
      recordsOf,
      closedSince,
      lastStarts,
      closeOpenRuns,
      deleteOpenRunOf,
      charge,
      forgive,
      chargesOf,
      park,
      unpark,
      parksOf,
    } as const;
  }),
}) {
  /**
   * The records over a `SqlClient` and `Tasks` the caller provides, so every
   * service shares one connection. `nameExit` moves the task's status through
   * `Tasks`.
   */
  static readonly layerSql = Layer.effect(this, this.make);

  /** Default records: `Runs` and `Tasks` over the process's shared connection. */
  static readonly layer = Runs.layerSql.pipe(
    Layer.provideMerge(Tasks.layerSql),
    Layer.provideMerge(store),
  );

  /** The records in one file, for tests and tools that work on a copy. */
  static readonly layerAt = (filename: string) =>
    Runs.layerSql.pipe(
      Layer.provideMerge(Tasks.layerSql),
      Layer.provideMerge(connectionAt(filename)),
    );
}
