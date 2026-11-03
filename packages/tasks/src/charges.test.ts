import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { charge, chargesOf, forgive } from "./charges.ts";
import { connectionAt } from "./connection.ts";
import { park, parksOf, unpark } from "./parks.ts";
import { openRun } from "./runs.ts";

const dir = mkdtempSync(join(tmpdir(), "tasks-charges-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
const inStore = <A, E>(use: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(use.pipe(Effect.provide(connectionAt(join(dir, `store-${++files}.db`)))));

const runOn = (task: string) =>
  openRun({
    project: "p",
    task,
    slice: "a slice",
    kind: "pi",
    pool: "Pool",
    model: "m1",
    rung: "cheap",
    node: "author",
    work: "build",
  });

describe("charges", () => {
  test("a charge follows the task's newest run, and forgiving keeps it marked", async () => {
    const charges = await inStore(
      Effect.gen(function* () {
        yield* charge("ts-1", "free");
        yield* runOn("ts-1");
        const newest = yield* runOn("ts-1");
        yield* runOn("ts-2");
        yield* charge("ts-1", "cheap");
        yield* forgive("ts-1", "free");
        return { newest, charges: (yield* chargesOf(["ts-1", "ts-2"])).get("ts-1") };
      }),
    );
    expect(charges.charges).toEqual([
      { rung: "free", run: undefined, forgiven: true },
      { rung: "cheap", run: charges.newest, forgiven: false },
    ]);
  });
});

describe("parks", () => {
  test("a second park replaces the reason, and unpark removes it", async () => {
    const [twice, gone] = await inStore(
      Effect.gen(function* () {
        yield* park("ts-1", "no reviewer left");
        yield* park("ts-1", "its block parks a stop");
        const twice = yield* parksOf(["ts-1"]);
        yield* unpark("ts-1");
        return [twice, yield* parksOf(["ts-1"])] as const;
      }),
    );
    expect([...twice]).toEqual([["ts-1", "its block parks a stop"]]);
    expect(gone.size).toBe(0);
  });
});
