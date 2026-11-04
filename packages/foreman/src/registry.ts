import { Array as Arr, Effect, Order, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { launchArguments } from "./harness.ts";
import type { Ladder, Rung } from "./ladder.ts";

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
 * Models themselves (harness, pool, thinking level) are rows the task store's
 * migrations define and the operator seeds. This module edits the ladder, which
 * is the part an operator reorders, enables and disables, and each model's
 * council switch: a model is a worker, a council member, both or neither.
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
  readonly review: boolean;
  readonly provider: string | null;
  readonly unmetered: boolean;
  readonly note: string | null;
}

/** The ladder, cheapest level first, with each rung's launch settings from its model. */
export const readLadder = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rungs = yield* sql<{
    rung: string;
    level: number;
    model: string;
    enabled: number;
    author: number;
    review: number;
    provider: string | null;
    unmetered: number;
    harness: string;
    thinking: string;
  }>`SELECT l.rung, l.level, l.model, l.enabled, l.author, l.review, l.provider, l.unmetered,
            m.harness, m.thinking
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
    review: row.review !== 0 ? undefined : false,
    unmetered: row.unmetered !== 0 ? true : undefined,
    thinking: row.thinking,
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
  readonly tier: string;
  readonly thinking: string;
  readonly enabled: boolean;
  /** `retired`, `disabled`, or the model's derived `proven` / `trial`. */
  readonly state: string;
  readonly author: boolean;
  readonly review: boolean;
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
    thinking: string;
    tier: string;
    enabled: number;
    author: number;
    review: number;
    retired: number;
    status: string;
    slices: number;
    succeeded: number;
    avg_rounds: number | null;
  }>`SELECT l.rung, l.level, s.harness, s.model, s.thinking, s.tier, l.enabled, l.author, l.review,
            s.retired, s.status, s.slices, s.succeeded, s.avg_rounds
       FROM ladder l JOIN model_status s USING (model) ORDER BY l.level, l.rank`;
  return rows.map((row): RungStatus => ({
    rung: row.rung,
    level: row.level,
    harness: row.harness,
    model: row.model,
    thinking: row.thinking,
    tier: row.tier,
    enabled: row.enabled !== 0,
    state: row.retired ? "retired" : row.enabled ? row.status : "disabled",
    author: row.author !== 0,
    review: row.review !== 0,
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

/** One model with its tier and council switch, for a pane that draws the lists. */
export interface ModelEntry {
  readonly model: string;
  readonly harness: string;
  readonly tier: string;
  readonly retired: boolean;
  readonly council: boolean;
}

/** Every model the registry knows, by model id. */
export const readModels = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    model: string;
    harness: string;
    tier: string;
    retired: number;
    council: number;
  }>`SELECT model, harness, tier, retired, council FROM models ORDER BY model`;
  return rows.map((row): ModelEntry => ({
    ...row,
    retired: row.retired !== 0,
    council: row.council !== 0,
  }));
}).pipe(Effect.mapError(registryError("reading the models")));

/**
 * A council member and what a caller needs to launch it: the harness (the
 * vendor CLI), the model, and the flags that name the model and its thinking
 * level. The read-only flags are the caller's: they depend on what the caller
 * asks the member to do, not on the model.
 */
export interface CouncilMember {
  readonly model: string;
  readonly harness: string;
  readonly thinking: string;
  readonly tier: string;
  readonly args: ReadonlyArray<string>;
}

/** The models whose council switch is on, retired ones left out. */
export const readCouncil = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ model: string; harness: string; thinking: string; tier: string }>`
    SELECT model, harness, thinking, tier FROM models
     WHERE council <> 0 AND retired = 0 ORDER BY model`;
  return rows.map((row): CouncilMember => ({
    ...row,
    args: launchArguments({ kind: row.harness, model: row.model, thinking: row.thinking }),
  }));
}).pipe(Effect.mapError(registryError("reading the council")));

/** Turns a model's council switch on or off. The model must have a row. */
export const setCouncil = (model: string, on: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ model: string }>`
      UPDATE models SET council = ${on ? 1 : 0} WHERE model = ${model} RETURNING model`;
    if (rows.length === 0) {
      return yield* new RegistryError({
        detail: `model "${model}" has no row in the models table`,
      });
    }
  }).pipe(Effect.mapError(registryError("changing the council")));

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
    review: number;
    provider: string | null;
    unmetered: number;
    note: string | null;
  }>`SELECT rung, level, model, enabled, author, review, provider, unmetered, note
       FROM ladder ORDER BY level, rank`;
  return rows.map((row): LadderRow => ({
    ...row,
    enabled: row.enabled !== 0,
    author: row.author !== 0,
    review: row.review !== 0,
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
            sql`INSERT INTO ladder(rank, level, rung, model, enabled, author, review, provider, unmetered, note)
                VALUES (${index + 1}, ${row.level}, ${row.rung}, ${row.model}, ${row.enabled ? 1 : 0},
                        ${row.author ? 1 : 0}, ${row.review ? 1 : 0},
                        ${row.provider}, ${row.unmetered ? 1 : 0}, ${row.note})`,
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
    review: row.review,
    provider: row.provider ?? null,
    unmetered: row.unmetered,
    note: row.note ?? null,
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
    "// `author` / `review` say which roles the rung may fill (default both on).",
    "[",
    ...rows.map(
      (row) =>
        "  " +
        JSON.stringify({
          rung: row.rung,
          level: row.level,
          model: row.model,
          enabled: row.enabled,
          ...(row.author ? {} : { author: false }),
          ...(row.review ? {} : { review: false }),
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
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  author: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  review: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
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
