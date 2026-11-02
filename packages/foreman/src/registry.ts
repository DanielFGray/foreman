import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
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
 * Models themselves (harness, pool, thinking level) are rows the herd skill's
 * `schema-registry.sql` seeds. This module edits only the ladder, which is the
 * part an operator reorders, enables and disables.
 */

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** One ladder row as an operator edits it. Position in the list is the rank. */
export interface LadderRow {
  readonly rung: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly provider: string | null;
  readonly unmetered: boolean;
  readonly note: string | null;
}

/** The ladder, cheapest first, with each rung's launch settings from its model. */
export const readLadder = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rungs = yield* sql<{
    rung: string;
    model: string;
    enabled: number;
    provider: string | null;
    unmetered: number;
    harness: string;
    thinking: string;
  }>`SELECT l.rung, l.model, l.enabled, l.provider, l.unmetered, m.harness, m.thinking
       FROM ladder l JOIN models m USING (model)
      ORDER BY l.rank`;
  const [bottom, ...rest] = rungs.map((row): Rung => ({
    name: row.rung,
    harness: row.harness,
    model: row.model,
    provider: row.provider ?? undefined,
    enabled: row.enabled !== 0,
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
  readonly harness: string;
  readonly model: string;
  readonly thinking: string;
  /** `retired`, `disabled`, or the model's derived `proven` / `trial`. */
  readonly state: string;
  readonly slices: number;
  readonly succeeded: number;
  readonly avgRounds: number | null;
}

/** The ladder joined to `model_status`, for `foreman ladder` to print. */
export const readStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    rung: string;
    harness: string;
    model: string;
    thinking: string;
    enabled: number;
    retired: number;
    status: string;
    slices: number;
    succeeded: number;
    avg_rounds: number | null;
  }>`SELECT l.rung, s.harness, s.model, s.thinking, l.enabled, s.retired, s.status,
            s.slices, s.succeeded, s.avg_rounds
       FROM ladder l JOIN model_status s USING (model) ORDER BY l.rank`;
  return rows.map((row): RungStatus => ({
    rung: row.rung,
    harness: row.harness,
    model: row.model,
    thinking: row.thinking,
    state: row.retired ? "retired" : row.enabled ? row.status : "disabled",
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
    model: string;
    enabled: number;
    provider: string | null;
    unmetered: number;
    note: string | null;
  }>`SELECT rung, model, enabled, provider, unmetered, note FROM ladder ORDER BY rank`;
  return rows.map((row): LadderRow => ({
    ...row,
    enabled: row.enabled !== 0,
    unmetered: row.unmetered !== 0,
  }));
}).pipe(Effect.mapError(registryError("reading the ladder rows")));

/**
 * Replaces the ladder with these rows, in this order.
 *
 * Rung names are the identity tasks record, so a rename is a different rung and
 * the tasks that recorded the old name stop positioning anything; ranks are
 * only the order and are rewritten from the list. Everything is validated
 * before anything is written, and the write is one transaction, so a bad edit
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
      ...(rows.some((row) => row.enabled) ? [] : ["every rung is disabled"]),
    ];
    if (problems.length > 0) return yield* new RegistryError({ detail: problems.join("; ") });

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM ladder`;
        yield* Effect.forEach(
          rows,
          (row, index) =>
            sql`INSERT INTO ladder(rank, rung, model, enabled, provider, unmetered, note)
                VALUES (${index + 1}, ${row.rung}, ${row.model}, ${row.enabled ? 1 : 0},
                        ${row.provider}, ${row.unmetered ? 1 : 0}, ${row.note})`,
          { discard: true },
        );
      }),
    );
  }).pipe(Effect.mapError(registryError("writing the ladder")));

/** Parses the editor's text: a JSONC array of rows, with comments allowed. */
export const parseRows = (text: string): ReadonlyArray<LadderRow> => {
  const raw: unknown = Bun.JSONC.parse(text);
  return Schema.decodeUnknownSync(Schema.Array(RowFile))(raw).map((row) => ({
    rung: row.rung,
    model: row.model,
    enabled: row.enabled,
    provider: row.provider ?? null,
    unmetered: row.unmetered,
    note: row.note ?? null,
  }));
};

/** The editor's text: one object per rung, so a reorder is moving a block. */
export const renderRows = (rows: ReadonlyArray<LadderRow>): string =>
  [
    "// The ladder, cheapest first. Order is the rank; move a block to re-rank it.",
    "// A rung's name is what tasks record: renaming one makes a new rung.",
    "// `model` must already have a row in the registry's models table.",
    "[",
    ...rows.map(
      (row) =>
        "  " +
        JSON.stringify({
          rung: row.rung,
          model: row.model,
          enabled: row.enabled,
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
  model: Schema.NonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
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
