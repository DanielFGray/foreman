// Claude Code's adapter: its chat and model from its transcript, its input
// box and questions from its screen, and its slash commands from its folders.
import { Effect, Match, Option, Schedule, Schema, Stream, String } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Hc } from "../../hc/Hc.ts"
import { BridgeError } from "../../shared/Api.ts"
import { type Answer, InputBox, type Question, sameTyped, typedText } from "../../shared/Chat.ts"
import type { Terminal } from "../../shared/Fleet.ts"
import { toBridgeError } from "../hcError.ts"
import { LiveTerminals } from "../LiveTerminals.ts"
import { ScreenCells } from "../ScreenCells.ts"
import { ClaudeChat, type NoTranscript } from "./ClaudeChat.ts"
import { ClaudeCommands } from "./Commands.ts"
import { boxOnScreen, clearingKeys, inputBoxOf, refusal } from "./InputBox.ts"
import { asks, keyFor, questionOnScreen } from "./Menu.ts"

export const claudeCode = Effect.gen(function* () {
  const hc = yield* Hc
  const claude = yield* ClaudeChat
  const commands = yield* ClaudeCommands
  const screens = yield* ScreenCells
  const live = yield* LiveTerminals

  const inputBox = ({ address }: Terminal) => Effect.map(screens.read(address), inputBoxOf)
  const refused = (terminal: Terminal, whileWorking: boolean) =>
    Effect.map(Effect.mapError(inputBox(terminal), toBridgeError), (box) =>
      Option.map(refusal(box, terminal.status, whileWorking), (why) => new BridgeError(why)),
    )
  /**
   * Replaces the box's text with `text`, when the box still holds `expected`,
   * and reads the box again once it shows `text`. A paste Claude Code folds
   * never shows; the box is then read for as long as it redraws.
   */
  const write = Effect.fnUntraced(function* (terminal: Terminal, expected: string, text: string) {
    const { box, rows } = boxOnScreen(yield* Effect.mapError(screens.read(terminal.address), toBridgeError))
    if (!Option.exists(typedText(box), (typed) => sameTyped(typed, expected))) {
      return yield* new BridgeError({ kind: "changed", message: "the agent's input box changed in the terminal" })
    }
    if (Option.isNone(rows)) {
      return yield* new BridgeError({ kind: "draft", message: "the agent's input box is taller than its screen, so the page cannot empty it" })
    }
    yield* Effect.mapError(hc.keys(terminal.address, clearingKeys(rows.value)), toBridgeError)
    if (String.isNonEmpty(text)) {
      yield* Effect.mapError(live.paste(terminal.address, terminal, text), toBridgeError)
    }
    return yield* Effect.mapError(inputBox(terminal), toBridgeError).pipe(
      Effect.repeat({ ...REDRAW, until: (after) => after._tag === "Partial" || Option.exists(typedText(after), (typed) => sameTyped(typed, text)) }),
    )
  })
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
      write,
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
