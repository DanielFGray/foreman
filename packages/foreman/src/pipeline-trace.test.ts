import { describe, expect, test } from "bun:test";
import type { Ladder } from "./ladder.ts";
import { STANDARD_PIPELINES } from "./pipeline.ts";
import { configure } from "./pipeline-belt.ts";
import { traceReport } from "./pipeline-trace.ts";

const RULES = {
  ladder: [
    { name: "cheap", harness: "test", level: 0, model: undefined, provider: undefined },
  ] as Ladder,
  attemptsPerLevel: 2,
};
const REQUEST = { task: { labels: [], size: 2, priority: 2, parent: undefined }, events: [] };
const SAVED = { pipeline: STANDARD_PIPELINES.worktree, drawn: true };

describe("traceReport", () => {
  test("traces the draft when the project has one, else the pipeline it runs", () => {
    const sourceId = STANDARD_PIPELINES.worktree.nodes.find((node) => node.kind === "source")!.id;
    // A draft whose source takes only research work leaves this task outside it.
    const draft = configure(STANDARD_PIPELINES.worktree, sourceId, {
      kind: "source",
      filter: "label:research",
    });
    const drafted = traceReport("p", REQUEST, { draft, live: SAVED }, RULES);
    expect(drafted.source).toBe("draft");
    expect(drafted.steps[0]!.placement._tag).toBe("Outside");

    const saved = traceReport("p", REQUEST, { draft: undefined, live: SAVED }, RULES);
    expect(saved.source).toBe("saved");
    expect(saved.steps[0]!.placement._tag).toBe("At");

    const standard = traceReport(
      "p",
      REQUEST,
      { draft: undefined, live: { pipeline: STANDARD_PIPELINES.worktree, drawn: false } },
      RULES,
    );
    expect(standard.source).toBe("standard");
  });

  test("writes an absent value as null and names the chosen rung", () => {
    const report = traceReport(
      "p",
      { ...REQUEST, events: ["nonsense"] },
      { draft: undefined, live: SAVED },
      RULES,
    );
    const [start] = report.steps;
    expect(start!.event).toBeNull();
    expect(start!.parked).toBeNull();
    expect(start!.rung).toEqual({ _tag: "Dispatch", name: "cheap" });
    expect(report.refused?.event).toBe("nonsense");
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
