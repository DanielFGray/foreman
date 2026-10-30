// The bridge: serves the page from dist/ and the Api over a WebSocket at
// /rpc, on loopback only, behind the Host/Origin guard.
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Effect, Inspectable, Layer, Match, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Hc } from "../hc/Hc.ts"
import type { HcFailure } from "../hc/Connection.ts"
import { Api, BridgeError } from "../shared/Api.ts"
import { guard, LOOPBACK } from "./Access.ts"
import { ClaudeChat, type NoTranscript } from "./claude/ClaudeChat.ts"
import { FleetModel } from "./FleetModel.ts"
import { FontRoutes, Fonts } from "./Fonts.ts"
import { HerdrApp, type HerdrAppError } from "./HerdrApp.ts"
import { LiveTerminals } from "./LiveTerminals.ts"
import { Usage } from "./usage/Usage.ts"

const toBridgeError = (error: HcFailure) =>
  Match.valueTags(error, {
    HcError: ({ kind, message }) => new BridgeError({ kind, message }),
    HcLost: ({ cause }) => new BridgeError({ kind: "lost", message: `hc is not reachable: ${Inspectable.toStringUnknown(cause, 0)}` }),
    HcProtocolError: ({ cause }) => new BridgeError({ kind: "protocol", message: `unreadable reply from hc: ${Inspectable.toStringUnknown(cause, 0)}` }),
  })

const toAppError = ({ message }: HerdrAppError) => new BridgeError({ kind: "herdr-app", message })

const transcriptFailure = (error: NoTranscript | PlatformError) =>
  Match.valueTags(error, {
    NoTranscript: ({ reason }) => reason,
    PlatformError: ({ message }) => `the transcript cannot be read: ${message}`,
  })

const Handlers = Api.toLayer(
  Effect.gen(function* () {
    const hc = yield* Hc
    const fleet = yield* FleetModel
    const claude = yield* ClaudeChat
    const live = yield* LiveTerminals
    const app = yield* HerdrApp
    const fonts = yield* Fonts
    const usage = yield* Usage
    return {
      watch: () => fleet.changes,
      chat: ({ terminal }) =>
        hc.get(terminal).pipe(
          Effect.mapError(toBridgeError),
          Effect.flatMap(({ foreground }) =>
            Effect.fromOption(foreground).pipe(
              Effect.mapError(() => new BridgeError({ kind: "transcript", message: "no program runs in this terminal" })),
            ),
          ),
          Effect.map(({ pid }) =>
            claude.chat(pid).pipe(
              Stream.mapError((error) => new BridgeError({ kind: "transcript", message: transcriptFailure(error) })),
            ),
          ),
          Stream.unwrap,
        ),
      send: ({ terminal, text }) => hc.send(terminal, text).pipe(Effect.asVoid, Effect.mapError(toBridgeError)),
      keys: ({ terminal, keys }) => hc.keys(terminal, keys).pipe(Effect.asVoid, Effect.mapError(toBridgeError)),
      attach: (request) => live.attach(request).pipe(Stream.mapError(toBridgeError)),
      input: ({ session, data }) => live.input(session, data).pipe(Effect.mapError(toBridgeError)),
      resize: ({ session, cols, rows }) => live.resize(session, cols, rows).pipe(Effect.mapError(toBridgeError)),
      split: ({ pane, direction }) =>
        app.split(pane, direction).pipe(Effect.map(({ terminal }) => ({ terminal })), Effect.mapError(toAppError)),
      closePane: ({ pane }) => app.close(pane).pipe(Effect.asVoid, Effect.mapError(toAppError)),
      moveSpace: ({ space, onto }) => app.moveSpace(space, onto).pipe(Effect.asVoid, Effect.mapError(toAppError)),
      fonts: () => Effect.succeed(fonts.families),
      usage: () => usage.changes,
      refreshUsage: ({ provider }) => usage.refresh(provider),
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
      FontRoutes,
      guard(port),
    )
    return HttpRouter.serve(app).pipe(Layer.provide(BunHttpServer.layer({ hostname: LOOPBACK, port })))
  }),
).pipe(
  Layer.provide([FleetModel.layer, ClaudeChat.layer, LiveTerminals.layer, HerdrApp.layer, Fonts.layer, Usage.layer]),
  Layer.provide([Hc.layer, BunServices.layer, FetchHttpClient.layer]),
)

BunRuntime.runMain(Layer.launch(Bridge))
