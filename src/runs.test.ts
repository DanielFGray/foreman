import { describe, expect, test } from "bun:test";
import { runsFromOtlp, tablesFor } from "./runs.ts";

const otlp = JSON.stringify({
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            span("in-flight", "ts-flight", "cheap", "10"),
            span("rejected", "ts-rejected", "cheap", "10", "20", { outcome: "ReviewReturned" }),
            span("escalated", "ts-escalated", "standard", "10", "30", { escalation: "true" }),
            span("landed", "ts-landed", "standard", "10", "50", {
              outcome: "Landed",
              verification: "broken",
            }),
          ],
        },
      ],
    },
  ],
});

function span(
  name: string,
  task: string,
  rung: string,
  startTimeUnixNano: string,
  endTimeUnixNano: string | undefined = undefined,
  extra: Readonly<Record<string, string>> = {},
) {
  return {
    name,
    startTimeUnixNano,
    ...(endTimeUnixNano ? { endTimeUnixNano } : {}),
    attributes: Object.entries({ task, project: "foreman", rung, labels: "bug", ...extra }).map(
      ([key, stringValue]) => ({ key, value: { stringValue } }),
    ),
  };
}

describe("runs", () => {
  test("keeps an in-flight run out of duration and rate calculations", () => {
    const tables = tablesFor(runsFromOtlp([otlp]));

    expect(tables.rung[0]?.metrics).toMatchObject({ runs: 2, reviewRejectionRate: 1 });
    expect(tables.rung[0]?.metrics.medianDuration).toBeCloseTo(0.00001);
  });

  test("counts a reviewer rejection", () => {
    const tables = tablesFor(runsFromOtlp([otlp]));

    expect(tables.project[0]?.metrics.reviewRejectionRate).toBe(1 / 3);
  });

  test("counts only an explicit rung change as escalation", () => {
    const tables = tablesFor(runsFromOtlp([otlp]));

    expect(tables.project[0]?.metrics.escalationRate).toBe(1 / 3);
  });

  test("counts a landed verification break and all four views", () => {
    const tables = tablesFor(runsFromOtlp([otlp]));

    expect(tables.project[0]?.metrics).toMatchObject({
      runs: 4,
      p90Duration: 0.00004,
      escalationRate: 1 / 3,
      verificationBreakRate: 1 / 3,
    });
    expect(tables.project[0]?.metrics.medianDuration).toBeCloseTo(0.00002);
    expect(tables.label[0]?.key).toBe("bug");
    expect(tables.task).toHaveLength(4);
  });

  test("ignores a malformed final collector line", () => {
    expect(runsFromOtlp([`${otlp}\n{`])).toHaveLength(4);
  });
});
