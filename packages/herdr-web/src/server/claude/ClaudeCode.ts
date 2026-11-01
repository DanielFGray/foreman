// Claude Code's adapter: its chat and model from its transcript, its todo
// list from its task files, its input box and questions from its screen, and
// its slash commands from its folders.
import { Array, Effect, Match, Option, Schedule, Schema as S, Stream, String } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Hc } from "../../hc/Hc.ts"
import { BridgeError } from "../../shared/Api.ts"
import { type Answer, InputBox, modelName, type Question, sameTyped, typedText } from "../../shared/Chat.ts"
import type { ModelChoice, ModelChoices } from "../../shared/Harness.ts"
import type { Terminal } from "../../shared/Fleet.ts"
import { toBridgeError } from "../hcError.ts"
import { localOf } from "../HerdrApp.ts"
import { LiveTerminals } from "../LiveTerminals.ts"
import { ScreenCells } from "../ScreenCells.ts"
import { ClaudeChat, type NoTranscript } from "./ClaudeChat.ts"
import { ClaudeCommands } from "./Commands.ts"
import { boxOnScreen, EMPTYING, INSERT, inputBoxOf, pasted, refusal } from "./InputBox.ts"
import { asks, keyFor, questionOnScreen } from "./Menu.ts"

export const claudeCode = Effect.gen(function* () {
  const hc = yield* Hc
  const claude = yield* ClaudeChat
  const commands = yield* ClaudeCommands
  const screens = yield* ScreenCells
  const live = yield* LiveTerminals

  // While the agent is blocked, a question or permission is drawn in the box's
  // place, in layouts the menu reader may not know. Claude Code reports it to
  // hc with the same frame, so the current status rules first; a watch holds
  // the terminal as it was, so the status is asked again each time.
  const inputBox = ({ address }: Terminal) =>
    Effect.flatMap(hc.get(address), ({ status }) =>
      Option.exists(status, ({ state }) => state === "blocked") ? Effect.succeed<InputBox>({ _tag: "Absent" }) : Effect.map(screens.read(address), inputBoxOf),
    )
  const refused = (terminal: Terminal, whileWorking: boolean) =>
    Effect.map(Effect.mapError(inputBox(terminal), toBridgeError), (box) =>
      Option.map(refusal(box, terminal.status, whileWorking), (why) => new BridgeError(why)),
    )
  /**
   * Replaces the box's text with `text`, when the box still holds `expected`:
   * empties the box a line per round, reading it after each, then pastes
   * `text` and reads the box again once it shows. A paste Claude Code folds
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
    // Typed as a viewer types: hc's keys would wait about 3 s after each earlier write.
    const type = (keys: string) => Effect.mapError(live.type(terminal.address, terminal, keys), toBridgeError)
    const read = Effect.mapError(inputBox(terminal), toBridgeError)
    yield* type(INSERT)
    // A round Claude Code applies to a stale box deletes nothing, so a few rounds spare.
    const emptied = yield* type(EMPTYING).pipe(
      Effect.andThen(Effect.sleep(ROUND_GAP)),
      Effect.andThen(read),
      Effect.repeat({ until: isEmptyBox, times: 2 * rows.value + SPARE_ROUNDS }),
    )
    if (!isEmptyBox(emptied)) {
      return yield* new BridgeError({ kind: "changed", message: "the page could not empty the agent's input box" })
    }
    if (String.isEmpty(text)) {
      return emptied
    }
    yield* type(pasted(text))
    return yield* read.pipe(
      Effect.repeat({ ...REDRAW, until: (after) => after._tag === "Partial" || Option.exists(typedText(after), (typed) => sameTyped(typed, text)) }),
    )
  })
  // The process whose transcript the chat and the model are read from.
  // Claude Code's files are on the agent's own machine, and a pid names a process only there.
  const fromTranscript = <A>(terminal: Terminal, read: (pid: number) => Stream.Stream<A, NoTranscript | PlatformError>) =>
    Option.isSome(localOf(terminal.address).on)
      ? Stream.fail(new BridgeError({ kind: "remote", message: "the bridge reads Claude Code's files only on its own machine" }))
      : Option.match(terminal.foreground, {
          onNone: () => Stream.fail(new BridgeError({ kind: "transcript", message: "no program runs in this terminal" })),
          onSome: ({ pid }) => Stream.mapError(read(pid), transcriptError),
        })

  return {
    chat: (terminal: Terminal) => fromTranscript(terminal, claude.chat),
    todos: (terminal: Terminal) => fromTranscript(terminal, claude.todos),
    model: {
      watch: (terminal: Terminal) => fromTranscript(terminal, claude.model),
      // The current choice is the one whose family names the model of the newest reply.
      choices: (terminal: Terminal) =>
        Effect.map(Stream.runHead(fromTranscript(terminal, claude.model)), (model): ModelChoices => ({
          choices: MODEL_CHOICES,
          current: Option.map(
            Array.findFirst(MODEL_CHOICES, ({ name }) => Option.exists(Option.flatten(model), (id) => String.startsWith(`${name} `)(modelName(id)))),
            ({ alias }) => alias,
          ),
          note: "Claude Code may also keep the pick for its new sessions.",
        })),
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

// Each alias picks that family's latest, newest family first.
const MODEL_CHOICES: ReadonlyArray<ModelChoice> = [
  { alias: "fable", name: "Fable" },
  { alias: "opus", name: "Opus" },
  { alias: "sonnet", name: "Sonnet" },
  { alias: "haiku", name: "Haiku" },
]

/** How often, and how many times, a screen is read again while Claude Code redraws it. */
const REDRAW = { schedule: Schedule.spaced("200 millis"), times: 10 }

/** The pause after a round of emptying the box, for Claude Code to apply it before the box is read. */
const ROUND_GAP = "50 millis"
const SPARE_ROUNDS = 4

const isEmptyBox = (box: InputBox) => Option.exists(typedText(box), String.isEmpty)

const INPUT_BOX_POLL = "1 second"

const sameInputBox = S.toEquivalence(InputBox)

const transcriptError = (error: NoTranscript | PlatformError) =>
  new BridgeError({
    kind: "transcript",
    message: Match.valueTags(error, {
      NoTranscript: ({ reason }) => reason,
      PlatformError: ({ message }) => `the transcript cannot be read: ${message}`,
    }),
  })
