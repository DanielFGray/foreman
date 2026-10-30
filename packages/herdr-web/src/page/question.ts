// A question a blocked agent waits on, as a card in its chat with a button per
// choice. The bridge reads the question from the agent's screen. The page
// reads it when the agent's status turns blocked, and again after each answer,
// since a series of questions keeps one status. The card shows only while the
// agent still waits under the status it was read under, so an answer from the
// terminal or another device takes it away with the next fleet.
import { Array, Option, Record, Schema, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import type { Terminal } from "../shared/Fleet.ts"
import { AnswerQuestion } from "./commands.ts"
import { type Asked, Asking, Message, type Model, type UpdateReturn } from "./model.ts"
import { lastFleet, openAs } from "./selection.ts"

/** One read of a blocked agent's question. */
export const QuestionRead = Schema.Struct({ address: Schema.String, statusMs: Schema.Int, reads: Schema.Int })
export type QuestionRead = typeof QuestionRead.Type

/** The reads the shown chats need: one per blocked agent, and one more after each answer. */
export const questionReads = (model: Model): ReadonlyArray<QuestionRead> =>
  Array.getSomes(
    Array.map(openAs(model, "Chat"), (address) =>
      Option.map(blockedSince(model, address), (statusMs) => ({
        address,
        statusMs,
        reads: Option.match(current(model, address, statusMs), { onNone: () => 0, onSome: ({ reads }) => reads }),
      })),
    ),
  )

/** Keeps what a read found, under the status it was read under. */
export const readQuestion = (model: Model, address: string, statusMs: number, asking: Asking): Model =>
  modifyFields(model, {
    questions: (all) =>
      Record.set(
        all,
        address,
        Option.match(current(model, address, statusMs), {
          onNone: (): Asked => ({ statusMs, reads: 0, notice: Option.none(), asking }),
          onSome: (asked) => ({ ...asked, asking }),
        }),
      ),
  })

/** Sends the choice, while the card shows it and no other choice is on its way. */
export const chose = (model: Model, address: string, choice: number): UpdateReturn =>
  Option.match(
    Option.flatMap(asked(model, address), ({ asking }) =>
      Asking.match(asking, {
        Shown: ({ question, sending }) =>
          Option.isNone(sending) && Array.some(question.choices, ({ number }) => number === choice) ? Option.some(question) : Option.none(),
        Reading: () => Option.none(),
        Unshown: () => Option.none(),
      }),
    ),
    {
      onNone: () => ({ model }),
      onSome: (question) => ({
        model: withAsking(model, address, Asking.Shown({ question, sending: Option.some(choice) })),
        commands: [AnswerQuestion({ address, question, choice })],
      }),
    },
  )

/** After an answer, taken or refused: the screen is read again, and `notice` says why one was refused. */
export const answered = (model: Model, address: string, notice: Option.Option<string>): Model =>
  changed(model, address, (one) => ({ ...one, reads: one.reads + 1, notice, asking: Asking.Reading() }))

/** The choice a prompt names when its agent waits on a question: its number alone, such as "2". */
export const typedChoice = (model: Model, address: string, text: string): Option.Option<number> =>
  Option.flatMap(asked(model, address), ({ asking }) =>
    Asking.match(asking, {
      Shown: ({ question }) =>
        Option.map(
          Array.findFirst(question.choices, ({ number }) => `${number}` === String.trim(text)),
          ({ number }) => number,
        ),
      Reading: () => Option.none(),
      Unshown: () => Option.none(),
    }),
  )

/** The card for the question the agent at `address` waits on, under its chat. */
export const questionView = (model: Model, address: string, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(
    Option.flatMap(blockedTerminal(model, address), (terminal) => Option.map(asked(model, address), (one) => ({ terminal, ...one }))),
    {
      onNone: () => [],
      onSome: ({ terminal, notice, asking }) => {
        const about = Option.flatMap(terminal.status, ({ msg }) => msg)
        return Asking.match(asking, {
          Reading: () => [],
          Unshown: ({ reason }) => [
            h.p(
              [h.Class("note question-note")],
              [`${Option.getOrElse(about, () => "The agent waits for you")}. Answer it in the terminal${Option.match(reason, { onNone: () => "", onSome: (why) => `: ${why}` })}.`],
            ),
          ],
          Shown: ({ question, sending }) => [
            h.section(
              [h.Class("question"), h.AriaLabel("Question from the agent")],
              [
                ...Option.toArray(Option.map(notice, (text) => h.p([h.Class("note error")], [text]))),
                ...Option.toArray(Option.map(about, (text) => h.p([h.Class("question-about")], [text]))),
                h.p([h.Class("question-text")], [question.text]),
                h.div(
                  [h.Class("choices")],
                  Array.map(question.choices, ({ number, label, detail }) =>
                    h.button(
                      [
                        h.Type("button"),
                        h.Class("choice"),
                        h.AriaLabel(`${number}. ${label}`),
                        h.Disabled(Option.isSome(sending)),
                        h.AriaBusy(Option.contains(sending, number)),
                        h.OnClick(Message.ClickedChoice({ address, choice: number })),
                      ],
                      [
                        h.span([h.Class("choice-number")], [`${number}`]),
                        h.span([h.Class("choice-label")], [label]),
                        ...Option.toArray(Option.map(detail, (text) => h.span([h.Class("choice-detail")], [text]))),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ],
        })
      },
    },
  )

/** The question of the agent at `address`, while it still waits under the status it was read under. */
const asked = (model: Model, address: string): Option.Option<Asked> =>
  Option.flatMap(blockedSince(model, address), (statusMs) => current(model, address, statusMs))

const current = (model: Model, address: string, statusMs: number) =>
  Option.filter(Record.get(model.questions, address), (one) => one.statusMs === statusMs)

const withAsking = (model: Model, address: string, asking: Asking) => changed(model, address, (one) => ({ ...one, asking }))

const changed = (model: Model, address: string, change: (one: Asked) => Asked) =>
  modifyFields(model, { questions: (all) => Option.getOrElse(Record.modify(all, address, change), () => all) })

const blockedTerminal = (model: Model, address: string): Option.Option<Terminal> =>
  Option.flatMap(lastFleet(model.bridge), ({ terminals }) =>
    Array.findFirst(terminals, (terminal) => terminal.address === address && Option.exists(terminal.status, ({ state }) => state === "blocked")),
  )

/** When the agent at `address` began to wait, while it does. */
const blockedSince = (model: Model, address: string): Option.Option<number> =>
  Option.flatMap(blockedTerminal(model, address), ({ status_ms }) => status_ms)
