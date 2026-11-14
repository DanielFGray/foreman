import { assert, describe, it } from "@effect/vitest";
import type { Published, PublishedPlacement, PublishedRow } from "foreman/published-schema";
import { bytesLabel, dashboardOf, STALE_MS } from "./dashboard.ts";
import { fixtureReading } from "./fixtures.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z");

const row = (view: PublishedRow["view"], key: string): PublishedRow => ({
  view,
  key,
  label: key,
  detail: null,
  project: "amux",
  parent: null,
  epic: false,
  actions: [],
  url: null,
  pr: null,
});

const placed = (key: string, column: PublishedPlacement["column"]): PublishedPlacement => ({
  key,
  label: key,
  project: "amux",
  parent: null,
  node: "author",
  stands: "author",
  state: "waiting",
  gates: [],
  column,
  url: null,
  pr: null,
  grant: null,
  runs: [],
});

const reading = (over: Partial<Published>): Published => ({
  ...fixtureReading(),
  observedAt: new Date(NOW - 5_000).toISOString(),
  dispatcher: { state: "running" },
  ...over,
});

describe("dashboardOf", () => {
  it("puts each row in its view's section, needs-you first and quota last", () => {
    const shown = dashboardOf(
      reading({ rows: [row("working", "w"), row("attention", "a"), row("quota", "q")] }),
      NOW,
    );
    assert.deepStrictEqual(
      shown.sections.map((section) => [section.view, section.rows.map((one) => one.key)]),
      [
        ["attention", ["a"]],
        ["working", ["w"]],
        ["review", []],
        ["landed", []],
        ["quota", ["q"]],
      ],
    );
  });

  it("counts each project's placed tasks per board column, and names its problems and pause", () => {
    const base = reading({});
    const shown = dashboardOf(
      {
        ...base,
        placements: [placed("t1", "queue"), placed("t2", "queue"), placed("t3", "authoring")],
        stopped: [{ project: "amux", problems: ["no land block"] }],
        policy: { ...base.policy, projects: { amux: { paused: true } } },
      },
      NOW,
    );
    const amux = shown.projects.find((project) => project.name === "amux");
    assert.strictEqual(amux?.counts.queue, 2);
    assert.strictEqual(amux?.counts.authoring, 1);
    assert.strictEqual(amux?.counts.landed, 0);
    assert.isTrue(amux?.paused);
    assert.deepStrictEqual(amux?.problems, ["no land block"]);
    assert.isFalse(shown.projects.find((project) => project.name === "foreman")?.paused);
  });

  it("reads a running dispatcher as stale once its reading is STALE_MS old, and keeps a failure's detail", () => {
    assert.strictEqual(dashboardOf(reading({}), NOW).dispatcher.state, "running");
    const old = reading({ observedAt: new Date(NOW - STALE_MS).toISOString() });
    assert.strictEqual(dashboardOf(old, NOW).dispatcher.state, "stale");
    const failed = dashboardOf(reading({ dispatcher: { state: "failed", detail: "boom" } }), NOW);
    assert.deepStrictEqual(failed.dispatcher, { state: "failed", age: 5_000, detail: "boom" });
    assert.strictEqual(dashboardOf(reading({ dispatcher: null }), NOW).dispatcher.state, "none");
    assert.strictEqual(
      dashboardOf(reading({ observedAt: null }), NOW).dispatcher.state,
      "starting",
    );
  });

  it("sums the live agents' memory beside the free memory", () => {
    const shown = dashboardOf(
      reading({ availableMemory: 8 * 1024 ** 3, workerMemory: { a: 1024 ** 3, b: 1024 ** 3 } }),
      NOW,
    );
    assert.deepStrictEqual(shown.memory, { free: 8 * 1024 ** 3, agents: 2 * 1024 ** 3 });
    assert.strictEqual(dashboardOf(reading({ availableMemory: null }), NOW).memory, null);
    assert.strictEqual(bytesLabel(7.8 * 1024 ** 3), "7.8G");
    assert.strictEqual(bytesLabel(700 * 1024 ** 2), "700M");
  });
});
