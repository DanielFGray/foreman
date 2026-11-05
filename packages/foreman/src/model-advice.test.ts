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
  ladderChoice,
  quotaStatusOf,
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
import {
  authorFor,
  floorFor,
  isEnabled,
  isMetered,
  type Ladder,
  type LastStarts,
  mayAuthor,
  providerOf,
  providersOf,
  rungsOn,
} from "./ladder.ts";
import { Quota, QuotaError, type Usage, walledSeats } from "./quota.ts";
import { RegistryError } from "./registry.ts";
import { seed } from "./scratch-store.ts";
import { connectionAt, Runs } from "tasks";
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
  rank: partial.rank ?? 1,
  level: partial.level ?? partial.rank ?? 1,
  author: partial.author ?? true,
  modelsDev: partial.modelsDev ?? Option.none(),
  enabled: partial.enabled ?? true,
  retired: partial.retired ?? false,
  unmetered: partial.unmetered ?? false,
  ...partial,
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

describe("billingOf", () => {
  test("catalog rates do not make billing list-price", () => {
    expect(billingOf(Option.some("opencode"))).toBe("unknown");
    expect(billingOf(Option.some("cursor"))).toBe("subscription");
  });
});

/** The registry rows a ladder's rungs read as, for `advise`. */
const rowsOf = (ladder: Ladder): ReadonlyArray<RawCandidate> =>
  ladder.map((rung, rank) =>
    row({
      rung: rung.name,
      model: rung.model ?? rung.name,
      rank,
      level: rung.level,
      account: Option.fromNullishOr(providerOf(rung)),
      enabled: isEnabled(rung),
      author: mayAuthor(rung),
      unmetered: !isMetered(rung),
    }),
  );

const usage = (provider: string, used: number): Usage => ({
  provider,
  plan: "pro",
  allowances: [{ window: "weekly", usedPercent: used, resetsAt: new Date("2026-11-01T00:00:00Z") }],
});

/** What `foreman ladder suggest` recommends, from the inputs dispatch reads. */
const suggested = (
  ladder: Ladder,
  failures: ReadonlyArray<string>,
  readings: ReadonlyMap<string, Usage>,
  starts: LastStarts,
) => {
  const usageOf = (provider: string) => Option.fromNullishOr(readings.get(provider));
  return advise(
    rowsOf(ladder),
    { level: floorFor(ladder, failures), label: Option.fromNullishOr(failures[0]) },
    () => Option.none(),
    budget(),
    (account) =>
      quotaStatusOf(
        Option.map(Option.flatMap(account, usageOf), (found) => ({
          _tag: "usage" as const,
          usage: found,
        })),
      ),
    ladderChoice(ladder, failures, usageOf, starts),
  );
};

/** What dispatch would hand the task: the providers as the dispatcher builds them. */
const dispatched = (
  ladder: Ladder,
  failures: ReadonlyArray<string>,
  readings: ReadonlyMap<string, Usage>,
  starts: LastStarts,
) => {
  const providers = providersOf(ladder).flatMap((provider) => {
    const found = readings.get(provider);
    return found === undefined
      ? []
      : [{ ...found, rungs: rungsOn(ladder, provider), reviewers: [] }];
  });
  return authorFor(ladder, failures, walledSeats(providers).author, new Set(), starts);
};

describe("ladder suggest picks as dispatch does", () => {
  // Rank order and authorFor's order disagree at every step: an author-off rung
  // leads the bottom level, its two peers took turns in the wrong order for
  // rank, a metered rung sits on a spent account, and an unmetered rung on the
  // same account is not walled by it.
  const ladder: Ladder = [
    {
      name: "off",
      harness: "pi",
      provider: undefined,
      level: 1,
      model: "acct-a/m0",
      author: false,
    },
    { name: "peer-a", harness: "pi", provider: undefined, level: 1, model: "acct-a/m1" },
    { name: "peer-b", harness: "pi", provider: undefined, level: 1, model: "acct-a/m2" },
    { name: "spent", harness: "pi", provider: undefined, level: 2, model: "spent-acct/m3" },
    {
      name: "promo",
      harness: "pi",
      provider: undefined,
      level: 3,
      model: "spent-acct/m4",
      unmetered: true,
    },
    { name: "top", harness: "pi", provider: undefined, level: 4, model: "spent-acct/m5" },
  ];
  const readings = new Map([
    ["acct-a", usage("acct-a", 10)],
    ["spent-acct", usage("spent-acct", 100)],
  ]);
  const starts: LastStarts = new Map([
    ["peer-a", new Date("2026-10-02T00:00:00Z")],
    ["peer-b", new Date("2026-10-01T00:00:00Z")],
  ]);

  test.each([
    { failures: [], rung: "peer-b" },
    { failures: ["peer-a"], rung: "promo" },
  ])("after $failures it recommends $rung, the rung authorFor dispatches", ({ failures, rung }) => {
    const choice = dispatched(ladder, failures, readings, starts);
    expect(choice._tag === "Dispatch" ? choice.rung.name : choice._tag).toBe(rung);
    const report = suggested(ladder, failures, readings, starts);
    expect(Option.map(report.recommendation, (c) => c.rung)).toEqual(Option.some(rung));
  });

  test("lists the author-off rung and the walled rung apart from the pick", () => {
    const report = suggested(ladder, ["peer-a"], readings, starts);
    expect(report.exclusions).toContainEqual({ rung: "off", reason: "author off" });
    expect(report.exclusions).toContainEqual({ rung: "spent", reason: "account exhausted" });
    expect(report.exclusions).toContainEqual({
      rung: "peer-b",
      reason: "below escalation floor after peer-a",
    });
  });

  test("when every rung above the floor is walled it recommends nothing, as dispatch waits", () => {
    expect(dispatched(ladder, ["promo"], readings, starts)).toEqual({
      _tag: "Waiting",
      walled: ["top"],
    });
    const report = suggested(ladder, ["promo"], readings, starts);
    expect(report.recommendation).toEqual(Option.none());
    expect(report.selectionRule).toContain("spent account: top");
  });
});

describe("advise unmetered applicability", () => {
  test("a sponsored unmetered rung stays eligible when its account is exhausted", () => {
    const ladder: Ladder = [
      {
        name: "promo",
        harness: "opencode",
        level: 1,
        model: "opencode-go/ox-alpha-free",
        unmetered: true,
        provider: undefined,
      },
      { name: "metered", harness: "codex", level: 2, model: "gpt-6-luna", provider: "openai" },
    ];
    const report = suggested(
      ladder,
      [],
      new Map([
        ["opencode-go", usage("opencode-go", 100)],
        ["openai", usage("openai", 10)],
      ]),
      new Map(),
    );
    const promo = report.candidates.find((c) => c.rung === "promo");
    expect(promo?.eligibility).toBe("eligible");
    expect(promo?.quota._tag).toBe("exhausted");
    expect(Option.getOrNull(report.recommendation)?.rung).toBe("promo");
  });

  test("escalation floor after a rung excludes lower levels", () => {
    const ladder: Ladder = [
      { name: "a", harness: "codex", level: 1, model: "m1", provider: "openai" },
      { name: "b", harness: "codex", level: 2, model: "m2", provider: "openai" },
    ];
    const report = suggested(ladder, ["a"], new Map([["openai", usage("openai", 10)]]), new Map());
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

/** A scratch store seeded with richer registry rows than e2e/registry.sql: pool, models_dev, retired, runs. */
const seedAdviceRegistry = async (dir: string): Promise<string> => {
  const path = join(dir, "registry.db");
  await seed(`
    INSERT INTO pools(pool, harness, provider_default) VALUES
      ('OpenAI', 'codex', 'openai'), ('OpenCode Go', 'opencode', 'opencode-go'), ('Cursor', 'cursor', 'cursor');
    INSERT INTO models(model, provider, pool, harness, models_dev, limit_scope) VALUES
      ('gpt-6-luna', 'openai', 'OpenAI', 'codex', 'openai/gpt-6-luna', 'pool'),
      ('opencode-go/ox-alpha-free', 'opencode-go', 'OpenCode Go', 'opencode', 'opencode-go/ox-alpha-free', 'pool'),
      ('auto', 'cursor', 'Cursor', 'cursor', NULL, 'pool');
    INSERT INTO ladder(rank, level, rung, model, provider, unmetered, enabled) VALUES
      (1, 1, 'promo', 'opencode-go/ox-alpha-free', 'opencode-go', 1, 1),
      (2, 2, 'codex-luna', 'gpt-6-luna', 'openai', 0, 1),
      (3, 3, 'cursor-agent', 'auto', 'cursor', 0, 1);
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
    const storeLayer = Runs.layerAt(registry);

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
    const storeLayer = Runs.layerAt(registry);

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
    const storeLayer = Runs.layerAt(registry);

    // `--after promo` puts the floor above level 1, so codex-luna is the pick,
    // with room on openai.
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
