import { Array as Arr, Effect, Option, Order, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { Ladder, Rung } from "./ladder.ts";
import type { Reviewer } from "./reviewers.ts";

/**
 * The model registry: the ladder, and the facts about each model on it.
 *
 * It is the `ladder` and `models` tables of the task store (`PROG_DB`, else
 * `~/.prog/prog.db`), reached through the `SqlClient` the process shares with
 * the task layer, so the order of the models, their launch settings and the
 * record of how each one fared live in one file. Foreman reads the ladder from
 * it on every start and refuses to run without it: a second copy of the order
 * in a config file is a copy that can disagree.
 *
 * Models themselves (harness, pool) are rows the task store's migrations
 * define and the operator seeds. This module edits the ladder, which is the
 * part an operator reorders, enables and disables, and the reviewers, the list
 * a review block takes its reader from: a model may be a rung, a reviewer, both
 * or neither, and each rung and reviewer states its own thinking level.
 */

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/**
 * One ladder row as an operator edits it. The list is sorted by (level, rank),
 * and a write takes the rank from the position in the list.
 */
export interface LadderRow {
  readonly rung: string;
  readonly level: number;
  readonly model: string;
  readonly enabled: boolean;
  readonly author: boolean;
  readonly provider: string | null;
  readonly unmetered: boolean;
  readonly note: string | null;
  /** The rung's thinking level; null passes no flag, so the harness's default applies. */
  readonly thinking: string | null;
}

/** The ladder, cheapest level first, with each rung's harness from its model. */
export const readLadder = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rungs = yield* sql<{
    rung: string;
    level: number;
    model: string;
    enabled: number;
    author: number;
    provider: string | null;
    unmetered: number;
    harness: string;
    thinking: string | null;
  }>`SELECT l.rung, l.level, l.model, l.enabled, l.author, l.provider, l.unmetered,
            l.thinking, m.harness
       FROM ladder l JOIN models m USING (model)
      ORDER BY l.level, l.rank`;
  const [bottom, ...rest] = rungs.map((row): Rung => ({
    name: row.rung,
    harness: row.harness,
    level: row.level,
    model: row.model,
    provider: row.provider ?? undefined,
    enabled: row.enabled !== 0,
    author: row.author !== 0 ? undefined : false,
    unmetered: row.unmetered !== 0 ? true : undefined,
    thinking: row.thinking ?? undefined,
  }));
  if (bottom === undefined) {
    return yield* new RegistryError({ detail: "the ladder table has no rungs" });
  }
  return [bottom, ...rest] as Ladder;
}).pipe(Effect.mapError(registryError("reading the ladder")));

/** One rung with the record the registry holds for its model. */
export interface RungStatus {
  readonly rung: string;
  readonly level: number;
  readonly harness: string;
  readonly model: string;
  readonly thinking: string | null;
  readonly enabled: boolean;
  /** `retired`, `disabled`, or the model's derived `proven` / `trial`. */
  readonly state: string;
  readonly author: boolean;
  readonly slices: number;
  readonly succeeded: number;
  readonly avgRounds: number | null;
}

/** The ladder joined to `model_status`, for `foreman ladder` to print. */
export const readStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    rung: string;
    level: number;
    harness: string;
    model: string;
    thinking: string | null;
    enabled: number;
    author: number;
    retired: number;
    status: string;
    slices: number;
    succeeded: number;
    avg_rounds: number | null;
  }>`SELECT l.rung, l.level, s.harness, s.model, l.thinking, l.enabled, l.author,
            s.retired, s.status, s.slices, s.succeeded, s.avg_rounds
       FROM ladder l JOIN model_status s USING (model) ORDER BY l.level, l.rank`;
  return rows.map((row): RungStatus => ({
    rung: row.rung,
    level: row.level,
    harness: row.harness,
    model: row.model,
    thinking: row.thinking,
    enabled: row.enabled !== 0,
    state: row.retired ? "retired" : row.enabled ? row.status : "disabled",
    author: row.author !== 0,
    slices: row.slices,
    succeeded: row.succeeded,
    avgRounds: row.avg_rounds,
  }));
}).pipe(Effect.mapError(registryError("reading the ladder's record")));

/** Every model id the registry knows, for drift checks. */
export const knownModels = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ model: string }>`SELECT model FROM models`;
  return new Set(rows.map((row) => row.model)) as ReadonlySet<string>;
}).pipe(Effect.mapError(registryError("reading the models")));

/** One model with its harness, for a pane that draws the lists. */
export interface ModelEntry {
  readonly model: string;
  readonly harness: string;
  readonly retired: boolean;
}

/** Every model the registry knows, by model id. */
export const readModels = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    model: string;
    harness: string;
    retired: number;
  }>`SELECT model, harness, retired FROM models ORDER BY model`;
  return rows.map((row): ModelEntry => ({ ...row, retired: row.retired !== 0 }));
}).pipe(Effect.mapError(registryError("reading the models")));

/**
 * The reviewers, by name. A reviewer whose model is retired is left out: it is
 * never dispatched, and a drawing pinned to it no longer runs.
 */
export const readReviewers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    reviewer: string;
    model: string;
    thinking: string | null;
    provider: string | null;
    harness: string;
  }>`SELECT r.reviewer, r.model, r.thinking, r.provider, m.harness
       FROM reviewers r JOIN models m USING (model)
      WHERE m.retired = 0 ORDER BY r.reviewer`;
  return rows.map((row): Reviewer => ({
    name: row.reviewer,
    harness: row.harness,
    model: row.model,
    provider: row.provider ?? undefined,
    thinking: row.thinking ?? undefined,
  }));
}).pipe(Effect.mapError(registryError("reading the reviewers")));

/** A reviewer as `foreman reviewers add` states it. */
export interface NewReviewer {
  readonly name: string;
  readonly model: string;
  /** No flag, so the harness's own default, when absent. */
  readonly thinking: Option.Option<string>;
  /** Derived from the model when absent (`providerOf`). */
  readonly provider: Option.Option<string>;
}

/** Adds a reviewer. Its model must have a row, and its name must be new. */
export const addReviewer = (reviewer: NewReviewer) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const model = yield* sql<{ model: string }>`
      SELECT model FROM models WHERE model = ${reviewer.model}`;
    if (model.length === 0) {
      return yield* new RegistryError({
        detail: `model "${reviewer.model}" has no row in the models table`,
      });
    }
    const taken = yield* sql<{ reviewer: string }>`
      SELECT reviewer FROM reviewers WHERE reviewer = ${reviewer.name}`;
    if (taken.length > 0) {
      return yield* new RegistryError({ detail: `reviewer ${reviewer.name} is already listed` });
    }
    yield* sql`INSERT INTO reviewers (reviewer, model, thinking, provider)
      VALUES (${reviewer.name}, ${reviewer.model},
              ${Option.getOrNull(reviewer.thinking)},
              ${Option.getOrNull(reviewer.provider)})`;
  }).pipe(Effect.mapError(registryError("adding a reviewer")));

/** Removes the reviewer named `name`, or fails naming the reviewers there are. */
export const removeReviewer = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const removed = yield* sql<{ reviewer: string }>`
      DELETE FROM reviewers WHERE reviewer = ${name} RETURNING reviewer`;
    if (removed.length === 0) {
      const names = yield* sql<{ reviewer: string }>`
        SELECT reviewer FROM reviewers ORDER BY reviewer`;
      return yield* new RegistryError({
        detail: `no reviewer ${name}; reviewers: ${names.map((one) => one.reviewer).join(", ") || "none"}`,
      });
    }
  }).pipe(Effect.mapError(registryError("removing a reviewer")));

/** Landed slices, rounds and cost per success, by model and size. */
export const sizeSummary = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<Record<string, unknown>>`
    SELECT * FROM size_summary ORDER BY size, cost_per_success_usd`) as ReadonlyArray<
    Record<string, unknown>
  >;
}).pipe(Effect.mapError(registryError("reading the size summary")));

/** The ladder as editable rows, for `foreman ladder` and its editor. */
export const readRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    rung: string;
    level: number;
    model: string;
    enabled: number;
    author: number;
    provider: string | null;
    unmetered: number;
    note: string | null;
    thinking: string | null;
  }>`SELECT rung, level, model, enabled, author, provider, unmetered, note, thinking
       FROM ladder ORDER BY level, rank`;
  return rows.map((row): LadderRow => ({
    ...row,
    enabled: row.enabled !== 0,
    author: row.author !== 0,
    unmetered: row.unmetered !== 0,
  }));
}).pipe(Effect.mapError(registryError("reading the ladder rows")));

/**
 * Replaces the ladder with these rows, sorted by level; inside a level they
 * keep the order given.
 *
 * Rung names are the identity tasks record, so a rename is a different rung and
 * the tasks that recorded the old name stop positioning anything. Ranks are
 * rewritten from the sorted list, so the stored rank is the order of the rows
 * by (level, rank). Everything is validated before anything is written, and the write is one transaction, so a bad edit
 * leaves the ladder as it was.
 */
export const writeRows = (rows: ReadonlyArray<LadderRow>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const known = new Set(
      (yield* sql<{ model: string }>`SELECT model FROM models`).map((row) => row.model),
    );
    const problems = [
      ...(rows.length === 0 ? ["the ladder needs at least one rung"] : []),
      ...rows.flatMap((row, index) =>
        rows.findIndex((other) => other.rung === row.rung) !== index
          ? [`rung "${row.rung}" appears twice`]
          : [],
      ),
      ...rows
        .filter((row) => !known.has(row.model))
        .map(
          (row) =>
            `rung "${row.rung}" names model "${row.model}", which has no row in the models table`,
        ),
      ...rows
        .filter((row) => !Number.isSafeInteger(row.level))
        .map((row) => `rung "${row.rung}" has level ${row.level}, which is not an integer`),
      ...(rows.some((row) => row.enabled) ? [] : ["every rung is disabled"]),
    ];
    if (problems.length > 0) return yield* new RegistryError({ detail: problems.join("; ") });

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM ladder`;
        yield* Effect.forEach(
          Arr.sort(
            rows,
            Order.mapInput(Order.Number, (row: LadderRow) => row.level),
          ),
          (row, index) =>
            sql`INSERT INTO ladder(rank, level, rung, model, enabled, author, provider, unmetered, note, thinking)
                VALUES (${index + 1}, ${row.level}, ${row.rung}, ${row.model}, ${row.enabled ? 1 : 0},
                        ${row.author ? 1 : 0},
                        ${row.provider}, ${row.unmetered ? 1 : 0}, ${row.note}, ${row.thinking})`,
          { discard: true },
        );
      }),
    );
  }).pipe(Effect.mapError(registryError("writing the ladder")));

/**
 * Where a rung goes: in a level of its own just above or below a named rung's
 * level, or below the lowest level, which is the cheapest place. Adding one by
 * appending a row would put it above every paid rung.
 */
export type RungPlace =
  | { readonly _tag: "Bottom" }
  | { readonly _tag: "Above"; readonly rung: string }
  | { readonly _tag: "Below"; readonly rung: string };

/** Adds `row` to the ladder at `place`, in one validated write. */
export const addRow = (row: Omit<LadderRow, "level">, place: RungPlace) =>
  Effect.gen(function* () {
    const rows = yield* readRows;
    if (rows.some((other) => other.rung === row.rung)) {
      return yield* new RegistryError({ detail: `rung ${row.rung} is already on the ladder` });
    }
    yield* writeRows(yield* placed(rows, row, place));
  });

/** Moves a rung to `place`, which gives it a new level; nothing else about it changes. */
export const moveRow = (rung: string, place: RungPlace) =>
  Effect.gen(function* () {
    const rows = yield* readRows;
    const row = yield* rowOf(rows, rung);
    if (place._tag !== "Bottom" && place.rung === rung) {
      return yield* new RegistryError({ detail: `${rung} cannot move next to itself` });
    }
    const rest = rows.filter((other) => other.rung !== rung);
    yield* writeRows(yield* placed(rest, row, place));
  });

/** Rewrites one rung with `change`, in one validated write. */
export const changeRow = (rung: string, change: (row: LadderRow) => LadderRow) =>
  Effect.gen(function* () {
    const rows = yield* readRows;
    yield* rowOf(rows, rung);
    yield* writeRows(rows.map((row) => (row.rung === rung ? change(row) : row)));
  });

/** The row named `rung`, or a failure that lists the rungs there are. */
const rowOf = (rows: ReadonlyArray<LadderRow>, rung: string) => {
  const row = rows.find((other) => other.rung === rung);
  return row === undefined
    ? Effect.fail(
        new RegistryError({
          detail: `no rung ${rung}; rungs: ${rows.map((other) => other.rung).join(", ")}`,
        }),
      )
    : Effect.succeed(row);
};

/**
 * `rows` with `row` put at `place`, in a level of its own: it takes the level
 * the place names, and every level from there up moves up one to make room.
 * The level a moved rung leaves may stay empty, which orders nothing.
 */
const placed = (rows: ReadonlyArray<LadderRow>, row: Omit<LadderRow, "level">, place: RungPlace) =>
  Effect.gen(function* () {
    const level =
      place._tag === "Bottom"
        ? (rows[0]?.level ?? 1)
        : (yield* rowOf(rows, place.rung)).level + (place._tag === "Above" ? 1 : 0);
    return [
      ...rows.map((other) => (other.level >= level ? { ...other, level: other.level + 1 } : other)),
      { ...row, level },
    ];
  });

/** Parses the editor's text: a JSONC array of rows, with comments allowed. */
export const parseRows = (text: string): ReadonlyArray<LadderRow> => {
  const raw: unknown = Bun.JSONC.parse(text);
  return Schema.decodeUnknownSync(Schema.Array(RowFile))(raw).map((row) => ({
    rung: row.rung,
    level: row.level,
    model: row.model,
    enabled: row.enabled,
    author: row.author,
    provider: row.provider ?? null,
    unmetered: row.unmetered,
    note: row.note ?? null,
    thinking: row.thinking ?? null,
  }));
};

/** The editor's text: one object per rung, so a reorder is moving a block. */
export const renderRows = (rows: ReadonlyArray<LadderRow>): string =>
  [
    "// The ladder, cheapest level first. `level` groups the rungs: levels climb in",
    "// number, and the rungs of one level share the author work. Inside a level,",
    "// order is the rank; move a block to re-rank it.",
    "// A rung's name is what tasks record: renaming one makes a new rung.",
    "// `model` must already have a row in the registry's models table.",
    "// `thinking` is the level the rung's harness is started at; a rung without",
    "// one passes no flag, so the harness's own default applies.",
    "// `author: false` keeps a rung out of the author pick without retiring it.",
    "[",
    ...rows.map(
      (row) =>
        "  " +
        JSON.stringify({
          rung: row.rung,
          level: row.level,
          model: row.model,
          thinking: row.thinking ?? undefined,
          enabled: row.enabled,
          ...(row.author ? {} : { author: false }),
          ...(row.provider ? { provider: row.provider } : {}),
          ...(row.unmetered ? { unmetered: true } : {}),
          ...(row.note ? { note: row.note } : {}),
        }) +
        ",",
    ),
    "]",
    "",
  ].join("\n");

const RowFile = Schema.Struct({
  rung: Schema.NonEmptyString,
  level: Schema.Int,
  model: Schema.NonEmptyString,
  thinking: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  author: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  provider: Schema.optional(Schema.NullOr(Schema.String)),
  unmetered: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * What a store failure says, for a message an operator reads.
 *
 * A `SqlError` stringifies as "Failed to execute statement" alone; the
 * database's own words (a lock, a missing table) are on its `reason.cause`.
 */
export function reasonOf(error: unknown): string {
  const cause = (error as { reason?: { cause?: unknown } } | null)?.reason?.cause;
  if (cause instanceof Error) return cause.message;
  return cause === undefined ? String(error) : String(cause);
}

/** Names the step a store failure came from; a `RegistryError` passes through. */
export function registryError(step: string) {
  return (cause: unknown): RegistryError =>
    cause instanceof RegistryError
      ? cause
      : new RegistryError({ detail: `${step} in the task store: ${reasonOf(cause)}` });
}
