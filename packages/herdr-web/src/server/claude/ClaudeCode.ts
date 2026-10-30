// Claude Code's adapter: its chat and model from its transcript, its input
// box and questions from its screen, and its slash commands from its folders.
import { Effect, Match, Option, Schedule, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Hc } from "../../hc/Hc.ts"
import { BridgeError } from "../../shared/Api.ts"
import { type Answer, InputBox, type Question } from "../../shared/Chat.ts"
import type { Terminal } from "../../shared/Fleet.ts"
import { toBridgeError } from "../hcError.ts"
import { ScreenCells } from "../ScreenCells.ts"
import { ClaudeChat, type NoTranscript } from "./ClaudeChat.ts"
import { ClaudeCommands } from "./Commands.ts"
import { inputBoxOf, refusal } from "./InputBox.ts"
import { asks, keyFor, questionOnScreen } from "./Menu.ts"

export const claudeCode = Effect.gen(function* () {
  const hc = yield* Hc
  const claude = yield* ClaudeChat
  const commands = yield* ClaudeCommands
  const screens = yield* ScreenCells

  const inputBox = ({ address }: Terminal) => Effect.map(screens.read(address), inputBoxOf)
  const refused = (terminal: Terminal, whileWorking: boolean) =>
    Effect.map(Effect.mapError(inputBox(terminal), toBridgeError), (box) =>
      Option.map(refusal(box, terminal.status, whileWorking), (why) => new BridgeError(why)),
    )
  // The process whose transcript the chat and the model are read from.
  const fromTranscript = <A>(terminal: Terminal, read: (pid: number) => Stream.Stream<A, NoTranscript | PlatformError>) =>
    Option.match(terminal.foreground, {
      onNone: () => Stream.fail(new BridgeError({ kind: "transcript", message: "no program runs in this terminal" })),
      onSome: ({ pid }) => Stream.mapError(read(pid), transcriptError),
    })

  return {
    chat: (terminal: Terminal) => fromTranscript(terminal, claude.chat),
    model: {
      watch: (terminal: Terminal) => fromTranscript(terminal, claude.model),
      // Typed as a person would; Claude Code refuses it while the agent works.
      pick: (terminal: Terminal, alias: string) =>
        Effect.flatMap(
          refused(terminal, false),
          Option.match({
            onNone: () => Effect.mapError(Effect.asVoid(hc.send(terminal.address, `/model ${alias}`)), toBridgeError),
            onSome: Effect.fail,
          }),
        ),
    },
    inputBox: {
      // Polled: hc reports no event when a screen changes.
      watch: (terminal: Terminal) =>
        Stream.fromEffectSchedule(inputBox(terminal), Schedule.spaced(INPUT_BOX_POLL)).pipe(Stream.changesWith(sameInputBox), Stream.mapError(toBridgeError)),
      refusal: refused,
    },
    questions: {
      // The status turns blocked a moment before Claude Code draws the menu.
      read: ({ address }: Terminal) =>
        hc.screen(address).pipe(Effect.map(questionOnScreen), Effect.repeat({ ...REDRAW, until: Option.isSome }), Effect.mapError(toBridgeError)),
      answer: ({ address }: Terminal, question: Question, answer: Answer) =>
        hc.screen(address).pipe(
          Effect.map((screen) => keyFor(screen, question, answer)),
          Effect.mapError(toBridgeError),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new BridgeError({ kind: "moved-on", message: "the agent no longer asks this" })),
              // Answered once the screen moves on, so the page's next read finds
              // what the agent asks now. Past the bound the key was still
              // pressed, so a slow or failed read does not fail the answer.
              onSome: (key) =>
                hc.keys(address, [key]).pipe(
                  // The key opened the text field under the menu; the text goes there.
                  Effect.andThen(Match.valueTags(answer, { Picked: () => Effect.void, Typed: ({ text }) => Effect.asVoid(hc.answer(address, text)) })),
                  Effect.mapError(toBridgeError),
                  Effect.andThen(hc.screen(address).pipe(Effect.repeat({ ...REDRAW, until: (screen) => !asks(screen, question) }), Effect.ignore)),
                ),
            }),
          ),
        ),
    },
    commands: ({ address, cwd }: Terminal) =>
      commands.list(address, cwd).pipe(Effect.mapError(({ message }) => new BridgeError({ kind: "commands", message }))),
  }
})

/** How often, and how many times, a screen is read again while Claude Code redraws it. */
const REDRAW = { schedule: Schedule.spaced("200 millis"), times: 10 }

const INPUT_BOX_POLL = "1 second"

const sameInputBox = Schema.toEquivalence(InputBox)

const transcriptError = (error: NoTranscript | PlatformError) =>
  new BridgeError({
    kind: "transcript",
    message: Match.valueTags(error, {
      NoTranscript: ({ reason }) => reason,
      PlatformError: ({ message }) => `the transcript cannot be read: ${message}`,
    }),
  })
