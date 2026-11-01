import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { untilNotWorking } from "./fleet.ts";

describe("untilNotWorking", () => {
  test("returns when a turn ends, after a check-in in between", async () => {
    // Readings: working, then working again after the check-in, then done.
    const readings = [true, true, false];
    const awaited: Array<number> = [];
    const working = Effect.sync(() => readings.shift() ?? false);
    const awaitTurn = Effect.sync(() => {
      awaited.push(awaited.length);
    });

    await Effect.runPromise(untilNotWorking(working, awaitTurn));

    expect(awaited).toEqual([0, 1]);
    expect(readings).toEqual([]);
  });

  test("does not wait when nothing is working", async () => {
    let awaited = 0;
    await Effect.runPromise(
      untilNotWorking(
        Effect.succeed(false),
        Effect.sync(() => {
          awaited += 1;
        }),
      ),
    );
    expect(awaited).toBe(0);
  });
});
