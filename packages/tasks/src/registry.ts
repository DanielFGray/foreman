import { Effect, Schema as S } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export class ImportError extends S.TaggedError<ImportError>()("ImportError", {
  detail: S.String,
}) {}

/**
 * Copies the herd skill's `model-trials.db` into the store: every registry
 * table, `trials` as closed `runs`, and `defects`.
 *
 * Run ids are the trial ids, because each defect names its trial by id. The
 * copy is one transaction, and it refuses a store that already holds any of
 * these rows: run twice, or after foreman has recorded a run, it would mix two
 * histories. Answers the number of rows copied per table.
 */
export const importRegistry = (path: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const occupied = yield* Effect.forEach(TABLES, (table) =>
      sql<{ n: number }>`SELECT count(*) AS n FROM ${sql(table)}`.pipe(
        Effect.map((rows) => ((rows[0]?.n ?? 0) > 0 ? [table] : [])),
      ),
    );
    if (occupied.flat().length > 0) {
      return yield* new ImportError({
        detail: `the store already holds rows in ${occupied.flat().join(", ")}`,
      });
    }
    // ATTACH cannot run inside a transaction, so it brackets the one that copies.
    yield* sql`ATTACH DATABASE ${path} AS old`;
    return yield* sql
      .withTransaction(
        Effect.forEach(COPIES, ([table, statement]) =>
          sql.unsafe(statement).pipe(
            Effect.andThen(sql<{ n: number }>`SELECT changes() AS n`),
            Effect.map((rows) => [table, rows[0]?.n ?? 0] as const),
          ),
        ),
      )
      .pipe(
        Effect.map((counts) => Object.fromEntries(counts)),
        Effect.ensuring(sql`DETACH DATABASE old`.pipe(Effect.ignore)),
      );
  });

const TABLES = [
  "providers",
  "pools",
  "pool_aliases",
  "models",
  "aliases",
  "ladder",
  "prices",
  "runs",
  "defects",
] as const;

/** Parents before children, so every reference resolves as it is copied. */
const COPIES: ReadonlyArray<readonly [string, string]> = [
  [
    "providers",
    "INSERT INTO providers (provider, models_dev, note) SELECT provider, models_dev, note FROM old.providers",
  ],
  [
    "pools",
    "INSERT INTO pools (pool, harness, quota_cmd, provider_default, notes) SELECT pool, harness, quota_cmd, provider_default, notes FROM old.pools",
  ],
  [
    "pool_aliases",
    "INSERT INTO pool_aliases (alias, pool) SELECT alias, pool FROM old.pool_aliases",
  ],
  [
    "models",
    `INSERT INTO models (model, provider, pool, harness, models_dev, tier, limit_scope, thinking, retired, notes)
     SELECT model, provider, pool, harness, models_dev, tier, limit_scope, thinking, retired, notes FROM old.models`,
  ],
  ["aliases", "INSERT INTO aliases (alias, model) SELECT alias, model FROM old.aliases"],
  [
    "ladder",
    `INSERT INTO ladder (rank, rung, model, enabled, provider, note, unmetered)
     SELECT rank, rung, model, enabled, provider, note, unmetered FROM old.ladder`,
  ],
  [
    "prices",
    `INSERT INTO prices (model, source, input, output, cache_read, cache_write, fetched_at)
     SELECT model, source, input, output, cache_read, cache_write, fetched_at FROM old.prices`,
  ],
  [
    "runs",
    `INSERT INTO runs (id, closed_at, project, task, slice, kind, pool, model, work, outcome, rounds,
                       report_accurate, source, evidence, notes, session, active_minutes, input_tokens,
                       cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
                       actual_cost_usd, size)
     SELECT id, closed_at, project, task, slice, kind, pool, model, work, outcome, rounds,
            report_accurate, source, evidence, notes, session, active_minutes, input_tokens,
            cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
            actual_cost_usd, size
     FROM old.trials ORDER BY id`,
  ],
  [
    "defects",
    "INSERT INTO defects (run_id, kind, detail) SELECT trial_id, kind, detail FROM old.defects ORDER BY rowid",
  ],
];
