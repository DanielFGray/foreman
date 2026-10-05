import { describe, expect, test } from "bun:test";
import { quotaJson, resetsLabel, type QuotaReading } from "./format.ts";
import type { Usage } from "./quota.ts";

describe("resetsLabel", () => {
  test("the relative duration, plus the local hour it happens", () => {
    expect(resetsLabel(new Date(Date.now() + 37 * 60000))).toMatch(
      /^in 37m at \d{1,2}:\d{2} [AP]M/,
    );
    expect(resetsLabel(new Date(Date.now() + 125 * 60000))).toMatch(/^in 2h 5m at /);
    expect(resetsLabel(new Date(Date.now() + 6 * 86_400_000))).toMatch(/^in 6d at /);
  });

  test("a reset that has passed still reads as now, never negative", () => {
    expect(resetsLabel(new Date(Date.now() - 60_000))).toMatch(/^in 1m at /);
    expect(resetsLabel(new Date(Date.now() + 90_000))).toMatch(/^in 2m at /);
  });
});

const usage = (allowances: Usage["allowances"], plan?: string): Usage => ({
  provider: "openai",
  plan,
  allowances,
});

describe("quotaJson", () => {
  test("absolute resets only, with rungs, freeAt, unreadable and blind intact", () => {
    const readings: ReadonlyArray<QuotaReading> = [
      {
        _tag: "usage",
        provider: "openai",
        usage: usage(
          [
            { window: "rolling", usedPercent: 100, resetsAt: new Date("2026-09-07T04:30:00.000Z") },
            { window: "monthly", usedPercent: 20, resetsAt: new Date("2026-09-30T04:30:00.000Z") },
          ],
          "plus",
        ),
      },
      { _tag: "unreadable", provider: "claude", detail: "oauth token expired" },
    ];
    const report = JSON.parse(quotaJson(["mystery"], readings, (provider) => [provider]));

    expect(report.blind).toEqual(["mystery"]);
    expect(report.providers).toHaveLength(2);

    const openai = report.providers[0];
    expect(openai.provider).toBe("openai");
    expect(openai.plan).toBe("plus");
    expect(openai.exhausted).toBe(true);
    expect(openai.rungs).toEqual(["openai"]);
    // A spent account's freeAt is the last window to free it.
    expect(openai.freeAt).toBe("2026-09-07T04:30:00.000Z");
    expect(openai.allowances).toEqual([
      { window: "rolling", usedPercent: 100, resetsAt: "2026-09-07T04:30:00.000Z" },
      { window: "monthly", usedPercent: 20, resetsAt: "2026-09-30T04:30:00.000Z" },
    ]);

    expect(report.providers[1]).toEqual({
      provider: "claude",
      unreadable: "oauth token expired",
    });
  });

  test("a healthy account has a null freeAt and no exhausted flag", () => {
    const readings: ReadonlyArray<QuotaReading> = [
      {
        _tag: "usage",
        provider: "openai",
        usage: usage([
          { window: "rolling", usedPercent: 20, resetsAt: new Date("2026-09-07T04:30:00.000Z") },
        ]),
      },
    ];
    const report = JSON.parse(quotaJson([], readings, () => []));
    const row = report.providers[0] as Record<string, unknown>;
    expect(row.exhausted).toBe(false);
    expect(row.freeAt).toBeNull();
  });
});
