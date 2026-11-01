import { BunServices } from "@effect/platform-bun"
import { DateTime, Effect, Layer, Option, Ref, Result, Schema as S, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { EMPTY_FLEET, type FleetState } from "foreman"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { ForemanCommand, type ForemanState } from "../shared/Foreman.ts"
import { Foreman, ForemanHost } from "./Foreman.ts"

// foreman reads where to publish and where its policy lives from the
// environment, so each points into a folder of the test's own.
const folder = mkdtempSync(join(tmpdir(), "herdr-web-foreman-"))
const saved = { state: process.env["FOREMAN_STATE"], policy: process.env["FOREMAN_POLICY"] }
process.env["FOREMAN_STATE"] = join(folder, "state.json")
process.env["FOREMAN_POLICY"] = join(folder, "policy.json")
afterAll(() => {
  rmSync(folder, { recursive: true, force: true })
  const restored: ReadonlyArray<readonly [string, string | undefined]> = [["FOREMAN_STATE", saved.state], ["FOREMAN_POLICY", saved.policy]]
  for (const [name, value] of restored) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/** A dispatcher whose first start dies, and whose second reads the world once and runs on. */
const failingOnce = Effect.gen(function* () {
  const starts = yield* Ref.make(0)
  const state = yield* SubscriptionRef.make<FleetState>(EMPTY_FLEET)
  const host = {
    state,
    run: SubscriptionRef.set(state, { ...EMPTY_FLEET, observedAt: DateTime.makeUnsafe(Date.parse("2026-10-30T01:00:00Z")) }).pipe(Effect.andThen(Effect.never)),
    wake: Effect.void,
    queue: () => Effect.succeed([]),
  }
  const build = Ref.getAndUpdate(starts, (n) => n + 1).pipe(Effect.flatMap((n) => (n === 0 ? Effect.die("prog: command not found") : Effect.succeed(host))))
  return Layer.succeed(ForemanHost, { build })
})

const until = (foreman: Foreman["Service"], shown: (state: ForemanState) => boolean) => foreman.changes.pipe(Stream.filter(shown), Stream.runHead)

const dispatcherOf = (state: ForemanState) => Option.map(state.reading, ({ dispatcher }) => dispatcher.state)

describe("the supervised dispatcher", () => {
  test("a dispatcher that dies shows as failed, starts again after a pause, and the bridge serves throughout", async () => {
    await Effect.gen(function* () {
      const host = yield* failingOnce
      yield* Effect.gen(function* () {
        const foreman = yield* Foreman

        const failed = yield* until(foreman, (state) => Option.contains(dispatcherOf(state), "failed"))
        expect(Option.flatMap(failed, ({ reading }) => reading).pipe(Option.map(({ dispatcher }) => dispatcher))).toEqual(
          Option.some({ state: "failed", detail: expect.stringContaining("prog: command not found") }),
        )
        // The panel reads the same state from the file.
        expect(JSON.parse(readFileSync(join(folder, "state.json"), "utf8")).dispatcher.state).toBe("failed")
        // While it waits to start again, the queue says so instead of hanging.
        const queue = yield* Effect.flip(foreman.queue(Option.none()))
        expect(queue.message).toBe("foreman's dispatcher is not running")

        yield* TestClock.adjust("1 second")
        // No step is on in a missing policy file, so the restarted dispatcher only reads.
        yield* until(foreman, (state) => Option.contains(dispatcherOf(state), "idle"))
        expect(JSON.parse(readFileSync(join(folder, "state.json"), "utf8")).dispatcher.state).toBe("idle")
        expect(yield* foreman.queue(Option.none())).toEqual([])
      }).pipe(Effect.provide(Foreman.layer.pipe(Layer.provide([host, BunServices.layer]))))
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise)
  })
})

test("a command refuses a name foreman would read as an option", () => {
  const decode = S.decodeUnknownResult(ForemanCommand)
  expect(Result.isFailure(decode({ _tag: "Act", action: "kill", key: "--all" }))).toBe(true)
  expect(Result.isSuccess(decode({ _tag: "Act", action: "kill", key: "ts-1a2b" }))).toBe(true)
})
