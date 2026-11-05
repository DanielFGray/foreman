import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runs } from "./runs.ts";

const dir = mkdtempSync(join(tmpdir(), "tasks-charges-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
const inRuns = <A, E>(use: Effect.Effect<A, E, Runs>) =>
  Effect.runPromise(use.pipe(Effect.provide(Runs.layerAt(join(dir, `store-${++files}.db`)))));

const runOn = (runs: Runs["Service"], task: string) =>
  runs.openRun({
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
    const charges = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        yield* runs.charge("ts-1", "free");
        yield* runOn(runs, "ts-1");
        const newest = yield* runOn(runs, "ts-1");
        yield* runOn(runs, "ts-2");
        yield* runs.charge("ts-1", "cheap");
        yield* runs.forgive("ts-1", "free");
        return { newest, charges: (yield* runs.chargesOf(["ts-1", "ts-2"])).get("ts-1") };
      }),
    );
    expect(charges.charges).toEqual([
      { rung: "free", run: Option.none(), forgiven: true },
      { rung: "cheap", run: Option.some(charges.newest), forgiven: false },
    ]);
  });
});

describe("parks", () => {
  test("a second park replaces the reason, and unpark removes it", async () => {
    const [twice, gone] = await inRuns(
      Effect.gen(function* () {
        const runs = yield* Runs;
        yield* runs.park("ts-1", "no reviewer left");
        yield* runs.park("ts-1", "its block parks a stop");
        const twice = yield* runs.parksOf(["ts-1"]);
        yield* runs.unpark("ts-1");
        return [twice, yield* runs.parksOf(["ts-1"])] as const;
      }),
    );
    expect([...twice]).toEqual([["ts-1", "its block parks a stop"]]);
    expect(gone.size).toBe(0);
  });
});
