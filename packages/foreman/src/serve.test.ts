import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";
import { EMPTY_FLEET, type FleetState } from "./dispatcher.ts";
import { type Published, publishedOf } from "./published.ts";
import { holdLock, ServeRunning, supervise } from "./serve.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "foreman-serve-"));

const reading: FleetState = { ...EMPTY_FLEET, observedAt: DateTime.makeUnsafe(0) };

/** A host whose run fails `failures` times, publishing one reading each life, then returns. */
const fakeHost = (failures: number, builds: Ref.Ref<number>) =>
  Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(builds, (count) => count + 1);
    const state = yield* SubscriptionRef.make<FleetState>(EMPTY_FLEET);
    return {
      state,
      run: SubscriptionRef.set(state, reading).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(n <= failures ? Effect.fail("tick failed") : Effect.void),
      ),
    };
  });

const emptyReadings = () => SubscriptionRef.make(publishedOf(EMPTY_FLEET, Option.none()));

describe("supervise", () => {
  test("publishes the failure, waits out the pause, and builds a new dispatcher", async () => {
    const dir = scratch();
    const path = join(dir, "state.json");
    try {
      const builds = await Effect.runPromise(
        Effect.gen(function* () {
          const builds = yield* Ref.make(0);
          const readings = yield* emptyReadings();
          const fiber = yield* Effect.forkChild(supervise(fakeHost(1, builds), path, readings));
          // The file is written on real I/O, which the test clock does not drive.
          yield* until(() => failedOn(path));
          // Failed once, and not built again before the pause.
          expect(yield* Ref.get(builds)).toBe(1);
          const published = JSON.parse(readFileSync(path, "utf8"));
          expect(published.dispatcher).toEqual({
            state: "failed",
            detail: expect.stringContaining("tick failed"),
          });
          yield* TestClock.adjust(Duration.seconds(1));
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
          return yield* Ref.get(builds);
        }).pipe(Effect.provide(Layer.merge(TestClock.layer(), BunServices.layer))),
      );
      expect(builds).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a subscriber to the readings receives the failure and later readings without resubscribing", async () => {
    const dir = scratch();
    const path = join(dir, "state.json");
    try {
      const seen = await Effect.runPromise(
        Effect.gen(function* () {
          const builds = yield* Ref.make(0);
          const readings = yield* emptyReadings();
          const seen = yield* Ref.make<Array<Published>>([]);
          // Attach before supervise so one subscription spans the restart.
          const attached = yield* Deferred.make<void>();
          yield* Effect.forkChild(
            SubscriptionRef.changes(readings).pipe(
              Stream.tap(() => Deferred.succeed(attached, void 0)),
              Stream.filter((published) => published.dispatcher !== null),
              Stream.runForEach((published) => Ref.update(seen, (xs) => [...xs, published])),
            ),
          );
          yield* Deferred.await(attached);

          const fiber = yield* Effect.forkChild(supervise(fakeHost(1, builds), path, readings));
          yield* until(() => failedOn(path));
          const afterFailure = JSON.parse(readFileSync(path, "utf8"));
          expect(afterFailure.dispatcher).toEqual({
            state: "failed",
            detail: expect.stringContaining("tick failed"),
          });

          yield* TestClock.adjust(Duration.seconds(1));
          // Wait for the restarted reading on the same subscription, then on disk.
          yield* untilEffect(
            Ref.get(seen).pipe(Effect.map((xs) => xs.some((p) => p.dispatcher?.state === "idle"))),
          );
          yield* until(() => {
            try {
              return JSON.parse(readFileSync(path, "utf8")).dispatcher.state === "idle";
            } catch {
              return false;
            }
          });
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);

          const finalPublished = JSON.parse(readFileSync(path, "utf8"));
          expect(finalPublished.dispatcher).toEqual({ state: "idle" });
          expect(finalPublished.observedAt).toBe(DateTime.formatIso(DateTime.makeUnsafe(0)));

          return yield* Ref.get(seen);
        }).pipe(Effect.provide(Layer.merge(TestClock.layer(), BunServices.layer))),
      );

      const states = seen.map((published) => published.dispatcher?.state);
      const failedAt = states.indexOf("failed");
      expect(failedAt).toBeGreaterThanOrEqual(0);
      expect(states.slice(failedAt + 1)).toContain("idle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("holdLock", () => {
  test("a second holder is refused while the first holds, and admitted after", async () => {
    const dir = scratch();
    const lock = join(dir, "serve.lock");
    try {
      const second = await Effect.runPromise(
        Effect.scoped(holdLock(lock).pipe(Effect.andThen(Effect.scoped(holdLock(lock))))).pipe(
          Effect.flip,
        ),
      );
      expect(second).toEqual(new ServeRunning({ lock }));
      const after = await Effect.runPromise(Effect.scoped(holdLock(lock)).pipe(Effect.option));
      expect(Option.isSome(after)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const failedOn = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, "utf8")).dispatcher.state === "failed";
  } catch {
    return false;
  }
};

/** Waits in real time for a condition that real I/O makes true. */
const until = (done: () => boolean): Effect.Effect<void> =>
  done()
    ? Effect.void
    : Effect.promise(() => Bun.sleep(5)).pipe(Effect.andThen(Effect.suspend(() => until(done))));

/** Waits in real time for an effectful condition. */
const untilEffect = (done: Effect.Effect<boolean>): Effect.Effect<void> =>
  done.pipe(
    Effect.flatMap((ok) =>
      ok
        ? Effect.void
        : Effect.promise(() => Bun.sleep(5)).pipe(
            Effect.andThen(Effect.suspend(() => untilEffect(done))),
          ),
    ),
  );
