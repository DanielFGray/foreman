import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { exhausted, freeAt, heldWhileSpent, type Spent, type Usage, windowName } from "./quota.ts";

const usage = (allowances: Usage["allowances"]): Usage => ({
  provider: "opencode-go",
  plan: undefined,
  allowances,
});

const at = (iso: string) => new Date(iso);

describe("exhausted", () => {
  test("an account with room in every window has room", () => {
    expect(
      exhausted(
        usage([
          { window: "rolling", usedPercent: 0, resetsAt: at("2026-08-20T00:00:00Z") },
          { window: "weekly", usedPercent: 29, resetsAt: at("2026-08-24T00:00:00Z") },
        ]),
      ),
    ).toBe(false);
  });

  test("one window at its limit stops the account", () => {
    // The shortest spent window is what the next request meets. A monthly
    // allowance already spent does not become spendable because the rolling
    // hour is empty, so any window at 100% is the whole answer.
    expect(
      exhausted(
        usage([
          { window: "rolling", usedPercent: 0, resetsAt: at("2026-08-20T00:00:00Z") },
          { window: "monthly", usedPercent: 100, resetsAt: at("2026-09-05T00:00:00Z") },
        ]),
      ),
    ).toBe(true);
  });

  test("an account nothing could be read for is not treated as spent", () => {
    // An unreachable usage endpoint is foreman's own network trouble. Reading
    // silence as "no allowance left" would stop the fleet on it, which is the
    // opposite of what the gate is for.
    expect(exhausted(usage([]))).toBe(false);
  });
});

describe("freeAt", () => {
  test("waits out the last window to reset, not the first", () => {
    // Room returns only when every spent window has reset. Reporting the
    // earliest would promise a fleet that is still stopped.
    expect(
      freeAt(
        usage([
          { window: "weekly", usedPercent: 100, resetsAt: at("2026-08-24T00:00:00Z") },
          { window: "monthly", usedPercent: 100, resetsAt: at("2026-09-05T00:00:00Z") },
        ]),
      ),
    ).toEqual(at("2026-09-05T00:00:00Z"));
  });

  test("ignores when a window with room resets", () => {
    expect(
      freeAt(
        usage([
          { window: "rolling", usedPercent: 0, resetsAt: at("2026-12-01T00:00:00Z") },
          { window: "weekly", usedPercent: 100, resetsAt: at("2026-08-24T00:00:00Z") },
        ]),
      ),
    ).toEqual(at("2026-08-24T00:00:00Z"));
  });

  test("an account with room has no reset to wait for", () => {
    expect(
      freeAt(usage([{ window: "weekly", usedPercent: 4, resetsAt: undefined }])),
    ).toBeUndefined();
  });
});

describe("windowName", () => {
  test("puts the length back on a window codex names only by rank", () => {
    // "primary" is a week on one plan and a day on another, so the rank alone
    // is nothing an operator can plan around.
    expect(windowName("primary", 10080)).toBe("primary (1w)");
    expect(windowName("secondary", 1440)).toBe("secondary (1d)");
    expect(windowName("primary", 300)).toBe("primary (5h)");
  });

  test("leaves a window whose length was not stated alone", () => {
    expect(windowName("primary", undefined)).toBe("primary");
  });
});

describe("heldWhileSpent", () => {
  const probeCounting = (readings: ReadonlyArray<Usage>) => {
    let calls = 0;
    const probe = () =>
      Effect.sync(() => {
        const reading = readings[Math.min(calls, readings.length - 1)];
        calls += 1;
        return reading as Usage;
      });
    return { probe, calls: () => calls };
  };

  const spent = (resetsAt: Date) =>
    usage([
      { window: "rolling", usedPercent: 0, resetsAt: at("2026-08-20T17:30:00Z") },
      { window: "monthly", usedPercent: 100, resetsAt },
    ]);

  const healthy = usage([
    { window: "monthly", usedPercent: 29, resetsAt: at("2036-01-01T00:00:00Z") },
  ]);

  const readAll = (probe: () => Effect.Effect<Usage>, times: number) =>
    Effect.gen(function* () {
      const held = yield* Ref.make(new Map<string, Spent>());
      const read = heldWhileSpent(probe, held);
      const seen: Array<Usage> = [];
      for (let i = 0; i < times; i += 1) seen.push(yield* read("opencode-go"));
      return seen;
    }).pipe(Effect.runPromise);

  test("a spent account is probed once and held until the reset it named", async () => {
    // The provider said the monthly window does not reset until 2036. Nothing
    // can make it have room before then, so asking again buys the same answer.
    const { probe, calls } = probeCounting([spent(at("2036-01-01T00:00:00Z"))]);
    const seen = await readAll(probe, 5);
    expect(calls()).toBe(1);
    expect(seen.every(exhausted)).toBe(true);
  });

  test("a reset already past is probed again, because the hold has expired", async () => {
    const { probe, calls } = probeCounting([spent(at("2020-01-01T00:00:00Z"))]);
    await readAll(probe, 4);
    expect(calls()).toBe(4);
  });

  test("an account with room is never held, because spending moves it", async () => {
    // The gate has to watch a healthy account reach the wall, and only the
    // provider can say it has.
    const { probe, calls } = probeCounting([healthy]);
    await readAll(probe, 3);
    expect(calls()).toBe(3);
  });

  test("a held account probes again once its reset passes, and then has room", async () => {
    const { probe, calls } = probeCounting([spent(at("2020-01-01T00:00:00Z")), healthy]);
    const seen = await readAll(probe, 2);
    expect(calls()).toBe(2);
    expect(exhausted(seen[0] as Usage)).toBe(true);
    expect(exhausted(seen[1] as Usage)).toBe(false);
  });
});
