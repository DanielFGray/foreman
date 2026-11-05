/**
 * The task store, read and written in process.
 *
 * The file is `TASKS_DB`, else `~/.tasks/tasks.db`. Item, label, log and
 * dependency tables keep the Go `prog` schema layout; this module
 * owns that schema through its migrator. Tables `tasks` adds are in
 * `migrations.ts`.
 */
import { Context, Effect, Layer, Option, Schedule, Schema as S } from "effect";
import { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import { connectionAt, store } from "./connection.ts";
import {
  epicStatus,
  Item,
  ItemType,
  Status,
  TASK_MACHINE,
  type TaskEvent,
  TaskState,
} from "./item.ts";
import { cycleIn, type Dependency } from "./graph.ts";
import { transition } from "./machine.ts";
import { rank } from "./rank.ts";
import { formatGo, parseStored } from "./time.ts";

export class TaskError extends S.TaggedError<TaskError>()("TaskError", {
  id: S.String,
  detail: S.String,
}) {}

/**
 * Which items `list` returns. Every field narrows; absent or `undefined`
 * fields do not. Decoded once at `list`.
 */
export const ListFilter = S.Struct({
  project: S.OptionFromOptional(S.String),
  status: S.OptionFromOptional(Status),
  type: S.OptionFromOptional(ItemType),
  parent: S.OptionFromOptional(S.String),
  /** Items carrying every one of these labels. */
  labels: S.OptionFromOptional(S.Array(S.String)),
});
export type ListFilter = typeof ListFilter.Type;
export type ListFilterInput = typeof ListFilter.Encoded;

/** A new item as callers write it; decoded once at `add`. */
export const NewItem = S.Struct({
  title: S.String,
  project: S.String,
  type: S.OptionFromOptional(ItemType),
  status: S.OptionFromOptional(TaskState),
  priority: S.OptionFromOptional(S.Number),
  parent: S.OptionFromOptional(S.String),
  description: S.OptionFromOptional(S.String),
  definitionOfDone: S.OptionFromOptional(S.String),
  labels: S.OptionFromOptional(S.Array(S.String)),
});
export type NewItem = typeof NewItem.Type;
export type NewItemInput = typeof NewItem.Encoded;

/**
 * The text fields of an item. A field left out is kept; an empty definition of
 * done clears it. Decoded once at `edit`.
 */
export const ItemEdit = S.Struct({
  title: S.OptionFromOptional(S.String),
  description: S.OptionFromOptional(S.String),
  definitionOfDone: S.OptionFromOptional(S.String),
});
export type ItemEdit = typeof ItemEdit.Type;
export type ItemEditInput = typeof ItemEdit.Encoded;

export const LogEntry = S.Struct({
  message: S.String,
  createdAt: S.Date,
});
export type LogEntry = typeof LogEntry.Type;

export class Tasks extends Context.Service<Tasks>()("Tasks", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;

    const items = (where: SqlFragment) =>
      retrying(
        sql`SELECT ${sql.literal(ITEM_COLUMNS)} FROM items WHERE ${where} ORDER BY priority ASC, created_at ASC`,
      ).pipe(
        Effect.flatMap((rows) =>
          S.decodeUnknownEffect(S.Array(ItemRow))(rows).pipe(
            Effect.orDie,
            Effect.flatMap(withDerived),
          ),
        ),
      );

    /** Attaches labels, and derives each epic's status from its children. */
    const withDerived = (rows: ReadonlyArray<typeof ItemRow.Type>) =>
      Effect.gen(function* () {
        if (rows.length === 0) return [] as ReadonlyArray<Item>;
        const ids = rows.map((row) => row.id);
        const labels = yield* retrying(
          sql`SELECT il.item_id, l.name FROM item_labels il JOIN labels l ON il.label_id = l.id
            WHERE ${sql.in("il.item_id", ids)} ORDER BY l.name`,
        ).pipe(
          Effect.flatMap((raw) => S.decodeUnknownEffect(S.Array(LabelRow))(raw).pipe(Effect.orDie)),
        );
        const epics = rows.filter((row) => row.type === "epic").map((row) => row.id);
        const children =
          epics.length === 0
            ? ([] as ReadonlyArray<typeof ChildRow.Type>)
            : yield* retrying(
                sql`SELECT parent_id, status FROM items WHERE ${sql.in("parent_id", epics)}`,
              ).pipe(
                Effect.flatMap((raw) =>
                  S.decodeUnknownEffect(S.Array(ChildRow))(raw).pipe(Effect.orDie),
                ),
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
      items(sql`id = ${id}`).pipe(Effect.map((found) => Option.fromIterable(found)));

    const list = (input: ListFilterInput = {}) =>
      S.decodeUnknownEffect(ListFilter)(input).pipe(
        Effect.orDie,
        Effect.flatMap((filter) =>
          items(
            sql.and([
              sql`1 = 1`,
              ...Option.toArray(Option.map(filter.project, (project) => sql`project = ${project}`)),
              ...Option.toArray(Option.map(filter.type, (type) => sql`type = ${type}`)),
              ...Option.toArray(Option.map(filter.parent, (parent) => sql`parent_id = ${parent}`)),
              ...Option.toArray(
                Option.flatMap(filter.labels, (labels) =>
                  labels.length === 0 ? Option.none() : Option.some(labelled(labels)),
                ),
              ),
            ]),
          ).pipe(
            // Status is filtered after derivation, so an epic is listed under the
            // status a reader is shown, not the one stored.
            Effect.map((found) =>
              Option.match(filter.status, {
                onNone: () => found,
                onSome: (status) => found.filter((item) => item.status === status),
              }),
            ),
          ),
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
            ...Option.toArray(
              Option.map(Option.fromNullishOr(project), (name) => sql`project = ${name}`),
            ),
            ...(labels.length === 0 ? [] : [labelled(labels)]),
          ]),
        );
        const progress = yield* epicProgress([
          ...new Set(found.flatMap((item) => Option.toArray(item.parent))),
        ]);
        return rank(found, new Date(), (item) =>
          Option.match(item.parent, {
            onNone: () => 0,
            onSome: (parent) => progress.get(parent) ?? 0,
          }),
        );
      });

    /** The fraction of each epic's direct children that are done. */
    const epicProgress = (epics: ReadonlyArray<string>) =>
      epics.length === 0
        ? Effect.succeed(new Map<string, number>())
        : retrying(
            sql`SELECT parent_id, SUM(status = 'done') AS done, COUNT(*) AS total FROM items
              WHERE ${sql.in("parent_id", epics)} GROUP BY parent_id`,
          ).pipe(
            Effect.flatMap((raw) =>
              S.decodeUnknownEffect(S.Array(ProgressRow))(raw).pipe(Effect.orDie),
            ),
            Effect.map((rows) => new Map(rows.map((row) => [row.parent_id, row.done / row.total]))),
          );

    /** The items `id` depends on. */
    const dependencies = (id: string) =>
      retrying(sql`SELECT depends_on FROM deps WHERE item_id = ${id} ORDER BY depends_on`).pipe(
        Effect.flatMap((raw) =>
          S.decodeUnknownEffect(S.Array(S.Struct({ depends_on: S.String })))(raw).pipe(
            Effect.orDie,
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.depends_on)),
      );

    const logs = (id: string) =>
      retrying(
        sql`SELECT message, created_at FROM logs WHERE item_id = ${id} ORDER BY created_at ASC, id ASC`,
      ).pipe(
        Effect.flatMap((raw) => S.decodeUnknownEffect(S.Array(LogRow))(raw).pipe(Effect.orDie)),
        Effect.map((rows) =>
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
        const rows = yield* retrying(sql`SELECT type, status FROM items WHERE id = ${id}`).pipe(
          Effect.flatMap((raw) =>
            S.decodeUnknownEffect(S.Array(S.Struct({ type: ItemType, status: TaskState })))(
              raw,
            ).pipe(Effect.orDie),
          ),
        );
        const current = yield* Option.match(Option.fromIterable(rows), {
          onNone: () => Effect.fail(new TaskError({ id, detail: `item not found: ${id}` })),
          onSome: Effect.succeed,
        });
        if (current.type === "epic" && event !== "done" && event !== "cancel") {
          return yield* new TaskError({
            id,
            detail:
              "epic status is derived from children; only 'done' and 'canceled' can be set manually (to force-close)",
          });
        }
        const next = yield* Option.match(transition(TASK_MACHINE, current.status, event), {
          onNone: () =>
            Effect.fail(
              new TaskError({
                id,
                detail: `cannot ${event} an item that is ${current.status}`,
              }),
            ),
          onSome: Effect.succeed,
        });
        const changed = yield* retrying(
          sql`UPDATE items SET status = ${next}, updated_at = ${formatGo(new Date())}
              WHERE id = ${id} AND status = ${current.status} RETURNING id`,
        );
        if (changed.length === 0) {
          return yield* new TaskError({
            id,
            detail: `${id} changed status while ${event} was applied`,
          });
        }
        return next;
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
              const existing =
                yield* sql`SELECT id FROM labels WHERE name = ${name} AND project = ${item.project}`.pipe(
                  Effect.flatMap((raw) =>
                    S.decodeUnknownEffect(S.Array(S.Struct({ id: S.String })))(raw).pipe(
                      Effect.orDie,
                    ),
                  ),
                );
              const labelId = Option.getOrElse(
                Option.map(Option.fromIterable(existing), (row) => row.id),
                () => `lbl-${hex(3)}`,
              );
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

    /** The tasks that wait for `id`. */
    const dependents = (id: string) =>
      retrying(sql`SELECT item_id FROM deps WHERE depends_on = ${id} ORDER BY item_id`).pipe(
        Effect.flatMap((raw) =>
          S.decodeUnknownEffect(S.Array(S.Struct({ item_id: S.String })))(raw).pipe(Effect.orDie),
        ),
        Effect.map((rows) => rows.map((row) => row.item_id)),
      );

    /** Every dependency, or those of one project's tasks. */
    const allDependencies = (project?: string) =>
      retrying(
        sql`SELECT d.item_id, d.depends_on FROM deps d JOIN items i ON i.id = d.item_id
          WHERE ${Option.match(Option.fromNullishOr(project), {
            onNone: () => sql`1 = 1`,
            onSome: (name) => sql`i.project = ${name}`,
          })}
          ORDER BY d.item_id, d.depends_on`,
      ).pipe(
        Effect.flatMap((raw) =>
          S.decodeUnknownEffect(S.Array(S.Struct({ item_id: S.String, depends_on: S.String })))(
            raw,
          ).pipe(Effect.orDie),
        ),
        Effect.map((rows): ReadonlyArray<Dependency> =>
          rows.map((row) => ({ item: row.item_id, dependsOn: row.depends_on })),
        ),
      );

    /**
     * Makes `second` wait for `first`. An edge that would close a cycle is
     * refused, because no task on the cycle could ever start.
     */
    const block = (first: string, second: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* require(first);
            yield* require(second);
            const edges = [...(yield* allDependencies()), { item: second, dependsOn: first }];
            yield* Option.match(cycleIn(edges), {
              onNone: () => Effect.void,
              onSome: (path) =>
                Effect.fail(
                  new TaskError({
                    id: first,
                    detail: `cannot block ${second}: that makes a cycle (${path.join(" -> ")})`,
                  }),
                ),
            });
            yield* sql`INSERT OR IGNORE INTO deps (item_id, depends_on) VALUES (${second}, ${first})`;
          }),
        )
        .pipe(retrying);

    /** Ends the wait of `second` for `first`. */
    const unblock = (first: string, second: string) =>
      Effect.gen(function* () {
        yield* require(first);
        yield* require(second);
        const removed = yield* retrying(
          sql`DELETE FROM deps WHERE item_id = ${second} AND depends_on = ${first} RETURNING item_id`,
        );
        if (removed.length === 0) {
          return yield* new TaskError({ id: second, detail: `${first} does not block ${second}` });
        }
      });

    const setColumn = (
      id: string,
      column: "title" | "description" | "definition_of_done" | "priority" | "parent_id",
      value: string | number | null,
    ) =>
      retrying(
        sql`UPDATE items SET ${sql.literal(column)} = ${value}, updated_at = ${formatGo(new Date())} WHERE id = ${id}`,
      );

    const edit = (id: string, input: ItemEditInput) =>
      Effect.gen(function* () {
        const change = yield* S.decodeUnknownEffect(ItemEdit)(input).pipe(Effect.orDie);
        yield* require(id);
        yield* Option.match(change.title, {
          onNone: () => Effect.void,
          onSome: (title) =>
            title.trim() === ""
              ? Effect.fail(new TaskError({ id, detail: "title cannot be empty" }))
              : setColumn(id, "title", title),
        });
        yield* Option.match(change.description, {
          onNone: () => Effect.void,
          onSome: (description) => setColumn(id, "description", description),
        });
        yield* Option.match(change.definitionOfDone, {
          onNone: () => Effect.void,
          onSome: (definitionOfDone) =>
            setColumn(id, "definition_of_done", definitionOfDone === "" ? null : definitionOfDone),
        });
      });

    /** Adds `text` to the end of the description, on a new line. */
    const append = (id: string, text: string) =>
      require(id).pipe(
        Effect.flatMap((item) => setColumn(id, "description", `${item.description}\n${text}`)),
      );

    const checkPriority = (id: string, priority: number) =>
      [1, 2, 3].includes(priority)
        ? Effect.void
        : Effect.fail(
            new TaskError({
              id,
              detail: `invalid priority ${priority}: must be 1 (high), 2 (medium), or 3 (low)`,
            }),
          );

    const setPriority = (id: string, priority: number) =>
      Effect.gen(function* () {
        yield* checkPriority(id, priority);
        yield* require(id);
        yield* setColumn(id, "priority", priority);
      });

    /** Puts `id` under `parent`, which must be an epic. */
    const setParent = (id: string, parent: string) =>
      Effect.gen(function* () {
        yield* require(id);
        yield* requireEpic(id, parent);
        yield* setColumn(id, "parent_id", parent);
      });

    const requireEpic = (id: string, parent: string) =>
      get(parent).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new TaskError({ id, detail: `parent not found: ${parent}` })),
            onSome: (found) =>
              found.type === "epic"
                ? Effect.void
                : Effect.fail(
                    new TaskError({
                      id,
                      detail: `parent must be an epic, but ${parent} is a task`,
                    }),
                  ),
          }),
        ),
      );

    const add = (input: NewItemInput) =>
      S.decodeUnknownEffect(NewItem)(input).pipe(
        Effect.orDie,
        Effect.flatMap((item) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* Option.match(item.parent, {
                  onNone: () => Effect.void,
                  onSome: (parent) => requireEpic(item.title, parent),
                });
                yield* Option.match(item.priority, {
                  onNone: () => Effect.void,
                  onSome: (priority) => checkPriority(item.title, priority),
                });
                const type = Option.getOrElse(item.type, () => "task" as const);
                const id = `${type === "epic" ? "ep" : "ts"}-${hex(3)}`;
                const project = item.project.trim();
                const now = formatGo(new Date());
                if (project !== "") {
                  yield* sql`INSERT OR IGNORE INTO projects (name, created_at, updated_at) VALUES (${project}, ${now}, ${now})`;
                }
                yield* sql`INSERT INTO items (id, project, type, title, description, definition_of_done, status, priority, parent_id, created_at, updated_at)
                  VALUES (${id}, ${project}, ${type}, ${item.title},
                    ${Option.getOrElse(item.description, () => "")},
                    ${Option.getOrNull(item.definitionOfDone)},
                    ${Option.getOrElse(item.status, () => "open" as const)},
                    ${Option.getOrElse(item.priority, () => 2)},
                    ${Option.getOrNull(item.parent)},
                    ${now}, ${now})`;
                return id;
              }),
            )
            .pipe(
              retrying,
              Effect.tap((id) =>
                Effect.forEach(
                  Option.getOrElse(item.labels, () => [] as ReadonlyArray<string>),
                  (name) => label(id, name),
                  { discard: true },
                ),
              ),
            ),
        ),
      );

    return {
      get,
      require,
      list,
      ready,
      dependencies,
      dependents,
      allDependencies,
      block,
      unblock,
      edit,
      append,
      setPriority,
      setParent,
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
  /** The store over a `SqlClient` the caller provides, so services share one connection. */
  static readonly layerSql = Layer.effect(this, this.make);

  /** Default store: `Tasks` over the process's shared connection. */
  static readonly layer = Tasks.layerSql.pipe(Layer.provideMerge(store));

  /** The store in one file, for tests and tools that work on a copy. */
  static readonly layerAt = (filename: string) =>
    Tasks.layerSql.pipe(Layer.provide(connectionAt(filename)));
}

type SqlFragment = ReturnType<SqlClient.SqlClient["and"]>;

const ItemRow = S.Struct({
  id: S.String,
  project: S.String,
  type: ItemType,
  title: S.String,
  description: S.NullOr(S.String),
  definition_of_done: S.NullOr(S.String),
  status: Status,
  priority: S.Number,
  parent_id: S.NullOr(S.String),
  created_at: S.String,
  updated_at: S.String,
  last_log_at: S.NullOr(S.String),
});

const LabelRow = S.Struct({
  item_id: S.String,
  name: S.String,
});

const ChildRow = S.Struct({
  parent_id: S.String,
  status: Status,
});

const ProgressRow = S.Struct({
  parent_id: S.String,
  done: S.Number,
  total: S.Number,
});

const LogRow = S.Struct({
  message: S.String,
  created_at: S.String,
});

const ITEM_COLUMNS = `id, project, type, title, description, definition_of_done, status, priority, parent_id, created_at, updated_at,
  (SELECT MAX(l.created_at) FROM logs l WHERE l.item_id = items.id) AS last_log_at`;

/** True for a dependency, aliased `i`, that is not yet resolved. */
const UNRESOLVED = `NOT (
  i.status IN ('done', 'canceled')
  OR (i.type = 'epic'
      AND EXISTS (SELECT 1 FROM items c WHERE c.parent_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = i.id AND c.status NOT IN ('done', 'canceled'))))`;

const itemOf = (
  row: typeof ItemRow.Type,
  labels: ReadonlyArray<typeof LabelRow.Type>,
  children: ReadonlyArray<typeof ChildRow.Type>,
): Item => {
  const updatedAt = storedDate(row.updated_at);
  const lastLog = Option.flatMap(Option.fromNullishOr(row.last_log_at), parseStored);
  return Item.make({
    id: row.id,
    project: row.project,
    type: row.type,
    title: row.title,
    description: row.description ?? "",
    definitionOfDone: Option.fromNullishOr(row.definition_of_done),
    status:
      row.type === "epic"
        ? epicStatus(
            row.status,
            children.filter((child) => child.parent_id === row.id).map((child) => child.status),
          )
        : row.status,
    priority: row.priority,
    parent: Option.fromNullishOr(row.parent_id),
    labels: labels.filter((label) => label.item_id === row.id).map((label) => label.name),
    createdAt: storedDate(row.created_at),
    updatedAt,
    lastActivityAt: Option.match(lastLog, {
      onNone: () => updatedAt,
      onSome: (logAt) => (logAt > updatedAt ? logAt : updatedAt),
    }),
  });
};

/** A stored time; an unreadable one reads as the epoch, which sorts oldest. */
const storedDate = (text: string): Date => Option.getOrElse(parseStored(text), () => new Date(0));

const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Retries a statement that failed only because another process held the file.
 *
 * Every connection already waits out `busy_timeout`, so a retry happens only
 * after that wait was spent once. `SqlError.isRetryable` covers busy, locked,
 * and the other transient SQLite reasons the client classifies.
 */
const retrying = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      while: (error) => isSqlError(error) && error.isRetryable,
      schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
      times: 2,
    }),
  );
