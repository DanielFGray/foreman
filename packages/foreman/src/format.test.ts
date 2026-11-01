import { describe, expect, test } from "bun:test";
import { quotaJson, resetsLabel, usedLabel, type QuotaReading } from "./format.ts";
import type { Usage } from "./quota.ts";

describe("resetsLabel", () => {
  // A fixed local noon, so an offset of hours never crosses midnight by chance.
  const noon = new Date(2026, 9, 10, 12, 0);
  const after = (minutes: number) => new Date(noon.getTime() + minutes * 60000);

  test("the relative duration, plus the local hour it happens", () => {
    expect(resetsLabel(after(37), noon)).toMatch(/^in 37m at 12:37\sPM$/);
    expect(resetsLabel(after(125), noon)).toMatch(/^in 2h 5m at /);
    expect(resetsLabel(after(6 * 1440), noon)).toMatch(/^in 6d at /);
  });

  test("names the day when the reset is not today", () => {
    expect(resetsLabel(after(13 * 60), noon)).toMatch(/^in 13h at Oct 11, 1:00\sAM$/);
  });

  test("a reset that has passed still reads as now, never negative", () => {
    expect(resetsLabel(after(-1), noon)).toMatch(/^in 1m at /);
    expect(resetsLabel(after(1.5), noon)).toMatch(/^in 2m at /);
  });
});

describe("usedLabel", () => {
  test("a fractional share reads as a whole percent that never reaches 100 early", () => {
    expect(usedLabel(28.704166666666666)).toBe("28%");
    expect(usedLabel(99.6)).toBe("99%");
    expect(usedLabel(100)).toBe("100%");
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
