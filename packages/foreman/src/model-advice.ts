/**
 * Read-only worker-model advice, never a second dispatcher: the pick is
 * `authorFor`'s, from the inputs dispatch reads (`ladderChoice`). List-price
 * estimates and observed quota are shown beside each rung as information, so
 * the ladder, current room and catalog prices are inspectable together.
 */

import { Match, Option, Schema as S } from "effect";
import {
  authorFor,
  type Choice,
  type Ladder,
  type LastStarts,
  providersOf,
  rungsOn,
} from "./ladder.ts";
import type { Allowance, Usage } from "./quota.ts";
import { exhausted, freeAt, walledSeats } from "./quota.ts";

/** USD per million tokens. Absence means the catalog states no rate. */
export const RateSheet = S.Struct({
  input: S.Option(S.Number),
  output: S.Option(S.Number),
  cacheRead: S.Option(S.Number),
  cacheWrite: S.Option(S.Number),
});
export type RateSheet = S.Schema.Type<typeof RateSheet>;

export const BudgetSource = S.Literals([
  "trials-median",
  "trials-median-size",
  "cli-override",
  "mixed",
  "absent",
]);
export type BudgetSource = S.Schema.Type<typeof BudgetSource>;

/** How many trial rows contributed a non-null value to each token column. */
export const SampleCounts = S.Struct({
  input: S.Number,
  cacheRead: S.Number,
  cacheWrite: S.Number,
  output: S.Number,
});
export type SampleCounts = S.Schema.Type<typeof SampleCounts>;

/** Four-part token budget. Missing parts stay Option.none, never silent zero. */
export const TokenBudget = S.Struct({
  input: S.Option(S.Number),
  cacheRead: S.Option(S.Number),
  cacheWrite: S.Option(S.Number),
  output: S.Option(S.Number),
  samples: SampleCounts,
  source: BudgetSource,
  /** How the historical sample was chosen, when trials contributed. */
  basis: S.Option(S.String),
});
export type TokenBudget = S.Schema.Type<typeof TokenBudget>;

const zeroSamples = (): SampleCounts => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
});

/** Account billing kind — never inferred from catalog list prices. */
export const BillingKind = S.Literals(["subscription", "unknown"]);
export type BillingKind = S.Schema.Type<typeof BillingKind>;

const AllowanceReading = S.Struct({
  window: S.String,
  usedPercent: S.Number,
  resetsAt: S.UndefinedOr(S.Date),
});

export const QuotaStatus = S.Union([
  S.TaggedStruct("available", {
    plan: S.Option(S.String),
    allowances: S.Array(AllowanceReading),
  }),
  S.TaggedStruct("exhausted", {
    plan: S.Option(S.String),
    allowances: S.Array(AllowanceReading),
    freeAt: S.Option(S.Date),
  }),
  S.TaggedStruct("no-windows", { plan: S.Option(S.String) }),
  S.TaggedStruct("unknown", { detail: S.Option(S.String) }),
]);
export type QuotaStatus = S.Schema.Type<typeof QuotaStatus>;

export const Eligibility = S.Literals(["eligible", "exhausted", "below-floor"]);
export type Eligibility = S.Schema.Type<typeof Eligibility>;

export const PriceEstimate = S.Struct({
  usd: S.Option(S.Number),
  rates: RateSheet,
  identity: S.Option(S.String),
  basis: S.Array(S.String),
  assumptions: S.Array(S.String),
  uncertainty: S.Array(S.String),
  /** True when context tiers exist but context was not given — not a firm quote. */
  quoteUnreliable: S.Boolean,
});
export type PriceEstimate = S.Schema.Type<typeof PriceEstimate>;

export const AdviceCandidate = S.Struct({
  rung: S.String,
  model: S.String,
  pool: S.String,
  account: S.Option(S.String),
  rank: S.Number,
  unmetered: S.Boolean,
  billing: BillingKind,
  eligibility: Eligibility,
  price: PriceEstimate,
  /** Account observation — shown even when allowance does not apply. */
  quota: QuotaStatus,
  reasons: S.Array(S.String),
});
export type AdviceCandidate = S.Schema.Type<typeof AdviceCandidate>;

export const AdviceReport = S.Struct({
  catalog: S.Struct({
    source: S.String,
    fetchedAt: S.Option(S.String),
    ageSeconds: S.Option(S.Number),
  }),
  budget: TokenBudget,
  recommendation: S.Option(AdviceCandidate),
  /** Why the picker chose this candidate (or none). */
  selectionRule: S.String,
  candidates: S.Array(AdviceCandidate),
  exclusions: S.Array(S.Struct({ rung: S.String, reason: S.String })),
});
export type AdviceReport = S.Schema.Type<typeof AdviceReport>;

/**
 * Accounts that Quota probes as subscription plans. An account joins this set
 * only through that probe, and catalog list prices do not add one.
 */
const SUBSCRIPTION_ACCOUNTS = new Set(["claude", "anthropic", "openai", "cursor", "opencode-go"]);

export const billingOf = (account: Option.Option<string>): BillingKind =>
  Option.match(account, {
    onNone: () => "unknown" as const,
    onSome: (name) =>
      SUBSCRIPTION_ACCOUNTS.has(name) ? ("subscription" as const) : ("unknown" as const),
  });

/** One account's quota: its usage, or why foreman could not read it. */
export type QuotaReading =
  | { readonly _tag: "usage"; readonly usage: Usage }
  | { readonly _tag: "unreadable"; readonly detail: string };

/** Quota reading folded into the status the advisor prints. */
export const quotaStatusOf = (reading: Option.Option<QuotaReading>): QuotaStatus =>
  Option.match(reading, {
    onNone: () => ({ _tag: "unknown" as const, detail: Option.some("no account to probe") }),
    onSome: (value) => {
      if (value._tag === "unreadable") {
        return { _tag: "unknown" as const, detail: Option.some(value.detail) };
      }
      const { usage } = value;
      const plan = Option.fromNullishOr(usage.plan);
      if (usage.allowances.length === 0) {
        return { _tag: "no-windows" as const, plan };
      }
      if (exhausted(usage)) {
        return {
          _tag: "exhausted" as const,
          plan,
          allowances: usage.allowances,
          freeAt: Option.fromNullishOr(freeAt(usage)),
        };
      }
      return { _tag: "available" as const, plan, allowances: usage.allowances };
    },
  });

export const TrialMedian = S.Struct({
  input: S.Option(S.Number),
  cacheRead: S.Option(S.Number),
  cacheWrite: S.Option(S.Number),
  output: S.Option(S.Number),
  samples: SampleCounts,
  basis: S.String,
  sized: S.Boolean,
});
export type TrialMedian = S.Schema.Type<typeof TrialMedian>;

/**
 * Merge trial medians with explicit CLI overrides. Overrides win per part;
 * an overridden part reports sample count 0 (it did not come from trials).
 */
export const mergeBudget = (
  trials: Option.Option<TrialMedian>,
  overrides: {
    readonly input: Option.Option<number>;
    readonly cacheRead: Option.Option<number>;
    readonly cacheWrite: Option.Option<number>;
    readonly output: Option.Option<number>;
  },
): TokenBudget => {
  const overrideParts = [
    Option.isSome(overrides.input) ? "input" : undefined,
    Option.isSome(overrides.cacheRead) ? "cache_read" : undefined,
    Option.isSome(overrides.cacheWrite) ? "cache_write" : undefined,
    Option.isSome(overrides.output) ? "output" : undefined,
  ].filter((name): name is string => name !== undefined);
  const hasOverride = overrideParts.length > 0;

  return Option.match(trials, {
    onNone: () =>
      hasOverride
        ? {
            input: overrides.input,
            cacheRead: overrides.cacheRead,
            cacheWrite: overrides.cacheWrite,
            output: overrides.output,
            samples: zeroSamples(),
            source: "cli-override" as const,
            basis: Option.some(`CLI token overrides only (${overrideParts.join(", ")})`),
          }
        : {
            input: Option.none(),
            cacheRead: Option.none(),
            cacheWrite: Option.none(),
            output: Option.none(),
            samples: zeroSamples(),
            source: "absent" as const,
            basis: Option.none(),
          },
    onSome: (median) => {
      const input = Option.orElse(overrides.input, () => median.input);
      const cacheRead = Option.orElse(overrides.cacheRead, () => median.cacheRead);
      const cacheWrite = Option.orElse(overrides.cacheWrite, () => median.cacheWrite);
      const output = Option.orElse(overrides.output, () => median.output);
      const samples: SampleCounts = {
        input: Option.isSome(overrides.input) ? 0 : median.samples.input,
        cacheRead: Option.isSome(overrides.cacheRead) ? 0 : median.samples.cacheRead,
        cacheWrite: Option.isSome(overrides.cacheWrite) ? 0 : median.samples.cacheWrite,
        output: Option.isSome(overrides.output) ? 0 : median.samples.output,
      };
      const source: BudgetSource = hasOverride
        ? "mixed"
        : median.sized
          ? "trials-median-size"
          : "trials-median";
      const basis = hasOverride
        ? `${median.basis}; CLI overrides: ${overrideParts.join(", ")}`
        : median.basis;
      return {
        input,
        cacheRead,
        cacheWrite,
        output,
        samples,
        source,
        basis: Option.some(basis),
      };
    },
  });
};

const emptyRates = (): RateSheet => ({
  input: Option.none(),
  output: Option.none(),
  cacheRead: Option.none(),
  cacheWrite: Option.none(),
});

/**
 * Cost of one budget at a rate sheet. Any needed token or rate that is absent
 * makes the whole estimate unknown. Missing cache_read is never filled from
 * input. A budget whose every part is zero is not a free-model price.
 */
export const estimatePrice = (
  budget: TokenBudget,
  rates: RateSheet,
  identity: Option.Option<string>,
  extra: {
    readonly assumptions?: ReadonlyArray<string>;
    readonly uncertainty?: ReadonlyArray<string>;
    readonly basis?: ReadonlyArray<string>;
    readonly quoteUnreliable?: boolean;
  } = {},
): PriceEstimate => {
  const assumptions = [...(extra.assumptions ?? [])];
  const uncertainty = [...(extra.uncertainty ?? [])];
  const basis = [...(extra.basis ?? [])];
  const quoteUnreliable = extra.quoteUnreliable === true;

  if (Option.isNone(identity)) {
    uncertainty.push("no exact models.dev identity in the registry");
  }

  if (budget.source === "absent") {
    uncertainty.push("no token budget");
    return {
      usd: Option.none(),
      rates,
      identity,
      basis,
      assumptions,
      uncertainty,
      quoteUnreliable,
    };
  }

  const parts: ReadonlyArray<{
    readonly name: string;
    readonly tokens: Option.Option<number>;
    readonly rate: Option.Option<number>;
  }> = [
    { name: "input", tokens: budget.input, rate: rates.input },
    { name: "cache_read", tokens: budget.cacheRead, rate: rates.cacheRead },
    { name: "cache_write", tokens: budget.cacheWrite, rate: rates.cacheWrite },
    { name: "output", tokens: budget.output, rate: rates.output },
  ];

  const allPresentZero = parts.every((part) =>
    Option.match(part.tokens, {
      onNone: () => false,
      onSome: (n) => n === 0,
    }),
  );
  if (allPresentZero) {
    uncertainty.push("zero token budget is not a model price");
    return {
      usd: Option.none(),
      rates,
      identity,
      basis,
      assumptions,
      uncertainty,
      quoteUnreliable,
    };
  }

  const priced = parts.reduce<{
    readonly usd: Option.Option<number>;
    readonly basis: ReadonlyArray<string>;
    readonly uncertainty: ReadonlyArray<string>;
  }>(
    (acc, part) =>
      Option.match(part.tokens, {
        onNone: () => ({
          usd: Option.none(),
          basis: acc.basis,
          uncertainty: [...acc.uncertainty, `${part.name} tokens unknown`],
        }),
        onSome: (tokens) => {
          if (tokens === 0) return acc;
          return Option.match(part.rate, {
            onNone: () => ({
              usd: Option.none(),
              basis: acc.basis,
              uncertainty: [...acc.uncertainty, `${part.name} rate unknown`],
            }),
            onSome: (rate) => {
              const line = (tokens / 1_000_000) * rate;
              return {
                usd: Option.map(acc.usd, (total) => total + line),
                basis: [
                  ...acc.basis,
                  `${part.name}: ${tokens} tokens × $${rate}/M = $${line.toFixed(6)}`,
                ],
                uncertainty: acc.uncertainty,
              };
            },
          });
        },
      }),
    { usd: Option.some(0), basis, uncertainty },
  );

  return {
    usd: priced.usd,
    rates,
    identity,
    basis: [...priced.basis],
    assumptions,
    uncertainty: [...priced.uncertainty],
    quoteUnreliable,
  };
};

export const RawCandidate = S.Struct({
  rung: S.String,
  model: S.String,
  pool: S.String,
  account: S.Option(S.String),
  rank: S.Number,
  level: S.Int,
  modelsDev: S.Option(S.String),
  enabled: S.Boolean,
  /** The rung may take an author block (ladder `mayAuthor`). */
  author: S.Boolean,
  retired: S.Boolean,
  /** When true, account allowance does not wall this rung (ladder `isMetered`). */
  unmetered: S.Boolean,
});
export type RawCandidate = S.Schema.Type<typeof RawCandidate>;

export const CatalogLookup = S.Struct({
  rates: RateSheet,
  assumptions: S.Array(S.String),
  uncertainty: S.Array(S.String),
  basis: S.Array(S.String),
  quoteUnreliable: S.Boolean,
});
export type CatalogLookup = S.Schema.Type<typeof CatalogLookup>;

/**
 * Resolved escalation floor — validated once at the CLI/registry boundary.
 * `level` is the lowest level an author may take (`floorFor`), and `label`
 * the rung it was set after.
 */
export const EscalationFloor = S.Struct({
  level: S.Int,
  label: S.Option(S.String),
});
export type EscalationFloor = S.Schema.Type<typeof EscalationFloor>;

/**
 * Build the candidates with their prices and quotas, and recommend the rung
 * `choice` names. The pick is the ladder's (`ladderChoice`); price and quota
 * are information beside it. Account exhaustion walls only metered rungs.
 */
export const advise = (
  rows: ReadonlyArray<RawCandidate>,
  floor: EscalationFloor,
  lookup: (modelsDev: Option.Option<string>) => Option.Option<CatalogLookup>,
  budget: TokenBudget,
  quotaOf: (account: Option.Option<string>) => QuotaStatus,
  choice: Choice,
): AdviceReport => {
  const exclusions: Array<{ rung: string; reason: string }> = [];
  const candidates: AdviceCandidate[] = [];
  const belowReason = Option.match(floor.label, {
    onNone: () => "below escalation floor",
    onSome: (name) => `below escalation floor after ${name}`,
  });

  for (const row of rows) {
    if (!row.enabled) {
      exclusions.push({ rung: row.rung, reason: "disabled" });
      continue;
    }
    if (!row.author) {
      exclusions.push({ rung: row.rung, reason: "author off" });
      continue;
    }
    if (row.retired) {
      exclusions.push({ rung: row.rung, reason: "retired" });
      continue;
    }
    if (row.level < floor.level) {
      candidates.push(
        buildCandidate(row, budget, lookup, quotaOf(row.account), "below-floor", [belowReason]),
      );
      exclusions.push({ rung: row.rung, reason: belowReason });
      continue;
    }

    const quota = quotaOf(row.account);
    const allowanceApplies = !row.unmetered;
    const eligibility: Eligibility =
      allowanceApplies && quota._tag === "exhausted" ? "exhausted" : "eligible";
    const reasons: string[] = [];
    if (row.unmetered) {
      reasons.push("unmetered: account allowance does not apply (sponsored)");
    }
    if (eligibility === "exhausted") {
      reasons.push("account exhausted");
      exclusions.push({ rung: row.rung, reason: "account exhausted" });
    }
    Match.value(quota).pipe(
      Match.when({ _tag: "unknown" }, (q) => {
        reasons.push(
          Option.match(q.detail, {
            onNone: () => "quota unknown",
            onSome: (d) => `quota unknown: ${d}`,
          }),
        );
      }),
      Match.when({ _tag: "no-windows" }, () => {
        reasons.push("quota readable but no allowance windows — not confirmed capacity");
      }),
      Match.when({ _tag: "available" }, () => {
        if (allowanceApplies) reasons.push("confirmed subscription capacity");
        else reasons.push("account has room (observation only; rung is unmetered)");
      }),
      Match.when({ _tag: "exhausted" }, () => {
        if (!allowanceApplies) {
          reasons.push("account exhausted (observation only; rung is unmetered)");
        }
      }),
      Match.exhaustive,
    );

    candidates.push(buildCandidate(row, budget, lookup, quota, eligibility, reasons));
  }

  const picked = Match.value(choice).pipe(
    Match.tagsExhaustive({
      Dispatch: ({ rung }) => ({
        candidate: Option.fromNullishOr(candidates.find((c) => c.rung === rung.name)),
        rule: LADDER_RULE,
      }),
      Waiting: ({ walled }) => ({
        candidate: Option.none<AdviceCandidate>(),
        rule: `every author rung at or above the floor is on a spent account: ${walled.join(", ")}`,
      }),
      Yours: () => ({
        candidate: Option.none<AdviceCandidate>(),
        rule: "no enabled author rung at or above the floor",
      }),
    }),
  );
  return {
    catalog: { source: "", fetchedAt: Option.none(), ageSeconds: Option.none() },
    budget,
    recommendation: picked.candidate,
    selectionRule: picked.rule,
    candidates,
    exclusions,
  };
};

const buildCandidate = (
  row: RawCandidate,
  budget: TokenBudget,
  lookup: (modelsDev: Option.Option<string>) => Option.Option<CatalogLookup>,
  quota: QuotaStatus,
  eligibility: Eligibility,
  reasons: ReadonlyArray<string>,
): AdviceCandidate => {
  const found = lookup(row.modelsDev);
  const price = Option.match(found, {
    onNone: () =>
      estimatePrice(budget, emptyRates(), row.modelsDev, {
        uncertainty: [
          Option.match(row.modelsDev, {
            onNone: () =>
              "exact catalog identity unknown — price unknown (Cursor Auto is still viable when capacity is confirmed)",
            onSome: (id) => `catalog has no cost for ${id}`,
          }),
        ],
      }),
    onSome: (hit) =>
      estimatePrice(budget, hit.rates, row.modelsDev, {
        assumptions: hit.assumptions,
        uncertainty: hit.uncertainty,
        basis: hit.basis,
        quoteUnreliable: hit.quoteUnreliable,
      }),
  });

  const billing = billingOf(row.account);
  const billingReason =
    billing === "subscription"
      ? "billing: subscription account"
      : "billing: unknown — catalog list price is not account billing";

  const listPriceReason = Option.match(price.usd, {
    onNone: () => "list-price unknown",
    onSome: (usd) => `list-price estimate $${usd.toFixed(4)}`,
  });

  return {
    rung: row.rung,
    model: row.model,
    pool: row.pool,
    account: row.account,
    rank: row.rank,
    unmetered: row.unmetered,
    billing,
    eligibility,
    price,
    quota,
    reasons: [
      ...reasons,
      billingReason,
      listPriceReason,
      ...price.assumptions.map((a) => `assumption: ${a}`),
      ...price.uncertainty.map((u) => `uncertainty: ${u}`),
    ],
  };
};

/**
 * The rung dispatch would give a task that `failures` failed: `authorFor` over
 * the ladder, passing over the rungs a spent account stops, read from the same
 * account readings dispatch takes (`walledSeats`). An account with no reading
 * walls nothing, as in dispatch.
 *
 * No task is in hand, so no usage wall on a task's own runs (`walledBy`) applies,
 * and no tick has drawn an account yet: those two inputs of dispatch are empty.
 */
export const ladderChoice = (
  ladder: Ladder,
  failures: ReadonlyArray<string>,
  usageOf: (provider: string) => Option.Option<Usage>,
  lastStarts: LastStarts,
): Choice => {
  const providers = providersOf(ladder).flatMap((provider) =>
    Option.match(usageOf(provider), {
      onNone: () => [],
      onSome: (usage) => [{ ...usage, rungs: rungsOn(ladder, provider), reviewers: [] }],
    }),
  );
  return authorFor(ladder, failures, walledSeats(providers).author, new Set(), lastStarts);
};

const LADDER_RULE =
  "the ladder's order, as dispatch picks an author: the lowest level at or above the floor, then the rung whose last run started longest ago, passing over rungs on a spent account; price is information only";

/** JSON shape for `--json`: observations only, no secrets. Option → null at the edge. */
export const adviceJson = (report: AdviceReport): string =>
  JSON.stringify(
    {
      catalog: {
        source: report.catalog.source,
        fetchedAt: Option.getOrNull(report.catalog.fetchedAt),
        ageSeconds: Option.getOrNull(report.catalog.ageSeconds),
      },
      budget: {
        input: Option.getOrNull(report.budget.input),
        cacheRead: Option.getOrNull(report.budget.cacheRead),
        cacheWrite: Option.getOrNull(report.budget.cacheWrite),
        output: Option.getOrNull(report.budget.output),
        samples: report.budget.samples,
        source: report.budget.source,
        basis: Option.getOrNull(report.budget.basis),
      },
      selectionRule: report.selectionRule,
      recommendation: Option.getOrNull(Option.map(report.recommendation, candidateJson)),
      candidates: report.candidates.map(candidateJson),
      exclusions: report.exclusions,
    },
    null,
    2,
  );

const candidateJson = (c: AdviceCandidate) => ({
  rung: c.rung,
  model: c.model,
  pool: c.pool,
  account: Option.getOrNull(c.account),
  rank: c.rank,
  unmetered: c.unmetered,
  billing: c.billing,
  eligibility: c.eligibility,
  price: {
    usd: Option.getOrNull(c.price.usd),
    identity: Option.getOrNull(c.price.identity),
    rates: {
      input: Option.getOrNull(c.price.rates.input),
      output: Option.getOrNull(c.price.rates.output),
      cacheRead: Option.getOrNull(c.price.rates.cacheRead),
      cacheWrite: Option.getOrNull(c.price.rates.cacheWrite),
    },
    basis: c.price.basis,
    assumptions: c.price.assumptions,
    uncertainty: c.price.uncertainty,
    quoteUnreliable: c.price.quoteUnreliable,
  },
  quota: quotaJson(c.quota),
  reasons: c.reasons,
});

const quotaJson = (q: QuotaStatus) =>
  Match.value(q).pipe(
    Match.when({ _tag: "available" }, (v) => ({
      status: "available" as const,
      plan: Option.getOrNull(v.plan),
      allowances: v.allowances.map(allowanceJson),
    })),
    Match.when({ _tag: "exhausted" }, (v) => ({
      status: "exhausted" as const,
      plan: Option.getOrNull(v.plan),
      freeAt: Option.getOrNull(Option.map(v.freeAt, (d) => d.toISOString())),
      allowances: v.allowances.map(allowanceJson),
    })),
    Match.when({ _tag: "no-windows" }, (v) => ({
      status: "no-windows" as const,
      plan: Option.getOrNull(v.plan),
    })),
    Match.when({ _tag: "unknown" }, (v) => ({
      status: "unknown" as const,
      detail: Option.getOrNull(v.detail),
    })),
    Match.exhaustive,
  );

const allowanceJson = (a: Allowance) => ({
  window: a.window,
  usedPercent: a.usedPercent,
  resetsAt: a.resetsAt?.toISOString() ?? null,
});

const AllowanceJson = S.Struct({
  window: S.String,
  usedPercent: S.Number,
  resetsAt: S.NullOr(S.String),
});

const QuotaJson = S.Union([
  S.Struct({
    status: S.Literal("available"),
    plan: S.NullOr(S.String),
    allowances: S.Array(AllowanceJson),
  }),
  S.Struct({
    status: S.Literal("exhausted"),
    plan: S.NullOr(S.String),
    freeAt: S.NullOr(S.String),
    allowances: S.Array(AllowanceJson),
  }),
  S.Struct({
    status: S.Literal("no-windows"),
    plan: S.NullOr(S.String),
  }),
  S.Struct({
    status: S.Literal("unknown"),
    detail: S.NullOr(S.String),
  }),
]);

const CandidateJson = S.Struct({
  rung: S.String,
  model: S.String,
  pool: S.String,
  account: S.NullOr(S.String),
  rank: S.Number,
  unmetered: S.Boolean,
  billing: BillingKind,
  eligibility: Eligibility,
  price: S.Struct({
    usd: S.NullOr(S.Number),
    identity: S.NullOr(S.String),
    rates: S.Struct({
      input: S.NullOr(S.Number),
      output: S.NullOr(S.Number),
      cacheRead: S.NullOr(S.Number),
      cacheWrite: S.NullOr(S.Number),
    }),
    basis: S.Array(S.String),
    assumptions: S.Array(S.String),
    uncertainty: S.Array(S.String),
    quoteUnreliable: S.Boolean,
  }),
  quota: QuotaJson,
  reasons: S.Array(S.String),
});

/** Schema for decoding `--json` output in tests. */
export const AdviceJsonReport = S.Struct({
  catalog: S.Struct({
    source: S.String,
    fetchedAt: S.NullOr(S.String),
    ageSeconds: S.NullOr(S.Number),
  }),
  budget: S.Struct({
    input: S.NullOr(S.Number),
    cacheRead: S.NullOr(S.Number),
    cacheWrite: S.NullOr(S.Number),
    output: S.NullOr(S.Number),
    samples: SampleCounts,
    source: BudgetSource,
    basis: S.NullOr(S.String),
  }),
  selectionRule: S.String,
  recommendation: S.NullOr(CandidateJson),
  candidates: S.Array(CandidateJson),
  exclusions: S.Array(S.Struct({ rung: S.String, reason: S.String })),
});
export type AdviceJsonReport = S.Schema.Type<typeof AdviceJsonReport>;

/** Human text for the default CLI path. */
export const adviceText = (report: AdviceReport): string => {
  const lines: string[] = [];
  lines.push(
    `catalog: ${report.catalog.source}` +
      Option.match(report.catalog.ageSeconds, {
        onNone: () => "",
        onSome: (s) => ` (age ${formatAge(s)})`,
      }) +
      Option.match(report.catalog.fetchedAt, {
        onNone: () => "",
        onSome: (at) => ` fetched ${at}`,
      }),
  );
  lines.push(
    `budget: ${budgetLine(report.budget)}` +
      samplesLine(report.budget.samples) +
      Option.match(report.budget.basis, {
        onNone: () => "",
        onSome: (b) => ` [${b}]`,
      }),
  );
  lines.push(`selection: ${report.selectionRule}`);
  lines.push("");
  Option.match(report.recommendation, {
    onNone: () => {
      lines.push("recommendation: none — no eligible worker under the current floor and quotas");
    },
    onSome: (r) => {
      lines.push(
        `recommendation: ${r.rung} (${r.model}, pool ${r.pool})` +
          Option.match(r.price.usd, {
            onNone: () => " — list-price unknown",
            onSome: (usd) => ` — ~$${usd.toFixed(4)} list`,
          }),
      );
      for (const reason of r.reasons) lines.push(`  · ${reason}`);
      lines.push(...quotaLines(r.quota, "  "));
    },
  });
  lines.push("");
  lines.push("candidates:");
  for (const c of report.candidates) {
    const price = Option.match(c.price.usd, {
      onNone: () => "price unknown",
      onSome: (usd) => `~$${usd.toFixed(4)}`,
    });
    lines.push(
      `  ${String(c.rank).padStart(2)}  ${c.rung.padEnd(28)} ${c.eligibility.padEnd(12)} ${price}  ${c.pool}${c.unmetered ? "  unmetered" : ""}`,
    );
    lines.push(...quotaLines(c.quota, "      "));
  }
  if (report.exclusions.length > 0) {
    lines.push("");
    lines.push("exclusions:");
    for (const ex of report.exclusions) {
      lines.push(`  ${ex.rung}: ${ex.reason}`);
    }
  }
  return lines.join("\n");
};

const budgetLine = (b: TokenBudget): string =>
  [
    `input=${Option.getOrElse(b.input, () => "?")}`,
    `cache_read=${Option.getOrElse(b.cacheRead, () => "?")}`,
    `cache_write=${Option.getOrElse(b.cacheWrite, () => "?")}`,
    `output=${Option.getOrElse(b.output, () => "?")}`,
    `(${b.source})`,
  ].join(" ");

const samplesLine = (s: SampleCounts): string => {
  const total = s.input + s.cacheRead + s.cacheWrite + s.output;
  if (total === 0) return "";
  return ` samples{input=${s.input},cache_read=${s.cacheRead},cache_write=${s.cacheWrite},output=${s.output}}`;
};

const quotaLines = (q: QuotaStatus, pad: string): ReadonlyArray<string> =>
  Match.value(q).pipe(
    Match.when({ _tag: "available" }, (v) => [
      `${pad}quota available${Option.match(v.plan, { onNone: () => "", onSome: (p) => ` [${p}]` })}`,
      ...v.allowances.map(
        (a) =>
          `${pad}  ${a.window.padEnd(18)} ${String(a.usedPercent).padStart(3)}% used  resets ${a.resetsAt?.toISOString() ?? "unknown"}`,
      ),
    ]),
    Match.when({ _tag: "exhausted" }, (v) => [
      `${pad}quota exhausted${Option.match(v.plan, { onNone: () => "", onSome: (p) => ` [${p}]` })}` +
        Option.match(v.freeAt, {
          onNone: () => "",
          onSome: (at) => ` until ${at.toISOString()}`,
        }),
      ...v.allowances.map(
        (a) =>
          `${pad}  ${a.window.padEnd(18)} ${String(a.usedPercent).padStart(3)}% used  resets ${a.resetsAt?.toISOString() ?? "unknown"}`,
      ),
    ]),
    Match.when({ _tag: "no-windows" }, () => [
      `${pad}quota: no allowance windows (not confirmed capacity)`,
    ]),
    Match.when({ _tag: "unknown" }, (v) => [
      `${pad}quota unknown${Option.match(v.detail, { onNone: () => "", onSome: (d) => `: ${d}` })}`,
    ]),
    Match.exhaustive,
  );

const formatAge = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

/** Median of a numeric sample; empty → none. */
export const medianOf = (values: ReadonlyArray<number>): Option.Option<number> => {
  if (values.length === 0) return Option.none();
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1];
    const hi = sorted[mid];
    if (lo === undefined || hi === undefined) return Option.none();
    return Option.some((lo + hi) / 2);
  }
  return Option.fromNullishOr(sorted[mid]);
};
