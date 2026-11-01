// The question a Claude Code agent waits on, read from its screen. Claude Code
// draws a permission or a question as a numbered menu at the bottom of its
// screen. Nothing else names the choices: its status says what it waits for
// in a sentence, and its transcript holds the tool call but not the menu.
import { Array, Equivalence, Match, Option, pipe, String } from "effect"
import type { Answer, Choice, Question } from "../../shared/Chat.ts"

/**
 * The menu at the bottom of the screen, when the screen ends with one: only
 * blank lines, rules and key hints may follow it, so a numbered list higher
 * up, in a reply, is not taken for a menu.
 */
export const questionOnScreen = (screen: string): Option.Option<Question> => {
  const all = Array.map(String.split(screen, "\n"), String.trimEnd)
  const lines = Option.match(Array.findLastIndex(all, (line) => !isTrailer(line)), {
    onNone: () => [],
    onSome: (last) => Array.take(all, last + 1),
  })
  return pipe(
    // The last first choice on the screen whose menu runs to the end.
    Array.findFirst(Array.reverse(Array.range(0, lines.length - 1)), (start) =>
      Option.exists(Option.flatMap(Array.get(lines, start), choiceLine), ({ number }) => number === 1)
        ? Option.map(menuFrom(Array.drop(lines, start)), (choices) => ({ start, choices }))
        : Option.none(),
    ),
    Option.flatMap(({ start, choices }) =>
      Option.map(questionAbove(Array.take(lines, start)), (text) => ({
        text,
        choices: Array.filter(choices, ({ label }) => label !== OWN_ANSWER && label !== CHAT_ABOUT),
        ownAnswer: Option.map(Array.findFirst(choices, ({ label }) => label === OWN_ANSWER), ({ number }) => number),
      })),
    ),
  )
}

/**
 * The key that starts `answer`, while the screen still asks `question` and
 * offers it: the choice's number, or for typed text the number of the choice
 * that opens a text field. A key pressed after the agent moved on would go to
 * whatever it shows now: the next question, or its prompt as text.
 */
export const keyFor = (screen: string, question: Question, answer: Answer): Option.Option<string> =>
  pipe(
    Match.valueTags(answer, {
      Picked: ({ choice }) => Option.liftPredicate(choice, (number) => Array.some(question.choices, (offered) => offered.number === number)),
      Typed: () => question.ownAnswer,
    }),
    Option.filter(() => asks(screen, question)),
    Option.map((number) => `${number}`),
  )

/** Whether the screen still asks `question`. Claude Code redraws a moment after a key, so an answer waits until it does not. */
export const asks = (screen: string, question: Question) => Option.exists(questionOnScreen(screen), (shown) => sameQuestion(shown, question))

// The same question drawn at another width wraps its lines elsewhere: a label
// runs on into the line under it, which reads as its detail. So two questions
// are the same when their words are, in the same places.
const sameQuestion = (a: Question, b: Question) => Array.makeEquivalence(Equivalence.strictEqual<string>())(wordsOf(a), wordsOf(b))

const wordsOf = ({ text, choices, ownAnswer }: Question): ReadonlyArray<string> => [
  words(text),
  `${Option.getOrElse(ownAnswer, () => 0)}`,
  ...Array.map(choices, ({ number, label, detail }) => words(`${number} ${label} ${Option.getOrElse(detail, () => "")}`)),
]

const words = (text: string) => Array.join(Array.filter(String.split(text, /\s+/), String.isNonEmpty), " ")

/** The choice that opens a text field under the menu, for an answer of the user's own. */
const OWN_ANSWER = "Type something."

/** The choice that drops the question to talk it over; the page leaves it out. */
const CHAT_ABOUT = "Chat about this"

/** What may follow a menu: Claude Code's key hints, such as "Esc to cancel". */
const KEY_HINT = /Esc to cancel|Enter to (select|confirm)/

/** A numbered choice, the `❯` on the highlighted one, and where its label starts. */
const CHOICE = /^\s*(?:❯\s*)?(\d+)\.\s+(\S.*)$/

const QUOTE_BAR = /^\s*│/

type Menu = Readonly<{ choices: ReadonlyArray<Choice>; column: number }>

// The choices numbered from 1, in order. Between them may stand blank lines,
// rules, and lines indented at least as far as the label above them: the
// choice's description, or its label wrapped.
const menuFrom = (lines: ReadonlyArray<string>): Option.Option<ReadonlyArray<Choice>> =>
  pipe(
    Array.reduce(lines, Option.some<Menu>({ choices: [], column: 0 }), (menu, line) => Option.flatMap(menu, (sofar) => step(sofar, line))),
    Option.map(({ choices }) => choices),
    Option.filter(Array.isReadonlyArrayNonEmpty),
  )

const step = (menu: Menu, line: string): Option.Option<Menu> =>
  Option.match(choiceLine(line), {
    onSome: ({ number, label, column }) =>
      number === menu.choices.length + 1 ? Option.some({ choices: [...menu.choices, { number, label, detail: Option.none() }], column }) : Option.none(),
    onNone: () =>
      isBlank(line) || isRule(line)
        ? Option.some(menu)
        : Array.isReadonlyArrayNonEmpty(menu.choices) && indent(line) >= menu.column
          ? Option.some(withDetail(menu, String.trim(line)))
          : Option.none(),
  })

const withDetail = (menu: Menu, text: string): Menu => ({
  ...menu,
  choices: Array.map(menu.choices, (choice, index) =>
    index === menu.choices.length - 1
      ? { ...choice, detail: Option.some(Option.match(choice.detail, { onNone: () => text, onSome: (before) => `${before} ${text}` })) }
      : choice,
  ),
})

/**
 * The paragraph right above the menu, "Do you want to proceed?" or the question
 * asked, its wrapped lines joined. Claude Code marks a long question with a
 * bar, `│`, at the start of each of its lines.
 */
const questionAbove = (above: ReadonlyArray<string>): Option.Option<string> => {
  const paragraph = Array.reverse(Array.takeWhile(Array.dropWhile(Array.reverse(above), isBlank), (line) => !isBlank(line) && !isRule(line)))
  return Option.liftPredicate(Array.join(Array.map(paragraph, (line) => String.trim(line.replace(QUOTE_BAR, ""))), " "), String.isNonEmpty)
}

const choiceLine = (line: string) =>
  Option.map(Option.fromNullOr(CHOICE.exec(line)), ([, number, label = ""]) => ({
    number: Number(number),
    label,
    column: line.length - label.length,
  }))

const isTrailer = (line: string) => isBlank(line) || isRule(line) || KEY_HINT.test(line)
const isBlank = (line: string) => String.isEmpty(String.trim(line))
const isRule = (line: string) => /^[\s─╌━═-]+$/.test(line)
const indent = (line: string) => line.length - String.trimStart(line).length
