import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema as S } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdviceJsonReport,
  advise,
  billingOf,
  estimatePrice,
  medianOf,
  mergeBudget,
  pickRecommendation,
  quotaStatusOf,
  type AdviceCandidate,
  type QuotaStatus,
  type RawCandidate,
  type TokenBudget,
} from "./model-advice.ts";
import { catalogLayer, lookupRates, type Catalog } from "./model-advice-catalog.ts";
import {
  NonNegativeTokenCount,
  readCandidates,
  runSuggest,
  SuggestOptions,
} from "./model-advice-run.ts";
import { Quota, QuotaError, type Usage } from "./quota.ts";
import { RegistryError } from "./registry.ts";
import { seed } from "./scratch-store.ts";
import { connectionAt } from "tasks";
import { SqlClient } from "effect/sql";

const temps: string[] = [];
afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const scratchDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-advice-"));
  temps.push(dir);
  return dir;
};

const budget = (
  parts: Partial<{
    input: Option.Option<number>;
    cacheRead: Option.Option<number>;
    cacheWrite: Option.Option<number>;
    output: Option.Option<number>;
    samples: TokenBudget["samples"];
    source: TokenBudget["source"];
    basis: Option.Option<string>;
  }> = {},
): TokenBudget => ({
  input: Option.some(1_000_000),
  cacheRead: Option.some(2_000_000),
  cacheWrite: Option.some(100_000),
  output: Option.some(50_000),
  samples: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  source: "cli-override",
  basis: Option.none(),
  ...parts,
});

const row = (
  partial: Partial<RawCandidate> & Pick<RawCandidate, "rung" | "model">,
): RawCandidate => ({
  pool: partial.pool ?? "Test",
  account: partial.account ?? Option.none(),
  tier: partial.tier ?? "metered",
  rank: partial.rank ?? 1,
  modelsDev: partial.modelsDev ?? Option.none(),
  enabled: partial.enabled ?? true,
  retired: partial.retired ?? false,
  unmetered: partial.unmetered ?? false,
  ...partial,
});

const available = (used = 10): QuotaStatus => ({
  _tag: "available",
  plan: Option.some("pro"),
  allowances: [
    { window: "monthly", usedPercent: used, resetsAt: new Date("2026-11-01T00:00:00Z") },
  ],
});

const exhaustedMulti: QuotaStatus = {
  _tag: "exhausted",
  plan: Option.some("pro"),
  freeAt: Option.some(new Date("2026-11-01T00:00:00Z")),
  allowances: [
    { window: "hourly", usedPercent: 100, resetsAt: new Date("2026-10-26T19:00:00Z") },
    { window: "monthly", usedPercent: 100, resetsAt: new Date("2026-11-01T00:00:00Z") },
  ],
};

const rates = (input: number, output = input * 4) => ({
  input: Option.some(input),
  output: Option.some(output),
  cacheRead: Option.some(input / 10),
  cacheWrite: Option.some(input),
});

describe("estimatePrice", () => {
  test("prices the four token parts from rates per million", () => {
    const price = estimatePrice(budget(), rates(1, 4), Option.some("openai/gpt-test"));
    expect(Option.getOrNull(price.usd)).toBeCloseTo(1.5, 6);
  });

  test("absent rates leave the estimate unknown, never zero", () => {
    const price = estimatePrice(
      budget(),
      {
        input: Option.none(),
        output: Option.none(),
        cacheRead: Option.none(),
        cacheWrite: Option.none(),
      },
      Option.some("openai/gpt-test"),
    );
    expect(Option.isNone(price.usd)).toBe(true);
    expect(price.uncertainty.some((u) => u.includes("rate unknown"))).toBe(true);
  });

  test("missing cache_read rate stays unknown and is not filled from input", () => {
    const price = estimatePrice(
      budget({ cacheRead: Option.some(1_000_000) }),
      {
        input: Option.some(2),
        output: Option.some(8),
        cacheRead: Option.none(),
        cacheWrite: Option.some(2),
      },
      Option.some("prov/model"),
    );
    expect(Option.isNone(price.usd)).toBe(true);
    expect(price.uncertainty).toContain("cache_read rate unknown");
    expect(price.assumptions.some((a) => a.includes("input rate"))).toBe(false);
  });

  test("an all-zero token budget is not a free-model price", () => {
    const price = estimatePrice(
      budget({
        input: Option.some(0),
        cacheRead: Option.some(0),
        cacheWrite: Option.some(0),
        output: Option.some(0),
      }),
      rates(1),
      Option.some("openai/gpt-test"),
    );
    expect(Option.isNone(price.usd)).toBe(true);
    expect(price.uncertainty).toContain("zero token budget is not a model price");
  });
});

describe("mergeBudget", () => {
  test("CLI overrides win per part and mark the source", () => {
    const merged = mergeBudget(
      Option.some({
        input: Option.some(10),
        cacheRead: Option.some(20),
        cacheWrite: Option.some(30),
        output: Option.some(40),
        samples: { input: 5, cacheRead: 4, cacheWrite: 3, output: 5 },
        basis: "median of measured trials mixing models, outcomes and sizes",
        sized: false,
      }),
      {
        input: Option.some(99),
        cacheRead: Option.none(),
        cacheWrite: Option.none(),
        output: Option.none(),
      },
    );
    expect(Option.getOrNull(merged.input)).toBe(99);
    expect(Option.getOrNull(merged.cacheRead)).toBe(20);
    expect(merged.source).toBe("mixed");
    // Overrides do not pretend to use a trial sample.
    expect(merged.samples.input).toBe(0);
    expect(merged.samples.cacheRead).toBe(4);
  });

  test("no trials and no overrides stay absent, not zero", () => {
    const merged = mergeBudget(Option.none(), {
      input: Option.none(),
      cacheRead: Option.none(),
      cacheWrite: Option.none(),
      output: Option.none(),
    });
    expect(merged.source).toBe("absent");
    expect(Option.isNone(merged.input)).toBe(true);
  });
});

describe("quotaStatusOf", () => {
  test("unknown quota is not exhausted", () => {
    expect(quotaStatusOf(Option.none())._tag).toBe("unknown");
    expect(quotaStatusOf(Option.some({ _tag: "unreadable", detail: "down" }))._tag).toBe("unknown");
  });

  test("empty allowances are no-windows, not confirmed capacity", () => {
    expect(
      quotaStatusOf(
        Option.some({
          _tag: "usage",
          usage: { provider: "x", plan: "p", allowances: [] },
        }),
      ),
    ).toMatchObject({ _tag: "no-windows" });
  });

  test("exhausted multi-window pools carry every window", () => {
    const status = quotaStatusOf(
      Option.some({
        _tag: "usage",
        usage: {
          provider: "openai",
          plan: "pro",
          allowances: exhaustedMulti.allowances,
        },
      }),
    );
    expect(status._tag).toBe("exhausted");
    if (status._tag === "exhausted") {
      expect(status.allowances).toHaveLength(2);
    }
  });
});

describe("pickRecommendation and billing", () => {
  const candidate = (
    partial: Partial<AdviceCandidate> & Pick<AdviceCandidate, "rung" | "rank">,
  ): AdviceCandidate => ({
    model: partial.model ?? "m",
    pool: partial.pool ?? "P",
    account: partial.account ?? Option.none(),
    tier: partial.tier ?? "metered",
    unmetered: partial.unmetered ?? false,
    billing: partial.billing ?? "unknown",
    eligibility: partial.eligibility ?? "eligible",
    price: partial.price ?? {
      usd: Option.none(),
      rates: {
        input: Option.none(),
        output: Option.none(),
        cacheRead: Option.none(),
        cacheWrite: Option.none(),
      },
      identity: Option.none(),
      basis: [],
      assumptions: [],
      uncertainty: [],
      quoteUnreliable: false,
    },
    quota: partial.quota ?? { _tag: "unknown", detail: Option.none() },
    reasons: partial.reasons ?? [],
    ...partial,
  });

  test("catalog rates do not make billing list-price", () => {
    expect(billingOf(Option.some("opencode"))).toBe("unknown");
    expect(billingOf(Option.some("cursor"))).toBe("subscription");
  });

  test("prefers confirmed subscription capacity over a cheaper metered price", () => {
    const metered = candidate({
      rung: "cheap-api",
      rank: 1,
      billing: "unknown",
      price: {
        usd: Option.some(0.01),
        rates: rates(0.01),
        identity: Option.some("x/y"),
        basis: [],
        assumptions: [],
        uncertainty: [],
        quoteUnreliable: false,
      },
      quota: { _tag: "unknown", detail: Option.some("no zen usage") },
    });
    const sub = candidate({
      rung: "cursor-agent",
      rank: 5,
      billing: "subscription",
      account: Option.some("cursor"),
      quota: available(20),
    });
    const picked = pickRecommendation([metered, sub]);
    expect(Option.getOrNull(picked.candidate)?.rung).toBe("cursor-agent");
    expect(picked.rule).toContain("no incremental metered spend");
  });

  test("registry free tier leads subscription capacity by ladder order", () => {
    const free = candidate({
      rung: "flint-free",
      rank: 1,
      tier: "free",
      billing: "unknown",
      quota: { _tag: "unknown", detail: Option.some("no zen usage") },
    });
    const sub = candidate({
      rung: "cursor-agent",
      rank: 5,
      billing: "subscription",
      account: Option.some("cursor"),
      quota: available(20),
    });
    expect(Option.getOrNull(pickRecommendation([free, sub]).candidate)?.rung).toBe("flint-free");
  });

  test("Cursor Auto with known capacity is viable without a price", () => {
    const auto = candidate({
      rung: "cursor-agent",
      rank: 3,
      model: "auto",
      account: Option.some("cursor"),
      billing: "subscription",
      quota: available(5),
    });
    expect(Option.getOrNull(pickRecommendation([auto]).candidate)?.rung).toBe("cursor-agent");
  });

  test("unmetered with unknown billing is not treated as confirmed no-spend", () => {
    const sponsored = candidate({
      rung: "sponsored-unknown",
      rank: 1,
      unmetered: true,
      billing: "unknown",
      account: Option.some("openrouter"),
      quota: available(5),
      price: {
        usd: Option.some(0.5),
        rates: rates(0.5),
        identity: Option.some("openrouter/x"),
        basis: [],
        assumptions: [],
        uncertainty: [],
        quoteUnreliable: false,
      },
    });
    const meteredSub = candidate({
      rung: "cursor-agent",
      rank: 9,
      billing: "subscription",
      account: Option.some("cursor"),
      quota: available(20),
    });
    const picked = pickRecommendation([sponsored, meteredSub]);
    expect(Option.getOrNull(picked.candidate)?.rung).toBe("cursor-agent");
    expect(picked.rule).toContain("unmetered alone is not free");
  });

  test("unreliable context-tier quotes are not ranked as definite cheapest", () => {
    const unreliableCheap = candidate({
      rung: "tiered-cheap",
      rank: 2,
      billing: "unknown",
      price: {
        usd: Option.some(0.01),
        rates: rates(0.01),
        identity: Option.some("p/m"),
        basis: [],
        assumptions: [],
        uncertainty: ["catalog has context-dependent price tiers"],
        quoteUnreliable: true,
      },
    });
    const firmDear = candidate({
      rung: "firm",
      rank: 3,
      billing: "unknown",
      price: {
        usd: Option.some(1),
        rates: rates(1),
        identity: Option.some("p/n"),
        basis: [],
        assumptions: [],
        uncertainty: [],
        quoteUnreliable: false,
      },
    });
    expect(Option.getOrNull(pickRecommendation([unreliableCheap, firmDear]).candidate)?.rung).toBe(
      "firm",
    );
  });

  test("no eligible candidate yields no recommendation with an explicit rule", () => {
    const picked = pickRecommendation([
      candidate({ rung: "spent", rank: 1, eligibility: "exhausted", quota: exhaustedMulti }),
      candidate({ rung: "low", rank: 0, eligibility: "below-floor" }),
    ]);
    expect(Option.isNone(picked.candidate)).toBe(true);
    expect(picked.rule).toContain("no eligible");
  });
});

describe("advise unmetered applicability", () => {
  test("a sponsored unmetered rung stays eligible when its account is exhausted", () => {
    const rows = [
      row({
        rung: "promo",
        model: "opencode-go/ox-alpha-free",
        account: Option.some("opencode-go"),
        rank: 1,
        unmetered: true,
        modelsDev: Option.some("opencode-go/ox-alpha-free"),
        tier: "free",
      }),
      row({
        rung: "metered",
        model: "gpt-6-luna",
        account: Option.some("openai"),
        rank: 2,
        modelsDev: Option.some("openai/gpt-6-luna"),
      }),
    ];
    const report = advise(
      rows,
      { rank: 0, label: Option.none() },
      () =>
        Option.some({
          rates: rates(0),
          assumptions: [],
          uncertainty: [],
          basis: [],
          quoteUnreliable: false,
        }),
      budget(),
      (account) =>
        Option.match(account, {
          onNone: () => ({ _tag: "unknown" as const, detail: Option.none() }),
          onSome: (name) => (name === "opencode-go" ? exhaustedMulti : available()),
        }),
    );
    const promo = report.candidates.find((c) => c.rung === "promo");
    expect(promo?.eligibility).toBe("eligible");
    expect(promo?.quota._tag).toBe("exhausted");
    expect(promo?.reasons.some((r) => r.includes("unmetered does not mean free"))).toBe(false);
    expect(Option.getOrNull(report.recommendation)?.rung).toBe("promo");
  });

  test("unmetered unknown-billing candidate explains it cannot claim confirmed capacity", () => {
    const rows = [
      row({
        rung: "sponsored",
        model: "openrouter/x",
        account: Option.some("openrouter"),
        rank: 1,
        unmetered: true,
        modelsDev: Option.some("openrouter/x"),
        tier: "metered",
      }),
      row({
        rung: "cursor-agent",
        model: "auto",
        account: Option.some("cursor"),
        rank: 2,
        modelsDev: Option.none(),
      }),
    ];
    const report = advise(
      rows,
      { rank: 0, label: Option.none() },
      (id) =>
        Option.match(id, {
          onNone: () => Option.none(),
          onSome: () =>
            Option.some({
              rates: rates(1),
              assumptions: [],
              uncertainty: [],
              basis: [],
              quoteUnreliable: false,
            }),
        }),
      budget(),
      (account) =>
        Option.match(account, {
          onNone: () => ({ _tag: "unknown" as const, detail: Option.none() }),
          onSome: () => available(),
        }),
    );
    const sponsored = report.candidates.find((c) => c.rung === "sponsored");
    expect(sponsored?.billing).toBe("unknown");
    expect(sponsored?.reasons.some((r) => r.includes("unmetered does not mean free"))).toBe(true);
    expect(Option.getOrNull(report.recommendation)?.rung).toBe("cursor-agent");
  });

  test("escalation floor after a rung excludes lower ranks", () => {
    const rows = [
      row({
        rung: "a",
        model: "m1",
        rank: 1,
        account: Option.some("openai"),
        modelsDev: Option.some("openai/a"),
      }),
      row({
        rung: "b",
        model: "m2",
        rank: 2,
        account: Option.some("openai"),
        modelsDev: Option.some("openai/b"),
      }),
    ];
    const report = advise(
      rows,
      { rank: 2, label: Option.some("a") },
      () =>
        Option.some({
          rates: rates(1),
          assumptions: [],
          uncertainty: [],
          basis: [],
          quoteUnreliable: false,
        }),
      budget(),
      () => available(),
    );
    expect(report.candidates.find((c) => c.rung === "a")?.eligibility).toBe("below-floor");
    expect(Option.getOrNull(report.recommendation)?.rung).toBe("b");
  });
});

describe("lookupRates", () => {
  const tinyCatalog = {
    openai: {
      models: {
        "gpt-test": {
          cost: {
            input: 1,
            output: 4,
            cache_read: 0.1,
            tiers: [
              {
                input: 2,
                output: 8,
                cache_read: 0.2,
                tier: { type: "context", size: 32_000 },
              },
            ],
          },
        },
      },
    },
  } satisfies Catalog;

  test("applies the matching context tier when context is known", () => {
    const hit = lookupRates(tinyCatalog, Option.some("openai/gpt-test"), Option.some(40_000));
    expect(Option.getOrNull(Option.map(hit, (h) => Option.getOrNull(h.rates.input)))).toBe(2);
    expect(Option.getOrNull(hit)?.quoteUnreliable).toBe(false);
  });

  test("flags unreliable base rates when tiers exist but context is unknown", () => {
    const hit = lookupRates(tinyCatalog, Option.some("openai/gpt-test"), Option.none());
    expect(Option.getOrNull(hit)?.quoteUnreliable).toBe(true);
    expect(Option.getOrNull(hit)?.uncertainty.some((u) => u.includes("context-dependent"))).toBe(
      true,
    );
  });

  test.each([
    { name: "null legacy tier", cost: { input: 1, output: 4, context_over_200k: null } },
    {
      name: "non-context tier",
      cost: {
        input: 1,
        output: 4,
        tiers: [{ input: 2, output: 8, tier: { type: "batch", size: 1000 } }],
      },
    },
  ])("flat context pricing stays reliable with $name", ({ cost }) => {
    const catalog = { provider: { models: { model: { cost } } } } satisfies Catalog;
    const quote = lookupRates(catalog, Option.some("provider/model"), Option.none());
    expect(
      Option.map(quote, ({ rates, quoteUnreliable, uncertainty }) => ({
        input: rates.input,
        quoteUnreliable,
        uncertainty,
      })),
    ).toEqual(Option.some({ input: Option.some(1), quoteUnreliable: false, uncertainty: [] }));
  });

  test("null identity or missing catalog entry yields none, not free", () => {
    expect(Option.isNone(lookupRates(tinyCatalog, Option.none(), Option.none()))).toBe(true);
    expect(
      Option.isNone(lookupRates(tinyCatalog, Option.some("openai/missing"), Option.none())),
    ).toBe(true);
  });

  /**
   * Live catalog probe (edenai/openai/gpt-6-luna shape): explicit context tier
   * at >272000 with input .2, plus legacy context_over_200k=.2 and base .1.
   * Explicit tiers own every context size; legacy applies only when none exist.
   */
  const lunaWithBoth = {
    openai: {
      models: {
        "gpt-6-luna": {
          cost: {
            input: 0.1,
            output: 0.4,
            cache_read: 0.01,
            cache_write: 0.125,
            context_over_200k: {
              input: 0.2,
              output: 0.8,
              cache_read: 0.02,
              cache_write: 0.25,
            },
            tiers: [
              {
                input: 0.2,
                output: 0.8,
                cache_read: 0.02,
                cache_write: 0.25,
                tier: { type: "context", size: 272_000 },
              },
            ],
          },
        },
      },
    },
  } satisfies Catalog;

  test("explicit context tiers beat legacy context_over_200k below and at threshold", () => {
    const below = lookupRates(lunaWithBoth, Option.some("openai/gpt-6-luna"), Option.some(230_000));
    const at = lookupRates(lunaWithBoth, Option.some("openai/gpt-6-luna"), Option.some(272_000));
    expect(Option.getOrNull(Option.flatMap(below, (h) => h.rates.input))).toBe(0.1);
    expect(Option.getOrNull(Option.flatMap(at, (h) => h.rates.input))).toBe(0.1);
    expect(Option.getOrNull(below)?.basis.some((b) => b.includes("base rates"))).toBe(true);
  });

  test("explicit context tier applies strictly above its threshold", () => {
    const above = lookupRates(lunaWithBoth, Option.some("openai/gpt-6-luna"), Option.some(272_001));
    expect(Option.getOrNull(Option.flatMap(above, (h) => h.rates.input))).toBe(0.2);
    expect(Option.getOrNull(above)?.basis.some((b) => b.includes("tier above 272000"))).toBe(true);
  });

  test("legacy context_over_200k applies only when no explicit context tier exists", () => {
    const legacyOnly = {
      openai: {
        models: {
          "legacy-model": {
            cost: {
              input: 0.1,
              output: 0.4,
              context_over_200k: { input: 0.2, output: 0.8 },
            },
          },
        },
      },
    } satisfies Catalog;
    const under = lookupRates(legacyOnly, Option.some("openai/legacy-model"), Option.some(199_999));
    const over = lookupRates(legacyOnly, Option.some("openai/legacy-model"), Option.some(200_001));
    expect(Option.getOrNull(Option.flatMap(under, (h) => h.rates.input))).toBe(0.1);
    expect(Option.getOrNull(Option.flatMap(over, (h) => h.rates.input))).toBe(0.2);
  });
});

describe("option schemas reject negatives", () => {
  test("NonNegativeTokenCount rejects negative integers", () => {
    const result = S.decodeUnknownResult(NonNegativeTokenCount)(-1);
    expect(result._tag).toBe("Failure");
  });

  test("SuggestOptions rejects a negative context token count", () => {
    const result = S.decodeUnknownResult(SuggestOptions)({
      json: false,
      catalogPath: Option.none(),
      after: Option.none(),
      contextTokens: Option.some(-5),
      inputTokens: Option.none(),
      cacheReadTokens: Option.none(),
      cacheWriteTokens: Option.none(),
      outputTokens: Option.none(),
      size: Option.none(),
    });
    expect(result._tag).toBe("Failure");
  });
});

describe("medianOf", () => {
  test("returns none for an empty sample", () => {
    expect(Option.isNone(medianOf([]))).toBe(true);
  });

  test("averages the middle pair for an even count", () => {
    expect(Option.getOrNull(medianOf([1, 3, 5, 7]))).toBe(4);
  });
});

/** A scratch store seeded with richer registry rows than e2e/registry.sql: pool, models_dev, tier, retired, runs. */
const seedAdviceRegistry = async (dir: string): Promise<string> => {
  const path = join(dir, "registry.db");
  await seed(`
    INSERT INTO pools(pool, harness, provider_default) VALUES
      ('OpenAI', 'codex', 'openai'), ('OpenCode Go', 'opencode', 'opencode-go'), ('Cursor', 'cursor', 'cursor');
    INSERT INTO models(model, provider, pool, harness, models_dev, tier, limit_scope) VALUES
      ('gpt-6-luna', 'openai', 'OpenAI', 'codex', 'openai/gpt-6-luna', 'metered', 'pool'),
      ('opencode-go/ox-alpha-free', 'opencode-go', 'OpenCode Go', 'opencode', 'opencode-go/ox-alpha-free', 'free', 'pool'),
      ('auto', 'cursor', 'Cursor', 'cursor', NULL, 'metered', 'pool');
    INSERT INTO ladder(rank, rung, model, provider, unmetered, enabled) VALUES
      (1, 'promo', 'opencode-go/ox-alpha-free', 'opencode-go', 1, 1),
      (2, 'codex-luna', 'gpt-6-luna', 'openai', 0, 1),
      (3, 'cursor-agent', 'auto', 'cursor', 0, 1);
    INSERT INTO runs(project, task, slice, kind, pool, model, work, outcome,
                     input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, size)
    VALUES
      ('foreman', 't1', 's1', 'author', 'OpenAI', 'gpt-6-luna', 'build', 'committed',
       1000, 2000, 100, 50, 2),
      ('foreman', 't2', 's2', 'author', 'OpenAI', 'gpt-6-luna', 'build', 'committed',
       3000, 4000, 200, 100, 2),
      -- Partial measurement: input+output only, so per-part sample counts diverge.
      ('foreman', 't2b', 's2b', 'author', 'OpenAI', 'gpt-6-luna', 'build', 'dropped',
       5000, NULL, NULL, 80, 2),
      ('foreman', 't3', 's3', 'author', 'OpenAI', 'gpt-6-luna', 'build', 'committed',
       9000, 9000, 900, 900, 1);
  `).pipe(Effect.provide(connectionAt(path)), Effect.runPromise);
  return path;
};

const writeCatalog = (dir: string): string => {
  const path = join(dir, "api.json");
  writeFileSync(
    path,
    JSON.stringify({
      openai: {
        models: {
          "gpt-6-luna": {
            cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
          },
        },
      },
      "opencode-go": {
        models: {
          "ox-alpha-free": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
        },
      },
    }),
  );
  return path;
};

const quotaLayerFor = (readings: ReadonlyMap<string, Usage>): Layer.Layer<Quota> =>
  Layer.succeed(Quota, {
    usage: (provider: string) => {
      const usage = readings.get(provider);
      if (usage === undefined) {
        return Effect.fail(
          new QuotaError({
            provider,
            detail: `no fixture for ${provider}`,
            permanent: true,
          }),
        );
      }
      return Effect.succeed(usage);
    },
  });

describe("runSuggest I/O boundary", () => {
  test("spent pool does not exclude an unmetered sponsored rung; JSON decodes", async () => {
    const dir = scratchDir();
    const registry = await seedAdviceRegistry(dir);
    const catalog = writeCatalog(dir);
    const storeLayer = connectionAt(registry);

    const room = (provider: string, used: number): Usage => ({
      provider,
      plan: "plus",
      allowances: [
        { window: "weekly", usedPercent: used, resetsAt: new Date("2026-11-01T00:00:00Z") },
      ],
    });
    const spent = new Map<string, Usage>([
      [
        "opencode-go",
        {
          provider: "opencode-go",
          plan: "go",
          allowances: [
            { window: "weekly", usedPercent: 100, resetsAt: new Date("2026-11-01T00:00:00Z") },
          ],
        },
      ],
      ["openai", room("openai", 10)],
      ["cursor", room("cursor", 5)],
    ]);

    const text = await Effect.runPromise(
      runSuggest({
        json: true,
        catalogPath: Option.some(catalog),
        after: Option.none(),
        contextTokens: Option.none(),
        inputTokens: Option.some(1000),
        cacheReadTokens: Option.some(0),
        cacheWriteTokens: Option.some(0),
        outputTokens: Option.some(50),
        size: Option.some(2),
      }).pipe(Effect.provide(Layer.mergeAll(quotaLayerFor(spent), catalogLayer, storeLayer))),
    );

    const decoded = S.decodeUnknownSync(S.fromJsonString(AdviceJsonReport))(text);
    expect(decoded.recommendation?.rung).toBe("promo");
    expect(decoded.recommendation?.unmetered).toBe(true);
    expect(decoded.recommendation?.eligibility).toBe("eligible");
    expect(decoded.recommendation?.quota.status).toBe("exhausted");
    // Account is opencode-go (subscription probe target); catalog rates do not change that.
    expect(decoded.recommendation?.billing).toBe("subscription");
    expect(decoded.budget.source).toBe("mixed");
    expect(decoded.budget.basis).toContain("size=2");
    expect(decoded.budget.basis).toContain("mixing models and outcomes");
    // Per-part samples: three size=2 rows have input/output; only two have cache parts.
    // CLI overrides zero the sample counts for overridden parts.
    expect(decoded.budget.samples.input).toBe(0); // CLI override
    expect(decoded.budget.samples.cacheRead).toBe(0); // CLI override
    expect(decoded.budget.samples.cacheWrite).toBe(0); // CLI override
    expect(decoded.budget.samples.output).toBe(0); // CLI override
    expect(decoded.selectionRule.length).toBeGreaterThan(0);
    expect(
      decoded.exclusions.every((e) => !(e.rung === "promo" && e.reason === "account exhausted")),
    ).toBe(true);
  });

  test("partially measured trials report per-part sample counts, not one shared n", async () => {
    const dir = scratchDir();
    const registry = await seedAdviceRegistry(dir);
    const catalog = writeCatalog(dir);
    const storeLayer = connectionAt(registry);

    const text = await Effect.runPromise(
      runSuggest({
        json: true,
        catalogPath: Option.some(catalog),
        after: Option.none(),
        contextTokens: Option.none(),
        inputTokens: Option.none(),
        cacheReadTokens: Option.none(),
        cacheWriteTokens: Option.none(),
        outputTokens: Option.none(),
        size: Option.some(2),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            quotaLayerFor(
              new Map([
                [
                  "opencode-go",
                  {
                    provider: "opencode-go",
                    plan: "go",
                    allowances: [
                      {
                        window: "weekly",
                        usedPercent: 10,
                        resetsAt: new Date("2026-11-01T00:00:00Z"),
                      },
                    ],
                  },
                ],
                [
                  "openai",
                  {
                    provider: "openai",
                    plan: "plus",
                    allowances: [
                      {
                        window: "weekly",
                        usedPercent: 10,
                        resetsAt: new Date("2026-11-01T00:00:00Z"),
                      },
                    ],
                  },
                ],
                [
                  "cursor",
                  {
                    provider: "cursor",
                    plan: "pro",
                    allowances: [
                      {
                        window: "weekly",
                        usedPercent: 10,
                        resetsAt: new Date("2026-11-01T00:00:00Z"),
                      },
                    ],
                  },
                ],
              ]),
            ),
            catalogLayer,
            storeLayer,
          ),
        ),
      ),
    );

    const decoded = S.decodeUnknownSync(S.fromJsonString(AdviceJsonReport))(text);
    expect(decoded.budget.source).toBe("trials-median-size");
    expect(decoded.budget.samples.input).toBe(3);
    expect(decoded.budget.samples.cacheRead).toBe(2);
    expect(decoded.budget.samples.cacheWrite).toBe(2);
    expect(decoded.budget.samples.output).toBe(3);
    expect(decoded.budget.basis).toContain("input n=3");
    expect(decoded.budget.basis).toContain("cache_read n=2");
  });

  test("missing ladder table yields a typed RegistryError, not an Effect defect", async () => {
    const dir = scratchDir();
    const path = join(dir, "broken.db");
    const broken = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE ladder`;
      return yield* Effect.result(readCandidates);
    }).pipe(Effect.provide(connectionAt(path)));

    const result = await Effect.runPromise(broken);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(RegistryError);
      expect(result.failure.detail).toContain("reading the ladder candidates");
    }
  });

  test("missing cache_read rate in catalog yields unknown price through runSuggest", async () => {
    const dir = scratchDir();
    const registry = await seedAdviceRegistry(dir);
    const catalogPath = join(dir, "api.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        openai: {
          models: {
            "gpt-6-luna": { cost: { input: 0.1, output: 0.5, cache_write: 0.125 } },
          },
        },
        "opencode-go": {
          models: { "ox-alpha-free": { cost: { input: 0, output: 0 } } },
        },
      }),
    );
    const storeLayer = connectionAt(registry);

    // Force recommendation onto codex-luna by disabling free promo via after floor past promo
    // and spending nothing on openai.
    const text = await Effect.runPromise(
      runSuggest({
        json: true,
        catalogPath: Option.some(catalogPath),
        after: Option.some("promo"),
        contextTokens: Option.none(),
        inputTokens: Option.some(1000),
        cacheReadTokens: Option.some(2000),
        cacheWriteTokens: Option.some(100),
        outputTokens: Option.some(50),
        size: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            quotaLayerFor(
              new Map([
                [
                  "openai",
                  {
                    provider: "openai",
                    plan: "plus",
                    allowances: [
                      {
                        window: "weekly",
                        usedPercent: 1,
                        resetsAt: new Date("2026-11-01T00:00:00Z"),
                      },
                    ],
                  },
                ],
                [
                  "cursor",
                  {
                    provider: "cursor",
                    plan: "pro",
                    allowances: [
                      {
                        window: "weekly",
                        usedPercent: 1,
                        resetsAt: new Date("2026-11-01T00:00:00Z"),
                      },
                    ],
                  },
                ],
              ]),
            ),
            catalogLayer,
            storeLayer,
          ),
        ),
      ),
    );

    const decoded = S.decodeUnknownSync(S.fromJsonString(AdviceJsonReport))(text);
    const luna = decoded.candidates.find((c) => c.rung === "codex-luna");
    expect(luna).toBeDefined();
    expect(luna?.price.usd).toBeNull();
    expect(luna?.price.uncertainty.some((u) => u.includes("cache_read rate unknown"))).toBe(true);
  });
});
