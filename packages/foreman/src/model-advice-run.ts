/**
 * I/O for `foreman ladder suggest`: registry candidates, trial token medians,
 * live Quota readings, and catalog load. Pure ranking lives in model-advice.ts.
 */

import { Effect, Option, Schema as S } from "effect";
import { SqlClient } from "effect/sql";
import { Runs } from "tasks";
import { floorFor, isMetered, type Choice, type Ladder, providerOf, type Rung } from "./ladder.ts";
import {
  advise,
  adviceJson,
  adviceText,
  ladderChoice,
  medianOf,
  mergeBudget,
  quotaStatusOf,
  type AdviceReport,
  type EscalationFloor,
  type QuotaReading,
  type QuotaStatus,
  type RawCandidate,
  type TokenBudget,
  type TrialMedian,
} from "./model-advice.ts";
import { loadCatalog, lookupRates, type LoadedCatalog } from "./model-advice-catalog.ts";
import { Quota, type Usage } from "./quota.ts";
import { readLadder, registryError } from "./registry.ts";
import type { RegistryError } from "./registry.ts";

/** Non-negative integers for token/context CLI flags (rejects negatives). */
export const NonNegativeTokenCount = S.Number.check(
  S.isInt(),
  S.isGreaterThanOrEqualTo(0),
).annotate({
  message: "token and context counts must be non-negative integers",
});

export const SuggestOptions = S.Struct({
  json: S.Boolean,
  catalogPath: S.Option(S.String),
  after: S.Option(S.String),
  contextTokens: S.Option(NonNegativeTokenCount),
  inputTokens: S.Option(NonNegativeTokenCount),
  cacheReadTokens: S.Option(NonNegativeTokenCount),
  cacheWriteTokens: S.Option(NonNegativeTokenCount),
  outputTokens: S.Option(NonNegativeTokenCount),
  /** When set, median budget is taken only from trials with this size. */
  size: S.Option(S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(1)))),
});
export type SuggestOptions = S.Schema.Type<typeof SuggestOptions>;

export class SuggestError extends S.TaggedError<SuggestError>()("SuggestError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

const CandidateRow = S.Struct({
  rank: S.Number,
  level: S.Number,
  rung: S.String,
  model: S.String,
  enabled: S.BooleanFromBit,
  rung_provider: S.NullOr(S.String),
  pool: S.String,
  models_dev: S.NullOr(S.String),
  retired: S.BooleanFromBit,
  harness: S.String,
  unmetered: S.BooleanFromBit,
  author: S.BooleanFromBit,
});

const RunTokenRow = S.Struct({
  input_tokens: S.NullOr(S.Number),
  cache_read_tokens: S.NullOr(S.Number),
  cache_write_tokens: S.NullOr(S.Number),
  output_tokens: S.NullOr(S.Number),
});

/**
 * One-shot advice: catalog + quota + registry, no dispatch.
 * Decodes `unknown` once at this boundary (CLI already may have checked flags).
 */
export const runSuggest = (rawOptions: unknown) =>
  Effect.gen(function* () {
    const options = yield* S.decodeUnknownEffect(SuggestOptions)(rawOptions).pipe(
      Effect.mapError(
        (cause) =>
          new SuggestError({
            detail: `invalid suggest options: ${cause}`,
          }),
      ),
    );

    const rows = yield* readCandidates;
    const ladder = yield* readLadder;
    const floor = yield* resolveFloor(options.after, ladder);
    const runs = yield* Runs;
    const starts = yield* runs
      .lastStarts("author")
      .pipe(Effect.mapError(registryError("reading the rungs' last starts")));

    const byAccount = yield* readAccounts(
      rows.filter((row) => row.enabled && !row.retired && row.level >= floor.level),
    );
    const readingOf = (account: string) => Option.fromNullishOr(byAccount.get(account));

    const trials = yield* readTrialBudget(options.size);
    const budget = mergeBudget(trials, {
      input: options.inputTokens,
      cacheRead: options.cacheReadTokens,
      cacheWrite: options.cacheWriteTokens,
      output: options.outputTokens,
    });
    const loaded = yield* loadCatalog(options.catalogPath);

    const report = buildReport(
      rows,
      floor,
      options.contextTokens,
      budget,
      loaded,
      (account) => quotaStatusOf(Option.flatMap(account, readingOf)),
      ladderChoice(
        ladder,
        Option.toArray(floor.label),
        (provider) => usageIn(readingOf(provider)),
        starts,
      ),
    );

    return options.json ? adviceJson(report) : adviceText(report);
  });

/**
 * Validate `--after` once; an unknown rung is an error, never a silent floor.
 * The floor is the one a failure of that rung puts under a task (`floorFor`),
 * so its peers in the level fall below it too.
 */
export const resolveFloor = (
  after: Option.Option<string>,
  ladder: Ladder,
): Effect.Effect<EscalationFloor, SuggestError> =>
  Option.match(after, {
    onNone: () => Effect.succeed({ level: floorFor(ladder, []), label: Option.none() }),
    onSome: (name) =>
      ladder.some((rung) => rung.name === name)
        ? Effect.succeed({ level: floorFor(ladder, [name]), label: Option.some(name) })
        : Effect.fail(
            new SuggestError({
              detail: `no rung ${name} to escalate after; rungs: ${ladder.map((r) => r.name).join(", ")}`,
            }),
          ),
  });

export const buildReport = (
  rows: ReadonlyArray<RawCandidate>,
  floor: EscalationFloor,
  contextTokens: Option.Option<number>,
  budget: TokenBudget,
  loaded: LoadedCatalog,
  quotaOf: (account: Option.Option<string>) => QuotaStatus,
  choice: Choice,
): AdviceReport => {
  const report = advise(
    rows,
    floor,
    (modelsDev) => lookupRates(loaded.catalog, modelsDev, contextTokens),
    budget,
    quotaOf,
    choice,
  );
  return {
    ...report,
    catalog: {
      source: loaded.source,
      fetchedAt: Option.some(loaded.fetchedAt.toISOString()),
      ageSeconds: Option.some(loaded.ageSeconds),
    },
  };
};

/**
 * Reads the quota of each account the given rungs draw on. An account foreman
 * cannot read is carried as `unreadable`, which walls nothing, as in dispatch.
 */
const readAccounts = (rows: ReadonlyArray<RawCandidate>) =>
  Effect.gen(function* () {
    const quota = yield* Quota;
    const accounts = [...new Set(rows.flatMap((row) => Option.toArray(row.account)))];
    const readings = yield* Effect.forEach(
      accounts,
      (account) =>
        quota.usage(account).pipe(
          Effect.map((usage): readonly [string, QuotaReading] => [
            account,
            { _tag: "usage", usage },
          ]),
          Effect.catchTag("QuotaError", (error) =>
            Effect.succeed([account, { _tag: "unreadable", detail: error.detail }] as const),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return new Map<string, QuotaReading>(readings);
  });

const usageIn = (reading: Option.Option<QuotaReading>): Option.Option<Usage> =>
  Option.flatMap(reading, (found) =>
    found._tag === "usage" ? Option.some(found.usage) : Option.none(),
  );

/** Runs a query on the shared store and decodes its rows, naming the failing step. */
const rowsOf = <A, I>(
  schema: S.Codec<A, I>,
  step: string,
  query: Effect.Effect<ReadonlyArray<unknown>, unknown, never>,
): Effect.Effect<ReadonlyArray<A>, RegistryError> =>
  query.pipe(
    Effect.flatMap(S.decodeUnknownEffect(S.Array(schema))),
    Effect.mapError(registryError(step)),
  );

/** Ladder rows joined to model pool / models_dev / retirement / unmetered. */
export const readCandidates: Effect.Effect<
  ReadonlyArray<RawCandidate>,
  RegistryError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* rowsOf(
    CandidateRow,
    "reading the ladder candidates",
    sql`SELECT l.rank, l.level, l.rung, l.model, l.enabled, l.provider AS rung_provider,
              l.unmetered, l.author, m.pool, m.models_dev, m.retired, m.harness
         FROM ladder l JOIN models m USING (model)
        ORDER BY l.level, l.rank`,
  );
  return rows.map((row): RawCandidate => {
    const rung: Rung = {
      name: row.rung,
      harness: row.harness,
      level: row.level,
      model: row.model,
      provider: row.rung_provider ?? undefined,
      enabled: row.enabled,
      author: row.author,
      unmetered: row.unmetered,
    };
    return {
      rung: row.rung,
      model: row.model,
      pool: row.pool,
      account: Option.fromNullishOr(providerOf(rung)),
      rank: row.rank,
      level: row.level,
      modelsDev: Option.fromNullishOr(row.models_dev),
      enabled: row.enabled,
      author: row.author,
      retired: row.retired,
      unmetered: !isMetered(rung),
    };
  });
});

/**
 * Median four-part token budget from recorded trials. When `size` is set, only
 * trials with that size contribute; the basis string names the filter, that the
 * sample mixes models/outcomes (and sizes when unfiltered), and per-column n.
 */
export const readTrialBudget = (
  size: Option.Option<number>,
): Effect.Effect<Option.Option<TrialMedian>, RegistryError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const measured = sql.or([
      sql`input_tokens IS NOT NULL`,
      sql`cache_read_tokens IS NOT NULL`,
      sql`cache_write_tokens IS NOT NULL`,
      sql`output_tokens IS NOT NULL`,
    ]);
    const rows = yield* rowsOf(
      RunTokenRow,
      "reading the run token counts",
      Option.match(size, {
        onNone: () =>
          sql`SELECT input_tokens, cache_read_tokens, cache_write_tokens, output_tokens
                FROM runs WHERE ${measured}`,
        onSome: (n) =>
          sql`SELECT input_tokens, cache_read_tokens, cache_write_tokens, output_tokens
                FROM runs WHERE size = ${n} AND ${measured}`,
      }),
    );

    if (rows.length === 0) return Option.none();

    const inputs = rows.flatMap((r) => (r.input_tokens === null ? [] : [r.input_tokens]));
    const cacheReads = rows.flatMap((r) =>
      r.cache_read_tokens === null ? [] : [r.cache_read_tokens],
    );
    const cacheWrites = rows.flatMap((r) =>
      r.cache_write_tokens === null ? [] : [r.cache_write_tokens],
    );
    const outputs = rows.flatMap((r) => (r.output_tokens === null ? [] : [r.output_tokens]));
    const samples = {
      input: inputs.length,
      cacheRead: cacheReads.length,
      cacheWrite: cacheWrites.length,
      output: outputs.length,
    };
    const counts = `input n=${samples.input}, cache_read n=${samples.cacheRead}, cache_write n=${samples.cacheWrite}, output n=${samples.output}`;
    const basis = Option.match(size, {
      onNone: () => `median of measured trials mixing models, outcomes and sizes (${counts})`,
      onSome: (n) =>
        `median of measured trials with size=${n} mixing models and outcomes (${counts})`,
    });

    return Option.some({
      input: medianOf(inputs),
      cacheRead: medianOf(cacheReads),
      cacheWrite: medianOf(cacheWrites),
      output: medianOf(outputs),
      samples,
      basis,
      sized: Option.isSome(size),
    } satisfies TrialMedian);
  });
