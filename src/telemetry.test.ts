import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Settings } from "./config.ts";
import { telemetry } from "./telemetry.ts";

/**
 * Port 1 is not listening, so every export is refused at once. That is the
 * cheap half of "unreachable"; the expensive half — a host that accepts and
 * never answers — cannot block a tick either, because the export never runs on
 * the fiber that asked for the span.
 */
const DEAD = "http://127.0.0.1:1";

const settingsWith = (otlpEndpoint: string) =>
  Layer.succeed(Settings, {
    projects: [{ name: "test", directory: "/repo", verify: undefined }],
    ladder: [{ name: "cheap", harness: "test", model: undefined, provider: undefined }],
    otlpEndpoint,
    pollInterval: 60,
    staleAfter: 24,
    coachWindow: 60,
    landedWindow: 7,
    attemptsPerRung: 2,
  });

const withTelemetry = <A>(endpoint: string, work: Effect.Effect<A>) =>
  work.pipe(Effect.scoped, Effect.provide(telemetry.pipe(Layer.provide(settingsWith(endpoint)))));

describe("telemetry", () => {
  test("a collector that refuses every export neither fails nor delays the work under it", async () => {
    const elapsed = await Effect.runPromise(
      withTelemetry(
        DEAD,
        Effect.gen(function* () {
          const started = yield* Effect.sync(() => Date.now());
          const result = yield* Effect.succeed(42).pipe(
            Effect.withSpan("dispatch", { attributes: { rung: "cheap" } }),
          );
          expect(result).toBe(42);
          return Date.now() - started;
        }),
      ),
    );

    // Timed inside the scope on purpose. A tick's cost is what it waits for
    // while running, and the export is not on this fiber — a regression that
    // put it there would spend a connection refusal here instead.
    expect(elapsed).toBeLessThan(100);
  });

  test("shutdown against a dead collector is bounded, not a hang", async () => {
    const started = Date.now();
    await Effect.runPromise(withTelemetry(DEAD, Effect.void.pipe(Effect.withSpan("dispatch"))));

    // Closing the scope flushes what is buffered, and against a refused
    // endpoint that flush spends the exporter's whole shutdown budget. So
    // quitting the dashboard costs a few seconds per signal — bounded, which is
    // the property that matters, but not free.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test("the span is real, so the previous test is not passing on a layer that does nothing", async () => {
    const name = await Effect.runPromise(
      withTelemetry(
        DEAD,
        Effect.currentSpan.pipe(
          Effect.map((span) => span.name),
          Effect.orElseSucceed(() => "no span"),
          Effect.withSpan("dispatch"),
        ),
      ),
    );

    expect(name).toBe("dispatch");
  });
});
