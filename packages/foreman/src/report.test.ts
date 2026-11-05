import { expect, test } from "bun:test";
import { report } from "./report.ts";

test("renders self-contained metric tables", () => {
  const html = report({
    rung: [],
    project: [],
    task: [
      {
        key: "ts-1",
        metrics: {
          runs: 1,
          medianDuration: 12,
          p90Duration: 12,
          reviewReturnRate: 0,
          landRate: 1,
        },
      },
    ],
  });
  expect(html).toContain("<style>");
  expect(html).toContain("Task timeline");
  expect(html).toContain("ts-1");
});
