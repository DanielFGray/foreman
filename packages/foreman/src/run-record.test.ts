import { describe, expect, test } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { SqlClient } from "effect/sql";
import type { Item } from "./prog.ts";
import { closes, insertRun, poolFor, runFor, Runs } from "./run-record.ts";
import { reasonOf } from "./registry.ts";
import { scratchStore, withStore } from "./scratch-store.ts";

const task = (overrides: Partial<Item> = {}) =>
  ({
    id: "ts-1",
    title: "Measure the stack-safety candidates",
    project: "quill",
    labels: [],
    status: "reviewing",
    ...overrides,
  }) as unknown as Item;

const run = (overrides: Partial<Parameters<typeof runFor>[0]> = {}) => ({
  task: task(),
  branch: "foreman/ts-1",
  harness: "opencode",
  model: "opencode-go/deepseek-v4-flash",
  provider: "opencode-go",
  role: "author" as const,
  phase: "Unfinished" as const,
  ...overrides,
});

describe("poolFor", () => {
  test("names an account as the trials table spells it", () => {
    expect(poolFor("openai")).toBe("OpenAI");
    expect(poolFor("opencode-go")).toBe("OpenCode Go");
    expect(poolFor("opencode")).toBe("OpenCode Zen");
    expect(poolFor("claude")).toBe("Anthropic");
  });

  test("writes an account it has no name for as itself", () => {
    // A wrong pool name is worse than a key nobody recognises: it silently
    // splits one account's history into two.
    expect(poolFor("brand-new")).toBe("brand-new");
  });
});

describe("closes", () => {
  test("a live agent and an unread review have not ended", () => {
    // foreman closed a coach window, not a run; a row here would say work
    // finished while the agent is still holding it.
    expect(closes("Blocked")).toBe(false);
    expect(closes("ReviewWaiting")).toBe(false);
    expect(closes("ReviewExpired")).toBe(false);
  });

  test("every ending a run can reach is a close", () => {
    expect(closes("Landed")).toBe(true);
    expect(closes("ReviewReturned")).toBe(true);
    expect(closes("VanishedEmpty")).toBe(true);
    expect(closes("Unfinished")).toBe(true);
  });
});

describe("runFor", () => {
  test("states the run foreman derived and nothing it did not", () => {
    expect(runFor(run())).toEqual({
      project: "quill",
      task: "ts-1",
      slice: "Measure the stack-safety candidates",
      kind: "opencode",
      pool: "OpenCode Go",
      model: "opencode-go/deepseek-v4-flash",
      work: "build",
      // A stop without a verdict is a hand-off, not a drop: foreman cannot tell
      // a crash from an agent that lost track, and neither can the table.
      outcome: "handed-off",
      source: "live",
      size: null,
      rounds: null,
      rung: null,
      evidence: "foreman/ts-1",
      notes: "Unfinished",
    });
  });

  test("reads size and the author's correction rounds from their labels", () => {
    const labelled = task({ labels: ["size:2", "rounds:1"] });
    expect(runFor(run({ task: labelled }))).toMatchObject({ size: 2, rounds: 1 });
    // The rounds were the author's; a reviewer's row does not inherit them.
    expect(runFor(run({ task: labelled, role: "review" }))).toMatchObject({
      size: 2,
      rounds: null,
    });
  });

  test("writes no row for a run that has not ended", () => {
    expect(runFor(run({ phase: "Blocked" }))).toBeUndefined();
  });

  test("lands a report as answered and code as committed", () => {
    expect(runFor(run({ phase: "Landed" }))?.outcome).toBe("committed");
    expect(runFor(run({ phase: "Landed", task: task({ labels: ["research"] }) }))).toMatchObject({
      outcome: "answered",
      work: "research",
    });
  });

  test("records a review as review, and a rejection as a hand-off", () => {
    expect(runFor(run({ role: "review", phase: "ReviewReturned" }))).toMatchObject({
      work: "review",
      outcome: "handed-off",
    });
  });

  test("drops what a person canceled", () => {
    expect(runFor(run({ phase: "Canceled" }))?.outcome).toBe("dropped");
  });

  test("names the harness when the account cannot be read", () => {
    // A rung with no derivable provider still ran; the harness is the honest
    // pool rather than an account foreman invented.
    expect(runFor(run({ provider: undefined, model: undefined }))).toMatchObject({
      pool: "opencode",
      model: "opencode",
    });
  });
});

describe("the runs writer", () => {
  const stored = () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<Record<string, unknown>>`SELECT * FROM runs`;
    });

  test("inserts a closed row the store's own schema accepts", () =>
    withStore(
      "",
      Effect.gen(function* () {
        yield* insertRun(runFor(run({ phase: "Landed", rung: "cheap" }))!);

        const written = yield* stored();
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({
          project: "quill",
          task: "ts-1",
          pool: "OpenCode Go",
          model: "opencode-go/deepseek-v4-flash",
          rung: "cheap",
          work: "build",
          outcome: "committed",
          source: "live",
        });
        // A run foreman closes has a close time; it keeps no start time.
        expect(written[0]?.["closed_at"]).not.toBeNull();
        expect(written[0]?.["started_at"]).toBeNull();
        // The two judgements foreman cannot make are absent, not invented.
        expect(written[0]?.["rounds"]).toBeNull();
        expect(written[0]?.["report_accurate"]).toBeNull();
      }),
    ));

  test("a store without the runs table fails the insert, and the service logs it instead", async () => {
    const logs: Array<string> = [];
    const store = scratchStore();
    const logger = Logger.layer([
      Logger.make(({ logLevel, message }) => {
        logs.push(`${logLevel} ${Array.isArray(message) ? message.join(" ") : message}`);
      }),
    ]);
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE runs`;
      const failure = yield* Effect.flip(insertRun(runFor(run())!));
      expect(reasonOf(failure)).toMatch(/no such table: runs/);
      // The service swallows it: a tick must not fail on a row.
      yield* (yield* Runs).record(runFor(run())!);
    });
    await program.pipe(
      Effect.provide(Layer.mergeAll(Runs.Default.pipe(Layer.provideMerge(store.layer)), logger)),
      Effect.runPromise,
    );
    store.cleanup();

    expect(
      logs.some((line) => line.startsWith("Warn") && line.includes("no such table: runs")),
    ).toBe(true);
  });
});
