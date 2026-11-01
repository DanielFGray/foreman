import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, Schema as S } from "effect"
import { expect, test } from "vitest"
import { connect, method } from "./Connection.ts"

const status = method("server.status", S.Struct({}), S.Struct({}))

/** A socket in a scratch folder that answers `hello`, then closes, as hc does when it restarts. */
const closingAfterHello = Effect.gen(function* () {
  const folder = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
  const path = `${folder}/hc.sock`
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.listen({
        unix: path,
        socket: {
          data: (socket, data) => {
            const { id } = S.decodeSync(S.fromJsonString(S.Struct({ id: S.String })))(String(data).trim())
            socket.write(`{"jsonrpc":"2.0","id":"${id}","result":{"generation":1}}\n`)
            socket.end()
          },
        },
      }),
    ),
    (server) => Effect.sync(() => server.stop(true)),
  )
  return path
})

test("a call made after hc closed the connection fails, so the caller opens a new one", async () => {
  const result = await Effect.gen(function* () {
    const connection = yield* connect(yield* closingAfterHello, S.Never)
    // Past the close, as a connection kept open between calls finds it.
    yield* Effect.sleep("100 millis")
    return yield* Effect.flip(connection.call(status, {}))
  }).pipe(Effect.scoped, Effect.timeout("2 seconds"), Effect.provide(BunFileSystem.layer), Effect.runPromise)
  expect(result._tag).toBe("HcLost")
})
