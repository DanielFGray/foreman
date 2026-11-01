import { expect, test } from "bun:test";
import { report } from "./report.ts";

test("renders self-contained metric tables", () => {
  const html = report({
    rung: [],
    project: [],
    label: [],
    task: [
      {
        key: "ts-1",
        metrics: {
          runs: 1,
          medianDuration: 12,
          p90Duration: 12,
          reviewRejectionRate: 0,
          escalationRate: 0,
          landRate: 1,
          verificationBreakRate: 0,
        },
      },
    ],
  });
  expect(html).toContain("<style>");
  expect(html).toContain("Task timeline");
  expect(html).toContain("ts-1");
});
