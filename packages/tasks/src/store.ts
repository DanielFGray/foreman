/**
 * The task store, read and written in process.
 *
 * It opens the same SQLite file as the Go `prog` (`PROG_DB`, else
 * `~/.prog/prog.db`), so both front ends see one set of tasks. Go owns the
 * schema of every table it created and `PRAGMA user_version`; this module reads
 * and writes those tables the way Go does and adds none of its own.
 */
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer, Option, Schedule, Schema as S } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  epicStatus,
  type Item,
  type ItemType,
  type Status,
  TASK_MACHINE,
  type TaskEvent,
  type TaskState,
} from "./item.ts";
import { transition } from "./machine.ts";
import { rank } from "./rank.ts";
import { formatGo, parseStored } from "./time.ts";

export class TaskError extends S.TaggedError<TaskError>()("TaskError", {
  id: S.String,
  detail: S.String,
}) {}

/** Which items `list` returns. Every field narrows; absent fields do not. */
export interface ListFilter {
  readonly project?: string;
  readonly status?: Status;
  readonly type?: ItemType;
  readonly parent?: string;
  /** Items carrying every one of these labels. */
  readonly labels?: ReadonlyArray<string>;
}

export interface NewItem {
  readonly title: string;
  readonly project: string;
  readonly type?: ItemType;
  readonly status?: TaskState;
  readonly priority?: number;
  readonly parent?: string;
  readonly description?: string;
  readonly labels?: ReadonlyArray<string>;
}

export interface LogEntry {
  readonly message: string;
  readonly createdAt: Date;
}

export class Tasks extends Context.Service<Tasks>()("Tasks", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;

    const items = (where: SqlFragment) =>
      retrying(
        sql<ItemRow>`SELECT ${sql.literal(ITEM_COLUMNS)} FROM items WHERE ${where} ORDER BY priority ASC, created_at ASC`,
      ).pipe(Effect.flatMap(withDerived));

    /** Attaches labels, and derives each epic's status from its children. */
    const withDerived = (rows: ReadonlyArray<ItemRow>) =>
      Effect.gen(function* () {
        if (rows.length === 0) return [] as ReadonlyArray<Item>;
        const ids = rows.map((row) => row.id);
        const labels = yield* retrying(
          sql<{ item_id: string; name: string }>`
            SELECT il.item_id, l.name FROM item_labels il JOIN labels l ON il.label_id = l.id
            WHERE ${sql.in("il.item_id", ids)} ORDER BY l.name`,
        );
        const epics = rows.filter((row) => row.type === "epic").map((row) => row.id);
        const children =
          epics.length === 0
            ? []
            : yield* retrying(
                sql<{ parent_id: string; status: Status }>`
                  SELECT parent_id, status FROM items WHERE ${sql.in("parent_id", epics)}`,
              );
        return rows.map((row) => itemOf(row, labels, children));
      });

    const require = (id: string) =>
      get(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new TaskError({ id, detail: `item not found: ${id}` })),
            onSome: Effect.succeed,
          }),
        ),
      );

    const get = (id: string) =>
      items(sql`id = ${id}`).pipe(Effect.map((found) => Option.fromNullishOr(found[0])));

    const list = (filter: ListFilter = {}) =>
      items(
        sql.and([
          sql`1 = 1`,
          ...(filter.project === undefined ? [] : [sql`project = ${filter.project}`]),
          ...(filter.type === undefined ? [] : [sql`type = ${filter.type}`]),
          ...(filter.parent === undefined ? [] : [sql`parent_id = ${filter.parent}`]),
          ...(filter.labels === undefined || filter.labels.length === 0
            ? []
            : [labelled(filter.labels)]),
        ]),
      ).pipe(
        // Status is filtered after derivation, so an epic is listed under the
        // status a reader is shown, not the one stored.
        Effect.map((found) =>
          filter.status === undefined
            ? found
            : found.filter((item) => item.status === filter.status),
        ),
      );

    const labelled = (labels: ReadonlyArray<string>) => sql`id IN (
      SELECT il.item_id FROM item_labels il JOIN labels l ON il.label_id = l.id
      WHERE ${sql.in("l.name", labels)}
      GROUP BY il.item_id HAVING COUNT(DISTINCT l.name) = ${labels.length})`;

    /**
     * Open tasks whose dependencies are all resolved, best first.
     *
     * A dependency is resolved when it is done or canceled, or is an epic whose
     * children all are. A task labelled `question` is a decision awaiting an
     * answer, never work to start, so it is not ready at any status.
     */
    const ready = (project?: string, labels: ReadonlyArray<string> = []) =>
      Effect.gen(function* () {
        const found = yield* items(
          sql.and([
            sql`status = 'open' AND type = 'task'`,
            sql`id NOT IN (SELECT d.item_id FROM deps d JOIN items i ON d.depends_on = i.id WHERE ${sql.literal(UNRESOLVED)})`,
            sql`id NOT IN (SELECT il.item_id FROM item_labels il JOIN labels l ON il.label_id = l.id WHERE l.name = 'question')`,
            ...(project === undefined ? [] : [sql`project = ${project}`]),
            ...(labels.length === 0 ? [] : [labelled(labels)]),
          ]),
        );
        const progress = yield* epicProgress([
          ...new Set(found.flatMap((item) => (item.parent === undefined ? [] : [item.parent]))),
        ]);
        return rank(found, new Date(), (item) =>
          item.parent === undefined ? 0 : (progress.get(item.parent) ?? 0),
        );
      });

    /** The fraction of each epic's direct children that are done. */
    const epicProgress = (epics: ReadonlyArray<string>) =>
      epics.length === 0
        ? Effect.succeed(new Map<string, number>())
        : retrying(
            sql<{ parent_id: string; done: number; total: number }>`
              SELECT parent_id, SUM(status = 'done') AS done, COUNT(*) AS total FROM items
              WHERE ${sql.in("parent_id", epics)} GROUP BY parent_id`,
          ).pipe(
            Effect.map((rows) => new Map(rows.map((row) => [row.parent_id, row.done / row.total]))),
          );

    /** The items `id` depends on. */
    const dependencies = (id: string) =>
      retrying(
        sql<{
          depends_on: string;
        }>`SELECT depends_on FROM deps WHERE item_id = ${id} ORDER BY depends_on`,
      ).pipe(Effect.map((rows) => rows.map((row) => row.depends_on)));

    const logs = (id: string) =>
      retrying(
        sql<{
          message: string;
          created_at: string;
        }>`SELECT message, created_at FROM logs WHERE item_id = ${id} ORDER BY created_at ASC, id ASC`,
      ).pipe(
        Effect.map((rows): ReadonlyArray<LogEntry> =>
          rows.map((row) => ({ message: row.message, createdAt: storedDate(row.created_at) })),
        ),
      );

    /**
     * Moves an item's status by `event`, as the task machine allows.
     *
     * The write is a compare-and-set on the status the machine was asked about,
     * so a transition another process made in between is not overwritten by a
     * stale one. An epic's status is derived, so only `done` and `cancel` close
     * one by hand.
     */
    const send = (id: string, event: TaskEvent) =>
      Effect.gen(function* () {
        const row = yield* retrying(
          sql<{
            type: ItemType;
            status: TaskState;
          }>`SELECT type, status FROM items WHERE id = ${id}`,
        );
        const current = row[0];
        if (current === undefined)
          return yield* new TaskError({ id, detail: `item not found: ${id}` });
        if (current.type === "epic" && event !== "done" && event !== "cancel") {
          return yield* new TaskError({
            id,
            detail:
              "epic status is derived from children; only 'done' and 'canceled' can be set manually (to force-close)",
          });
        }
        const next = transition(TASK_MACHINE, current.status, event);
        if (Option.isNone(next)) {
          return yield* new TaskError({
            id,
            detail: `cannot ${event} an item that is ${current.status}`,
          });
        }
        const changed = yield* retrying(
          sql`UPDATE items SET status = ${next.value}, updated_at = ${formatGo(new Date())}
              WHERE id = ${id} AND status = ${current.status} RETURNING id`,
        );
        if (changed.length === 0) {
          return yield* new TaskError({
            id,
            detail: `${id} changed status while ${event} was applied`,
          });
        }
        return next.value;
      });

    /**
     * Rewrites an item's labels in one transaction: `change` gets the labels it
     * carries and answers the ones it should, and only the difference is
     * written. A label new to the item's project is created there, as Go does.
     * Answers the labels the item carried before.
     */
    const relabel = (
      id: string,
      change: (labels: ReadonlyArray<string>) => ReadonlyArray<string>,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* require(id);
            const next = new Set(change(item.labels));
            const removed = item.labels.filter((name) => !next.has(name));
            const added = [...next].filter((name) => !item.labels.includes(name));
            if (removed.length > 0) {
              yield* sql`DELETE FROM item_labels WHERE item_id = ${id}
                AND label_id IN (SELECT id FROM labels WHERE project = ${item.project} AND ${sql.in("name", removed)})`;
            }
            for (const name of added) {
              const existing = yield* sql<{
                id: string;
              }>`SELECT id FROM labels WHERE name = ${name} AND project = ${item.project}`;
              const labelId = existing[0]?.id ?? `lbl-${hex(3)}`;
              if (existing.length === 0) {
                const now = formatGo(new Date());
                yield* sql`INSERT INTO labels (id, name, project, created_at, updated_at) VALUES (${labelId}, ${name}, ${item.project}, ${now}, ${now})`;
              }
              yield* sql`INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (${id}, ${labelId})`;
            }
            return item.labels;
          }),
        )
        .pipe(retrying);

    const label = (id: string, name: string) =>
      relabel(id, (labels) => [...labels, name]).pipe(Effect.asVoid);

    const unlabel = (id: string, name: string) =>
      relabel(id, (labels) => labels.filter((label) => label !== name)).pipe(
        Effect.flatMap((before) =>
          before.includes(name)
            ? Effect.void
            : Effect.fail(new TaskError({ id, detail: `item does not have label: ${name}` })),
        ),
      );

    const log = (id: string, message: string) =>
      require(id).pipe(
        Effect.andThen(
          retrying(sql`INSERT INTO logs (item_id, message) VALUES (${id}, ${message})`),
        ),
        Effect.asVoid,
      );

    const add = (item: NewItem) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const type = item.type ?? "task";
            const id = `${type === "epic" ? "ep" : "ts"}-${hex(3)}`;
            const project = item.project.trim();
            const now = formatGo(new Date());
            if (project !== "") {
              yield* sql`INSERT OR IGNORE INTO projects (name, created_at, updated_at) VALUES (${project}, ${now}, ${now})`;
            }
            yield* sql`INSERT INTO items (id, project, type, title, description, status, priority, parent_id, created_at, updated_at)
              VALUES (${id}, ${project}, ${type}, ${item.title}, ${item.description ?? ""}, ${item.status ?? "open"},
                      ${item.priority ?? 2}, ${item.parent ?? null}, ${now}, ${now})`;
            return id;
          }),
        )
        .pipe(
          retrying,
          Effect.tap((id) =>
            Effect.forEach(item.labels ?? [], (name) => label(id, name), { discard: true }),
          ),
        );

    return {
      get,
      list,
      ready,
      dependencies,
      logs,
      send,
      relabel,
      label,
      unlabel,
      log,
      add,
    } as const;
  }),
}) {
  /** The store in one file, for tests and tools that work on a copy. */
  static readonly layerAt = (filename: string) =>
    Layer.effect(this, this.make).pipe(
      Layer.provide(SqliteClient.layer({ filename, busyTimeout: "5 seconds" })),
    );

  /** The store at `PROG_DB`, else `~/.prog/prog.db`, read when the layer is built. */
  static readonly layer = Layer.suspend(() => Tasks.layerAt(storePath()));
}

/** The task store's file: `PROG_DB`, else `~/.prog/prog.db`, as the Go `prog` resolves it. */
export const storePath = (): string => process.env.PROG_DB ?? join(homedir(), ".prog", "prog.db");

type SqlFragment = ReturnType<SqlClient.SqlClient["and"]>;

interface ItemRow {
  readonly id: string;
  readonly project: string;
  readonly type: ItemType;
  readonly title: string;
  readonly description: string | null;
  readonly definition_of_done: string | null;
  readonly status: Status;
  readonly priority: number;
  readonly parent_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_log_at: string | null;
}

const ITEM_COLUMNS = `id, project, type, title, description, definition_of_done, status, priority, parent_id, created_at, updated_at,
  (SELECT MAX(l.created_at) FROM logs l WHERE l.item_id = items.id) AS last_log_at`;

/** True for a dependency, aliased `i`, that is not yet resolved. */
const UNRESOLVED = `NOT (
  i.status IN ('done', 'canceled')
  OR (i.type = 'epic'
      AND EXISTS (SELECT 1 FROM items c WHERE c.parent_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = i.id AND c.status NOT IN ('done', 'canceled'))))`;

const itemOf = (
  row: ItemRow,
  labels: ReadonlyArray<{ item_id: string; name: string }>,
  children: ReadonlyArray<{ parent_id: string; status: Status }>,
): Item => {
  const updatedAt = storedDate(row.updated_at);
  const lastLog = row.last_log_at === null ? undefined : parseStored(row.last_log_at);
  return {
    id: row.id,
    project: row.project,
    type: row.type,
    title: row.title,
    description: row.description ?? "",
    definitionOfDone: row.definition_of_done ?? undefined,
    status:
      row.type === "epic"
        ? epicStatus(
            row.status,
            children.filter((child) => child.parent_id === row.id).map((child) => child.status),
          )
        : row.status,
    priority: row.priority,
    parent: row.parent_id ?? undefined,
    labels: labels.filter((label) => label.item_id === row.id).map((label) => label.name),
    createdAt: storedDate(row.created_at),
    updatedAt,
    lastActivityAt: lastLog !== undefined && lastLog > updatedAt ? lastLog : updatedAt,
  };
};

/** A stored time; an unreadable one reads as the epoch, which sorts oldest. */
const storedDate = (text: string): Date => parseStored(text) ?? new Date(0);

const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Retries a statement that failed only because another process held the file.
 *
 * Every connection already waits out `busy_timeout`, so a retry happens only
 * after that wait was spent once. The codes are SQLite's "not right now"
 * answers; CANTOPEN and READONLY also show up while another process changes the
 * journal, and clear on their own.
 */
const retrying = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      while: (error) => isTransient(error),
      schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
      times: 2,
    }),
  );

const isTransient = (error: unknown): boolean => {
  const cause = (error as Partial<SqlError.SqlError> | undefined)?.cause as
    | { code?: unknown }
    | undefined;
  return (
    typeof cause?.code === "string" &&
    ["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_READONLY", "SQLITE_CANTOPEN"].some((code) =>
      (cause.code as string).startsWith(code),
    )
  );
};
