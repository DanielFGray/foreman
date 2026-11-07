import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { Settings } from "./config.ts";
import { EMPTY_FLEET, type FleetState } from "./dispatcher.ts";
import { Fleet, type Worker } from "./fleet.ts";
import { FleetError } from "./errors.ts";
import type { Ladder } from "./ladder.ts";
import { publishedOf } from "./published.ts";
import { type Published } from "./published-schema.ts";
import { Records } from "./records.ts";
import { Repository } from "./repository.ts";
import { scratchStore, seed } from "./scratch-store.ts";
import { holdLock, isolateUiServer, ServeRunning, supervise } from "./serve.ts";
import { ReadingsRef, uiServerOn } from "./ui-server.ts";

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

  test("after a clean return, the ref and state.json hold the newest of many consecutive readings", async () => {
    const dir = scratch();
    const path = join(dir, "state.json");
    const count = 20;
    try {
      const ref = await Effect.runPromise(
        Effect.gen(function* () {
          const readings = yield* emptyReadings();
          // Each reading is set and then yields, so the subscriber falls behind
          // the host and the final publish races its queued older readings.
          const build = Effect.gen(function* () {
            const state = yield* SubscriptionRef.make<FleetState>(EMPTY_FLEET);
            const run = Effect.forEach(
              Array.from({ length: count }, (_, i) => i + 1),
              (i) =>
                SubscriptionRef.set(state, {
                  ...EMPTY_FLEET,
                  observedAt: DateTime.makeUnsafe(i),
                }).pipe(Effect.andThen(Effect.yieldNow)),
            ).pipe(Effect.asVoid);
            return { state, run };
          });
          yield* supervise(build, path, readings);
          return yield* SubscriptionRef.get(readings);
        }).pipe(Effect.provide(BunServices.layer)),
      );
      const newest = DateTime.formatIso(DateTime.makeUnsafe(count));
      expect(ref.observedAt).toBe(newest);
      expect(JSON.parse(readFileSync(path, "utf8")).observedAt).toBe(newest);
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

describe("UI server beside supervise", () => {
  test("a page that does not build stops only the UI server; the dispatcher side still runs", async () => {
    const dir = scratch();
    const path = join(dir, "state.json");
    const broken = join(dir, "broken-page.tsx");
    writeFileSync(broken, "this is not a module {{{");
    const store = scratchStore();
    process.env["XDG_CONFIG_HOME"] = dir;
    try {
      await Effect.runPromise(
        seed(`
          INSERT INTO pools (pool, harness, provider_default) VALUES ('Pool', 'pi', 'prov');
          INSERT INTO models (model, provider, pool, harness, limit_scope) VALUES ('m1', 'prov', 'Pool', 'pi', 'pool');
          INSERT INTO ladder (rank, level, rung, model) VALUES (1, 1, 'cheap', 'm1');
        `).pipe(Effect.provide(store.layer)),
      );
      const handlers = Layer.mergeAll(
        Records.layer,
        Layer.succeed(
          Settings,
          Settings.of({
            ladder: [
              {
                name: "cheap",
                harness: "test",
                level: 0,
                model: undefined,
                provider: undefined,
                enabled: true,
                author: true,
                unmetered: false,
              },
            ] satisfies Ladder,
            reviewers: [],
            otlpEndpoint: "http://localhost:4318",
            pollInterval: 60,
            staleAfter: 24,
            coachWindow: 60,
            stallGrace: 5,
            landedWindow: 7,
            attemptsPerLevel: 2,
          }),
        ),
        Repository.Default,
        Layer.succeed(
          Fleet,
          Fleet.of({
            open: () => Effect.fail(new FleetError({ operation: "open", detail: "unused" })),
            attach: () => Effect.fail(new FleetError({ operation: "attach", detail: "unused" })),
            spawn: () => Effect.fail(new FleetError({ operation: "spawn", detail: "unused" })),
            roster: Effect.succeed([] as ReadonlyArray<Worker>),
            awaitTurn: () => Effect.void,
            spaces: Effect.succeed([] as ReadonlyArray<string>),
            say: () => Effect.void,
            screen: () => Effect.succeedNone,
            preview: () => Effect.succeed("preview"),
            focus: () => Effect.void,
            stop: () => Effect.void,
            close: () => Effect.void,
            notify: () => Effect.void,
            inWorker: Effect.succeed(false),
          }),
        ),
      ).pipe(Layer.provideMerge(BunServices.layer), Layer.provideMerge(store.registry));

      const builds = await Effect.runPromise(
        Effect.gen(function* () {
          const builds = yield* Ref.make(0);
          const readings = yield* emptyReadings();
          // Same composition serve uses: UI fiber beside supervise, wrapped in
          // isolateUiServer. Broken entry makes Bun.build fail; the dispatcher
          // fiber still completes and writes state.json.
          yield* Effect.forkChild(
            isolateUiServer(
              Layer.launch(
                uiServerOn(17345, { entrypoint: broken }).pipe(
                  Layer.provide(Layer.mergeAll(Layer.succeed(ReadingsRef, readings), handlers)),
                ),
              ),
            ),
          );
          yield* supervise(fakeHost(0, builds), path, readings);
          return yield* Ref.get(builds);
        }).pipe(Effect.provide(BunServices.layer)),
      );
      expect(builds).toBe(1);
      const published = JSON.parse(readFileSync(path, "utf8"));
      expect(published.dispatcher).toEqual({ state: "idle" });
    } finally {
      store.cleanup();
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
