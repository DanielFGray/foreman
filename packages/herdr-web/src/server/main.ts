// The bridge: serves the page from dist/ and the Api over a WebSocket at
// /rpc, on loopback only, behind the Host/Origin guard.
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Effect, Inspectable, Layer, Match, Option, Schedule, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Hc } from "../hc/Hc.ts"
import type { HcFailure } from "../hc/Connection.ts"
import { Api, BridgeError } from "../shared/Api.ts"
import { InputBox } from "../shared/Chat.ts"
import { guard, Host } from "./Access.ts"
import { ClaudeChat, type NoTranscript } from "./claude/ClaudeChat.ts"
import { ClaudeCommands } from "./claude/Commands.ts"
import { inputBoxOf, refusal } from "./claude/InputBox.ts"
import { asks, keyFor, questionOnScreen } from "./claude/Menu.ts"
import { FleetModel } from "./FleetModel.ts"
import { FontRoutes, Fonts } from "./Fonts.ts"
import { HerdrApp, type HerdrAppError } from "./HerdrApp.ts"
import { type WorktreeError, Worktrees } from "./Worktrees.ts"
import { LiveTerminals } from "./LiveTerminals.ts"
import { ScreenCells } from "./ScreenCells.ts"
import { Usage } from "./usage/Usage.ts"

const toBridgeError = (error: HcFailure) =>
  Match.valueTags(error, {
    HcError: ({ kind, message }) => new BridgeError({ kind, message }),
    HcLost: ({ cause }) => new BridgeError({ kind: "lost", message: `hc is not reachable: ${Inspectable.toStringUnknown(cause, 0)}` }),
    HcProtocolError: ({ cause }) => new BridgeError({ kind: "protocol", message: `unreadable reply from hc: ${Inspectable.toStringUnknown(cause, 0)}` }),
  })

/** How often, and how many times, a screen is read again while Claude Code redraws it. */
const REDRAW = { schedule: Schedule.spaced("200 millis"), times: 10 }

const INPUT_BOX_POLL = "1 second"

const sameInputBox = Schema.toEquivalence(InputBox)

const toAppError = (error: HerdrAppError | WorktreeError | HcFailure) =>
  error._tag === "HerdrAppError"
    ? new BridgeError({ kind: "herdr-app", message: error.message })
    : error._tag === "WorktreeError"
      ? new BridgeError({ kind: "git", message: error.message })
      : toBridgeError(error)

const transcriptError = (error: NoTranscript | PlatformError) =>
  new BridgeError({
    kind: "transcript",
    message: Match.valueTags(error, {
      NoTranscript: ({ reason }) => reason,
      PlatformError: ({ message }) => `the transcript cannot be read: ${message}`,
    }),
  })

const Handlers = Api.toLayer(
  Effect.gen(function* () {
    const hc = yield* Hc
    const fleet = yield* FleetModel
    const claude = yield* ClaudeChat
    const live = yield* LiveTerminals
    const app = yield* HerdrApp
    const worktrees = yield* Worktrees
    const commands = yield* ClaudeCommands
    const fonts = yield* Fonts
    const usage = yield* Usage
    const screens = yield* ScreenCells
    const inputBox = (terminal: string) => Effect.map(screens.read(terminal), inputBoxOf)
    // The process whose transcript a terminal's chat and model are read from.
    const claudePid = (terminal: string) =>
      hc.get(terminal).pipe(
        Effect.mapError(toBridgeError),
        Effect.flatMap(({ foreground }) =>
          Effect.fromOption(foreground).pipe(Effect.mapError(() => new BridgeError({ kind: "transcript", message: "no program runs in this terminal" }))),
        ),
        Effect.map(({ pid }) => pid),
      )
    return {
      watch: () => fleet.changes,
      chat: ({ terminal }) => Stream.unwrap(Effect.map(claudePid(terminal), (pid) => Stream.mapError(claude.chat(pid), transcriptError))),
      model: ({ terminal }) => Stream.unwrap(Effect.map(claudePid(terminal), (pid) => Stream.mapError(claude.model(pid), transcriptError))),
      send: ({ terminal, text, whileWorking }) =>
        Effect.all([hc.get(terminal), inputBox(terminal)], { concurrency: 2 }).pipe(
          Effect.mapError(toBridgeError),
          Effect.flatMap(([{ status }, box]) =>
            Option.match(refusal(box, status, whileWorking), {
              onNone: () => hc.send(terminal, text).pipe(Effect.asVoid, Effect.mapError(toBridgeError)),
              onSome: (refused) => Effect.fail(new BridgeError(refused)),
            }),
          ),
        ),
      // Polled: hc reports no event when a screen changes.
      inputBox: ({ terminal }) =>
        Stream.fromEffectSchedule(inputBox(terminal), Schedule.spaced(INPUT_BOX_POLL)).pipe(Stream.changesWith(sameInputBox), Stream.mapError(toBridgeError)),
      keys: ({ terminal, keys }) => hc.keys(terminal, keys).pipe(Effect.asVoid, Effect.mapError(toBridgeError)),
      // The status turns blocked a moment before Claude Code draws the menu.
      question: ({ terminal }) =>
        hc.screen(terminal).pipe(
          Effect.map(questionOnScreen),
          Effect.repeat({ ...REDRAW, until: Option.isSome }),
          Effect.mapError(toBridgeError),
        ),
      answer: ({ terminal, question, answer }) =>
        hc.screen(terminal).pipe(
          Effect.map((screen) => keyFor(screen, question, answer)),
          Effect.mapError(toBridgeError),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new BridgeError({ kind: "moved-on", message: "the agent no longer asks this" })),
              // Answered once the screen moves on, so the page's next read finds
              // what the agent asks now. Past the bound the key was still
              // pressed, so a slow or failed read does not fail the answer.
              onSome: (key) =>
                hc.keys(terminal, [key]).pipe(
                  // The key opened the text field under the menu; the text goes there.
                  Effect.andThen(Match.valueTags(answer, { Picked: () => Effect.void, Typed: ({ text }) => Effect.asVoid(hc.answer(terminal, text)) })),
                  Effect.mapError(toBridgeError),
                  Effect.andThen(hc.screen(terminal).pipe(Effect.repeat({ ...REDRAW, until: (screen) => !asks(screen, question) }), Effect.ignore)),
                ),
            }),
          ),
        ),
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
      commands: ({ terminal }) =>
        hc.get(terminal).pipe(
          Effect.mapError(toBridgeError),
          Effect.flatMap(({ cwd }) => commands.list(terminal, cwd).pipe(Effect.mapError(({ message }) => new BridgeError({ kind: "commands", message })))),
        ),
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
  Layer.provide([ClaudeChat.layer, ClaudeCommands.layer, LiveTerminals.layer, ScreenCells.layer, Worktrees.layer.pipe(Layer.provideMerge(HerdrApp.layer)), Fonts.layer, Usage.layer]),
  // The handlers and the live terminals read the same fleet.
  Layer.provideMerge(FleetModel.layer),
  Layer.provide([Hc.layer, BunServices.layer, FetchHttpClient.layer]),
)

BunRuntime.runMain(Layer.launch(Bridge))
