// How each rung's runs end and how long they take, measured from the runs
// table, blended toward its role's pooled rates where a rung has few runs of
// its own. The simulator (`pipeline-simulate.ts`) draws its outcomes and
// durations from these.
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { isExit } from "tasks";

/** How many runs of a rung's own weigh as much as its role's pool. */
export const BLEND_WEIGHT = 5;

/** The minutes a run takes when its role has no measured duration at all. */
export const ASSUMED_MINUTES = 60;

/** An agent's role, as a run's `work` gives it. */
export type AgentRole = "author" | "review";

/** One closed agent run, as the rates read it. */
export interface AgentSample {
  readonly rung: string;
  readonly role: AgentRole;
  readonly ending: string;
  /** From start to close; none when the run has no start time. */
  readonly minutes: number | undefined;
}

/** One check run. */
export interface CheckSample {
  readonly node: string;
  readonly passed: boolean;
}

export interface Measured {
  readonly agents: ReadonlyArray<AgentSample>;
  readonly checks: ReadonlyArray<CheckSample>;
}

/**
 * The closed live runs that have a rung, and every check run. A live run is
 * one foreman recorded as the agent ran.
 */
export const readMeasured = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const agents = yield* sql<{
    rung: string;
    work: string;
    ending: string;
    minutes: number | null;
  }>`SELECT rung, work, ending,
      (julianday(closed_at) - julianday(started_at)) * 1440 AS minutes
    FROM runs
    WHERE source = 'live' AND closed_at IS NOT NULL AND rung IS NOT NULL
      AND ending IS NOT NULL AND work <> 'check'
    ORDER BY id`;
  const checks = yield* sql<{ node: string; ending: string }>`SELECT node, ending
    FROM runs WHERE work = 'check' AND node IS NOT NULL ORDER BY id`;
  return {
    agents: agents.map((row): AgentSample => ({
      rung: row.rung,
      role: row.work === "review" ? "review" : "author",
      ending: row.ending,
      minutes: row.minutes ?? undefined,
    })),
    checks: checks.map((row): CheckSample => ({ node: row.node, passed: row.ending === "passed" })),
  } satisfies Measured;
});

/** Whether a number comes from the rung's own runs, or from its role's pool alone. */
export type Label = "Measured" | "Assumed";

/** How a rung's runs in one role end and how long they take. */
export interface AgentRate {
  readonly rung: string | undefined;
  readonly role: AgentRole;
  /** The rung's own runs that count. */
  readonly n: number;
  readonly label: Label;
  /** Each ending seen in the role, as a blended share. */
  readonly endings: ReadonlyMap<string, number>;
  /** The blended share of runs that named an exit, whichever exit it was. */
  readonly success: number;
  /** The rung's own durations, in minutes. */
  readonly own: ReadonlyArray<number>;
  /** The role's durations, in minutes, over every rung. */
  readonly pool: ReadonlyArray<number>;
}

export interface CheckRate {
  readonly node: string;
  readonly n: number;
  readonly label: Label;
  readonly pass: number;
}

/** The rates the simulator draws from. */
export interface Rates {
  readonly agent: (rung: string | undefined, role: AgentRole) => AgentRate;
  readonly check: (node: string) => CheckRate;
}

/**
 * The rates of `measured`. A rung's share of an ending is
 * `(own_e + K * pooled_e) / (n + K)`, where `pooled_e` is the ending's share
 * over the role's runs on every rung and K is `BLEND_WEIGHT`. A rung with no
 * run of its own reads the pool alone, and is labelled Assumed.
 *
 * A run released, vanished or canceled is left out: each ends by something
 * other than the agent (a replacement, the host, the operator).
 */
export const ratesOf = (measured: Measured): Rates => {
  const counted = measured.agents.filter((sample) => counts(sample.ending));
  const pools = new Map(
    (["author", "review"] as const).map((role) => {
      const samples = counted.filter((sample) => sample.role === role);
      return [role, { samples, shares: sharesOf(samples), minutes: minutesOf(samples) }] as const;
    }),
  );
  return {
    agent: (rung, role) => {
      const pool = pools.get(role)!;
      const own = pool.samples.filter((sample) => sample.rung === rung);
      const n = own.length;
      const ownShares = sharesOf(own);
      const blend = (pooled: number, mine: number) =>
        (mine * n + BLEND_WEIGHT * pooled) / (n + BLEND_WEIGHT);
      const endings = new Map(
        [...pool.shares].map(([ending, pooled]) => [
          ending,
          blend(pooled, ownShares.get(ending) ?? 0),
        ]),
      );
      const exitShare = (shares: ReadonlyMap<string, number>) =>
        [...shares].filter(([ending]) => isExit(ending)).reduce((sum, [, share]) => sum + share, 0);
      return {
        rung,
        role,
        n,
        label: n === 0 ? "Assumed" : "Measured",
        endings,
        // With no run in the role at all, every run is assumed to name an exit.
        success:
          pool.samples.length === 0 ? 1 : blend(exitShare(pool.shares), exitShare(ownShares)),
        own: minutesOf(own),
        pool: pool.minutes,
      };
    },
    check: (node) => {
      const own = measured.checks.filter((sample) => sample.node === node);
      return {
        node,
        n: own.length,
        label: own.length === 0 ? "Assumed" : "Measured",
        pass: own.length === 0 ? 1 : own.filter((sample) => sample.passed).length / own.length,
      };
    },
  };
};

/**
 * The minutes one run takes, drawn with `random`: from the rung's own
 * durations with chance `own / (own + K)`, else from its role's. A role with
 * none takes `ASSUMED_MINUTES`. A run takes at least one minute, so the clock
 * always moves.
 */
export const drawMinutes = (rate: AgentRate, random: () => number): number => {
  const fromOwn = random() < rate.own.length / (rate.own.length + BLEND_WEIGHT);
  const from = fromOwn ? rate.own : rate.pool;
  const minutes = from.length === 0 ? ASSUMED_MINUTES : from[Math.floor(random() * from.length)]!;
  return Math.max(1, minutes);
};

/** The middle of `minutes`, or none when it is empty. */
export const medianOf = (minutes: ReadonlyArray<number>): number | undefined => {
  if (minutes.length === 0) return undefined;
  const sorted = [...minutes].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** The endings an agent's own choice decides: an exit, a stop, or a usage wall. */
const counts = (ending: string): boolean =>
  isExit(ending) || ending === "stopped" || ending === "walled";

const sharesOf = (samples: ReadonlyArray<AgentSample>): ReadonlyMap<string, number> => {
  const tally = new Map<string, number>();
  for (const sample of samples) tally.set(sample.ending, (tally.get(sample.ending) ?? 0) + 1);
  return new Map([...tally].map(([ending, count]) => [ending, count / samples.length]));
};

const minutesOf = (samples: ReadonlyArray<AgentSample>): ReadonlyArray<number> =>
  samples.flatMap((sample) => (sample.minutes === undefined ? [] : [sample.minutes]));
