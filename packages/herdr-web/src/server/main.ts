// The bridge: serves the page from dist/ and the Api over a WebSocket at
// /rpc, on loopback only, behind the Host/Origin guard.
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Effect, Layer, Option, Stream, String } from "effect"
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Hc } from "../hc/Hc.ts"
import type { HcFailure } from "../hc/Connection.ts"
import { Api, BridgeError } from "../shared/Api.ts"
import { guard, Host } from "./Access.ts"
import { Agents } from "./Agents.ts"
import { ClaudeChat } from "./claude/ClaudeChat.ts"
import { ClaudeCommands } from "./claude/Commands.ts"
import { FleetModel } from "./FleetModel.ts"
import { FontRoutes, Fonts } from "./Fonts.ts"
import { toBridgeError } from "./hcError.ts"
import { HerdrApp, type HerdrAppError } from "./HerdrApp.ts"
import { type WorktreeError, Worktrees } from "./Worktrees.ts"
import { LiveTerminals } from "./LiveTerminals.ts"
import { ScreenCells } from "./ScreenCells.ts"
import { Usage } from "./usage/Usage.ts"

const toAppError = (error: HerdrAppError | WorktreeError | HcFailure) =>
  error._tag === "HerdrAppError"
    ? new BridgeError({ kind: "herdr-app", message: error.message })
    : error._tag === "WorktreeError"
      ? new BridgeError({ kind: "git", message: error.message })
      : toBridgeError(error)

const Handlers = Api.toLayer(
  Effect.gen(function* () {
    const hc = yield* Hc
    const fleet = yield* FleetModel
    const agents = yield* Agents
    const live = yield* LiveTerminals
    const app = yield* HerdrApp
    const worktrees = yield* Worktrees
    const fonts = yield* Fonts
    const usage = yield* Usage
    return {
      watch: () => fleet.changes,
      chat: ({ terminal }) => Stream.unwrap(Effect.map(agents.use(terminal, "chat"), ({ terminal, implementation }) => implementation(terminal))),
      model: ({ terminal }) => Stream.unwrap(Effect.map(agents.use(terminal, "model"), ({ terminal, implementation }) => implementation.watch(terminal))),
      pickModel: ({ terminal, alias }) => Effect.flatMap(agents.use(terminal, "model"), ({ terminal, implementation }) => implementation.pick(terminal, alias)),
      send: ({ terminal, text, whileWorking, replaces }) =>
        agents.find(terminal, "inputBox").pipe(
          Effect.flatMap(({ terminal, implementation }) =>
            Option.match(implementation, {
              onNone: () => Effect.succeedNone,
              // A box that no longer holds the page's own text keeps it, and the refusal names it.
              onSome: ({ refusal, write }) =>
                Option.match(Option.filter(replaces, String.isNonEmpty), {
                  onNone: () => Effect.void,
                  onSome: (own) => write(terminal, own, "").pipe(Effect.asVoid, Effect.catchIf(({ kind }) => kind === "changed", () => Effect.void)),
                }).pipe(Effect.andThen(refusal(terminal, whileWorking))),
            }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () => hc.send(terminal, text).pipe(Effect.asVoid, Effect.mapError(toBridgeError)),
              onSome: Effect.fail,
            }),
          ),
        ),
      inputBox: ({ terminal }) => Stream.unwrap(Effect.map(agents.use(terminal, "inputBox"), ({ terminal, implementation }) => implementation.watch(terminal))),
      writeInputBox: ({ terminal, expected, text }) =>
        Effect.flatMap(agents.use(terminal, "inputBox"), ({ terminal, implementation }) => implementation.write(terminal, expected, text)),
      keys: ({ terminal, keys }) => hc.keys(terminal, keys).pipe(Effect.asVoid, Effect.mapError(toBridgeError)),
      question: ({ terminal }) => Effect.flatMap(agents.use(terminal, "questions"), ({ terminal, implementation }) => implementation.read(terminal)),
      answer: ({ terminal, question, answer }) =>
        Effect.flatMap(agents.use(terminal, "questions"), ({ terminal, implementation }) => implementation.answer(terminal, question, answer)),
      attach: ({ terminal, as }) => live.attach(terminal, as).pipe(Stream.mapError(toBridgeError)),
      input: ({ session, data }) => live.input(session, data).pipe(Effect.mapError(toBridgeError)),
      resize: ({ session, cols, rows }) => live.resize(session, cols, rows).pipe(Effect.mapError(toBridgeError)),
      split: ({ pane, direction }) =>
        app.split(pane, direction).pipe(Effect.map(({ terminal }) => ({ terminal })), Effect.mapError(toAppError)),
      closePane: ({ pane }) => app.close(pane).pipe(Effect.asVoid, Effect.mapError(toAppError)),
      newTab: ({ space }) => app.newTab(space).pipe(Effect.map(({ tab }) => ({ tab })), Effect.mapError(toAppError)),
      closeTab: ({ tab }) => app.closeTab(tab).pipe(Effect.asVoid, Effect.mapError(toAppError)),
      moveSpace: ({ space, onto }) => app.moveSpace(space, onto).pipe(Effect.asVoid, Effect.mapError(toAppError)),
      newSpace: ({ machine, folder, name, program }) =>
        app.newSpace({ on: machine, folder, name, program }).pipe(Effect.map(({ tab }) => ({ tab })), Effect.mapError(toAppError)),
      renameSpace: ({ space, name }) => app.renameSpace(space, name).pipe(Effect.mapError(toAppError)),
      closeSpace: ({ space }) => app.closeSpace(space).pipe(Effect.asVoid, Effect.mapError(toAppError)),
      commands: ({ terminal }) => Effect.flatMap(agents.use(terminal, "commands"), ({ terminal, implementation }) => implementation(terminal)),
      worktrees: ({ space }) => worktrees.list(space).pipe(Effect.mapError(toAppError)),
      newWorktree: ({ space, branch, program }) => worktrees.create(space, branch, program).pipe(Effect.map(({ tab }) => ({ tab })), Effect.mapError(toAppError)),
      openWorktree: ({ space, path }) => worktrees.open(space, path).pipe(Effect.map(({ tab }) => ({ tab })), Effect.mapError(toAppError)),
      removeWorktree: ({ space, path }) => worktrees.remove(space, path).pipe(Effect.mapError(toAppError)),
      fonts: () => Effect.succeed(fonts.families),
      usage: () => usage.changes,
      refreshUsage: ({ provider }) => usage.refresh(provider),
    }
  }),
)

const Port = Config.Int("HERDR_WEB_PORT").pipe(Config.withDefault(4180))

const Bridge = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Host
    const port = yield* Port
    const app = Layer.mergeAll(
      RpcServer.layerHttp({ group: Api, path: "/rpc", protocol: "websocket" }).pipe(
        Layer.provide([Handlers, RpcSerialization.layerJson]),
      ),
      HttpStaticServer.layer({ root: `${import.meta.dir}/../../dist`, index: "index.html" }),
      FontRoutes,
      guard(host, port),
    )
    return HttpRouter.serve(app).pipe(Layer.provide(BunHttpServer.layer({ hostname: host, port })))
  }),
).pipe(
  Layer.provide([
    // The agents paste into the box through the live terminals.
    Agents.layer.pipe(Layer.provide([ClaudeChat.layer, ClaudeCommands.layer, ScreenCells.layer]), Layer.provideMerge(LiveTerminals.layer)),
    Worktrees.layer.pipe(Layer.provideMerge(HerdrApp.layer)), Fonts.layer, Usage.layer]),
  // The handlers and the live terminals read the same fleet.
  Layer.provideMerge(FleetModel.layer),
  Layer.provide([Hc.layer, BunServices.layer, FetchHttpClient.layer]),
)

BunRuntime.runMain(Layer.launch(Bridge))
