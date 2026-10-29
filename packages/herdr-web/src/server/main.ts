// The bridge: serves the page from dist/ and the Api over a WebSocket at
// /rpc, on loopback only, behind the Host/Origin guard.
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Inspectable, Layer, Match } from "effect"
import { HttpRouter, HttpStaticServer } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Hc } from "../hc/Hc.ts"
import type { HcFailure } from "../hc/Connection.ts"
import { Api, BridgeError } from "../shared/Api.ts"
import { guard, LOOPBACK } from "./Access.ts"
import { FleetModel } from "./FleetModel.ts"

const toBridgeError = (error: HcFailure) =>
  Match.valueTags(error, {
    HcError: ({ kind, message }) => new BridgeError({ kind, message }),
    HcLost: ({ cause }) => new BridgeError({ kind: "lost", message: `hc is not reachable: ${Inspectable.toStringUnknown(cause, 0)}` }),
    HcProtocolError: ({ cause }) => new BridgeError({ kind: "protocol", message: `unreadable reply from hc: ${Inspectable.toStringUnknown(cause, 0)}` }),
  })

const Handlers = Api.toLayer(
  Effect.gen(function* () {
    const hc = yield* Hc
    const fleet = yield* FleetModel
    return {
      watch: () => fleet.changes,
      read: ({ terminal, lines }) =>
        hc.read(terminal, lines).pipe(
          Effect.map(({ text }) => ({ text })),
          Effect.mapError(toBridgeError),
        ),
      send: ({ terminal, text }) => hc.send(terminal, text).pipe(Effect.asVoid, Effect.mapError(toBridgeError)),
      keys: ({ terminal, keys }) => hc.keys(terminal, keys).pipe(Effect.asVoid, Effect.mapError(toBridgeError)),
    }
  }),
)

const Port = Config.Int("HERDR_WEB_PORT").pipe(Config.withDefault(4180))

const Bridge = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Port
    const app = Layer.mergeAll(
      RpcServer.layerHttp({ group: Api, path: "/rpc", protocol: "websocket" }).pipe(
        Layer.provide([Handlers, RpcSerialization.layerJson]),
      ),
      HttpStaticServer.layer({ root: `${import.meta.dir}/../../dist`, index: "index.html" }),
      guard(port),
    )
    return HttpRouter.serve(app).pipe(Layer.provide(BunHttpServer.layer({ hostname: LOOPBACK, port })))
  }),
).pipe(Layer.provide(FleetModel.layer), Layer.provide(Hc.layer))

BunRuntime.runMain(Layer.launch(Bridge))
