/**
 * models.dev catalog load and exact-identity rate lookup for ladder suggest.
 *
 * Identity is the registry's `models.models_dev` value (`provider/bare`), never
 * a guessed alias. Missing cost stays missing. Context tiers apply only when
 * the request context size is known; otherwise base rates carry uncertainty and
 * are marked `quoteUnreliable`.
 */

import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, Layer, Option, Schema as S } from "effect";
import type { CatalogLookup, RateSheet } from "./model-advice.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";

const RateFields = S.Struct({
  input: S.optional(S.NullOr(S.Number)),
  output: S.optional(S.NullOr(S.Number)),
  cache_read: S.optional(S.NullOr(S.Number)),
  cache_write: S.optional(S.NullOr(S.Number)),
});

const ContextTier = S.Struct({
  input: S.optional(S.NullOr(S.Number)),
  output: S.optional(S.NullOr(S.Number)),
  cache_read: S.optional(S.NullOr(S.Number)),
  cache_write: S.optional(S.NullOr(S.Number)),
  tier: S.Struct({
    type: S.String,
    size: S.Number,
  }),
});

const ModelCost = S.Struct({
  input: S.optional(S.NullOr(S.Number)),
  output: S.optional(S.NullOr(S.Number)),
  cache_read: S.optional(S.NullOr(S.Number)),
  cache_write: S.optional(S.NullOr(S.Number)),
  tiers: S.optional(S.Array(ContextTier)),
  context_over_200k: S.optional(S.NullOr(RateFields)),
});

const ModelEntry = S.Struct({
  cost: S.optional(S.NullOr(ModelCost)),
});

const ProviderEntry = S.Struct({
  models: S.optional(S.Record(S.String, ModelEntry)),
});

const CatalogSchema = S.Record(S.String, ProviderEntry);

export type Catalog = S.Schema.Type<typeof CatalogSchema>;

export class CatalogError extends S.TaggedError<CatalogError>()("CatalogError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

export const LoadedCatalog = S.Struct({
  catalog: CatalogSchema,
  source: S.String,
  fetchedAt: S.Date,
  ageSeconds: S.Number,
});
export type LoadedCatalog = S.Schema.Type<typeof LoadedCatalog>;

/** Load the catalog from a local JSON file or from models.dev over HTTP. */
export const loadCatalog = (
  localPath: Option.Option<string>,
): Effect.Effect<LoadedCatalog, CatalogError, HttpClient.HttpClient | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (Option.isSome(localPath)) {
      const path = Option.getOrThrow(localPath);
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs
        .readFileString(path)
        .pipe(
          Effect.mapError(
            (cause) => new CatalogError({ detail: `reading catalog ${path}: ${cause}` }),
          ),
        );
      const catalog = yield* S.decodeUnknownEffect(S.fromJsonString(CatalogSchema))(text).pipe(
        Effect.mapError(
          (cause) => new CatalogError({ detail: `decoding catalog ${path}: ${cause}` }),
        ),
      );
      const info = yield* fs
        .stat(path)
        .pipe(
          Effect.mapError(
            (cause) => new CatalogError({ detail: `stat catalog ${path}: ${cause}` }),
          ),
        );
      const mtime = Option.getOrElse(info.mtime, () => new Date(now));
      return {
        catalog,
        source: `file:${path}`,
        fetchedAt: mtime,
        ageSeconds: Math.max(0, Math.round((now - mtime.getTime()) / 1000)),
      };
    }

    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(MODELS_DEV_URL))
      .pipe(
        Effect.mapError(
          (cause) => new CatalogError({ detail: `fetching ${MODELS_DEV_URL}: ${cause}` }),
        ),
      );
    const body = yield* response.text.pipe(
      Effect.mapError(
        (cause) => new CatalogError({ detail: `reading ${MODELS_DEV_URL} body: ${cause}` }),
      ),
    );
    const catalog = yield* S.decodeUnknownEffect(S.fromJsonString(CatalogSchema))(body).pipe(
      Effect.mapError(
        (cause) => new CatalogError({ detail: `decoding models.dev catalog: ${cause}` }),
      ),
    );
    return {
      catalog,
      source: MODELS_DEV_URL,
      fetchedAt: new Date(now),
      ageSeconds: 0,
    };
  });

export const catalogLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

/**
 * Exact identity lookup. When context tiers exist and context is unknown, base
 * rates are returned with `quoteUnreliable: true`, so the report does not show
 * them as a firm quote.
 */
export const lookupRates = (
  catalog: Catalog,
  modelsDev: Option.Option<string>,
  contextTokens: Option.Option<number>,
): Option.Option<CatalogLookup> => {
  if (Option.isNone(modelsDev)) return Option.none();
  const identity = Option.getOrThrow(modelsDev);
  const slash = identity.indexOf("/");
  if (slash <= 0 || slash === identity.length - 1) return Option.none();
  const provider = identity.slice(0, slash);
  const bare = identity.slice(slash + 1);
  const entry = catalog[provider]?.models?.[bare];
  if (entry === undefined || entry.cost === undefined || entry.cost === null) {
    return Option.none();
  }

  const cost = entry.cost;
  const assumptions: string[] = [];
  const uncertainty: string[] = [];
  const basis: string[] = [`identity ${identity}`];
  const base = sheetOf(cost);
  const tiers = (cost.tiers ?? []).filter((tier) => tier.tier.type === "context");
  const legacy = cost.context_over_200k;

  if (tiers.length === 0 && (legacy === undefined || legacy === null)) {
    return Option.some({
      rates: base,
      assumptions,
      uncertainty,
      basis,
      quoteUnreliable: false,
    });
  }

  if (Option.isNone(contextTokens)) {
    uncertainty.push(
      "catalog has context-dependent price tiers; request context not given — base rates are not a firm quote",
    );
    return Option.some({
      rates: base,
      assumptions,
      uncertainty,
      basis,
      quoteUnreliable: true,
    });
  }

  return Option.flatMap(contextTokens, (tokens) => {
    const applied = tierFor(tokens, tiers, legacy);
    return Option.match(applied, {
      onNone: () => {
        basis.push(`context ${tokens} tokens → base rates`);
        return Option.some({
          rates: base,
          assumptions,
          uncertainty,
          basis,
          quoteUnreliable: false,
        });
      },
      onSome: (chosen) => {
        basis.push(chosen.label);
        return Option.some({
          rates: chosen.rates,
          assumptions,
          uncertainty,
          basis,
          quoteUnreliable: false,
        });
      },
    });
  });
};

const sheetOf = (cost: {
  readonly input?: number | null | undefined;
  readonly output?: number | null | undefined;
  readonly cache_read?: number | null | undefined;
  readonly cache_write?: number | null | undefined;
}): RateSheet => ({
  input: Option.fromNullishOr(cost.input ?? null),
  output: Option.fromNullishOr(cost.output ?? null),
  cacheRead: Option.fromNullishOr(cost.cache_read ?? null),
  cacheWrite: Option.fromNullishOr(cost.cache_write ?? null),
});

/**
 * Explicit `tiers` with type=context own every context size when present.
 * Legacy `context_over_200k` applies only when no explicit context tier exists.
 */
const tierFor = (
  contextTokens: number,
  tiers: ReadonlyArray<S.Schema.Type<typeof ContextTier>>,
  legacy: S.Schema.Type<typeof RateFields> | null | undefined,
): Option.Option<{ readonly rates: RateSheet; readonly label: string }> => {
  const contextTiers = [...tiers].sort((a, b) => a.tier.size - b.tier.size);

  if (contextTiers.length > 0) {
    const chosen = contextTiers.reduce<S.Schema.Type<typeof ContextTier> | undefined>(
      (acc, tier) => (contextTokens > tier.tier.size ? tier : acc),
      undefined,
    );
    return chosen === undefined
      ? Option.none()
      : Option.some({
          rates: sheetOf(chosen),
          label: `context ${contextTokens} tokens → tier above ${chosen.tier.size} ${chosen.tier.type}`,
        });
  }

  if (legacy !== undefined && legacy !== null && contextTokens > 200_000) {
    return Option.some({
      rates: sheetOf(legacy),
      label: `context ${contextTokens} tokens → context_over_200k rates`,
    });
  }

  return Option.none();
};
