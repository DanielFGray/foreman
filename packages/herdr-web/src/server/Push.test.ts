import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, FileSystem, Layer, Ref, Stream } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import webpush from "web-push"
import { FleetModel } from "./FleetModel.ts"
import { Push } from "./Push.ts"

// A made-up device: any P-256 public key will do for the encryption, and a 16-byte secret.
const device = { endpoint: "https://push.example/device-1", keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }

/**
 * Runs `use` with a Push service whose config folder is a new temporary
 * folder and whose push service answers every post with `status`. Gives what
 * `use` gave, the requests posted, and the folder's files as they ended up.
 */
const withPush = <A, E>(status: number, use: (push: typeof Push.Service, folder: string) => Effect.Effect<A, E, FileSystem.FileSystem>, setup: (folder: string) => Effect.Effect<void, never, FileSystem.FileSystem> = () => Effect.void) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const config = yield* fs.makeTempDirectoryScoped()
    const folder = `${config}/herdr-web`
    yield* setup(folder)
    const posted = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([])
    const client = HttpClient.make((request) => Effect.as(Ref.update(posted, (all) => [...all, request]), HttpClientResponse.fromWeb(request, new Response(null, { status }))))
    const layer = Push.layer.pipe(
      Layer.provide([
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(FleetModel, { get: Effect.die("unused"), changes: Stream.empty }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: config })),
      ]),
    )
    const result = yield* Effect.flatMap(Push, (push) => use(push, folder)).pipe(Effect.provide(layer))
    return { result, posted: yield* Ref.get(posted) }
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise)

describe("Push", () => {
  test("a test alert goes to the device signed and encrypted, and the key it makes is kept, readable by the user alone", async () => {
    const { result, posted } = await withPush(201, (push, folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const key = yield* push.publicKey
        yield* push.test(device)
        return { key, again: yield* push.publicKey, mode: (yield* fs.stat(`${folder}/push-key.json`)).mode & 0o777 }
      }),
    )
    expect(result.again).toBe(result.key)
    expect(result.mode).toBe(0o600)
    expect(posted.map(({ url, method }) => `${method} ${url}`)).toEqual(["POST https://push.example/device-1"])
    expect(posted[0]?.headers).toMatchObject({ "content-encoding": "aes128gcm", urgency: "high" })
    expect(posted[0]?.headers["authorization"]).toMatch(/^vapid t=.+, k=.+$/)
  })

  test("a device its push service no longer knows is forgotten", async () => {
    const { result } = await withPush(410, (push, folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* push.subscribe(device, ["blocked"])
        const before = yield* fs.readFileString(`${folder}/push-subscriptions.json`)
        const failure = yield* Effect.flip(push.test(device))
        return { before, failure: failure.message, after: yield* fs.readFileString(`${folder}/push-subscriptions.json`) }
      }),
    )
    expect(result.before).toContain("device-1")
    expect(result.failure).toBe("push.example no longer knows the device; turn alerts on again there")
    expect(result.after).toBe("[]")
  })

  test("a key file that cannot be read is an error, and stays as it was", async () => {
    const { result } = await withPush(
      201,
      (push, folder) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(push.publicKey)
          return { failure: failure.message, file: yield* (yield* FileSystem.FileSystem).readFileString(`${folder}/push-key.json`) }
        }),
      (folder) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(folder, { recursive: true })
          yield* fs.writeFileString(`${folder}/push-key.json`, "{ not json")
        }).pipe(Effect.orDie),
    )
    expect(result.failure).toMatch(/push-key\.json cannot be read; move it away to make a new key$/)
    expect(result.file).toBe("{ not json")
  })
})
