// Claude Code's input box, read from the cells of its screen. The box is the
// rows between the screen's last two rules, the first row starting with `❯`.
// An empty box may show a suggested prompt or a tip, drawn faint; text the
// user typed there is drawn plain. As plain text the two read the same. A
// question or a permission Claude Code asks is drawn in the box's place.
import { Array, Option, pipe, String } from "effect"
import type { InputBox } from "../../shared/Chat.ts"
import type { Status } from "../../shared/Fleet.ts"
import { questionOnScreen } from "./Menu.ts"

/** One cell of a screen: its character, and the two styles that tell typed text from Claude's own. */
export type Cell = Readonly<{ char: string; faint: boolean; inverse: boolean }>

export type Screen = ReadonlyArray<ReadonlyArray<Cell>>

/** What the input box at the bottom of `screen` holds. */
export const inputBoxOf = (screen: Screen): InputBox => boxOnScreen(screen).box

/**
 * The input box at the bottom of `screen`, and how many rows it takes; none
 * when the box is taller than the screen, which then shows only its bottom
 * rule.
 */
export const boxOnScreen = (screen: Screen): Readonly<{ box: InputBox; rows: Option.Option<number> }> => {
  const lines = Array.map(screen, textOf)
  return Option.isSome(questionOnScreen(Array.join(lines, "\n")))
    ? { box: { _tag: "Absent" }, rows: Option.none() }
    : Option.match(Array.findLastIndex(lines, isRule), {
        onNone: () => ({ box: { _tag: "Absent" }, rows: Option.none() }),
        onSome: (end) =>
          Option.match(Array.findLastIndex(Array.take(lines, end), isRule), {
            onNone: () => ({ box: { _tag: "Partial", text: plainText(Array.take(lines, end)) }, rows: Option.none() }),
            onSome: (start) => {
              const rows = Array.drop(Array.take(screen, end), start + 1)
              return { box: boxOf(rows), rows: Option.some(rows.length) }
            },
          }),
      })
}

const boxOf = (rows: Screen): InputBox =>
  Option.match(
    Option.filter(Array.head(rows), (first) => String.startsWith(PROMPT)(String.trimStart(textOf(first)))),
    {
      // Bash mode (`!`) and other boxes run what is typed in them as something else.
      onNone: (): InputBox => (Array.every(rows, (row) => isBlank(textOf(row))) ? { _tag: "Absent" } : { _tag: "Draft", text: plainText(Array.map(rows, textOf)) }),
      onSome: (first) => {
        const cells = [...afterPill(afterPrompt(first)), ...Array.flatten(Array.drop(rows, 1))]
        const text = String.trim(plainText([textOf(cells)]))
        const marks = Array.filter(cells, ({ char }) => !isBlank(char))
        const typed = plainText(Array.map(rows, textOf)).replace(/^\s*❯\s?/, "")
        return Array.isReadonlyArrayEmpty(marks)
          ? { _tag: "Empty" }
          : FOLDED.test(text)
            ? { _tag: "Partial", text: typed }
            : !isClaudesOwn(marks)
              ? { _tag: "Draft", text: typed }
              : TIP.test(text)
                ? { _tag: "Empty" }
                : { _tag: "Suggestion", text }
      },
    },
  )

// Claude draws faint text, and may draw its own cursor inverse on the first
// character of it. Anything else plain was typed.
const isClaudesOwn = (marks: ReadonlyArray<Cell>) =>
  Array.some(marks, ({ faint }) => faint) && Array.every(marks, ({ faint, inverse }, index) => faint || (index === 0 && inverse))

const afterPrompt = (row: ReadonlyArray<Cell>) =>
  pipe(
    Array.findFirstIndex(row, ({ char }) => char === PROMPT),
    Option.match({ onNone: () => row, onSome: (at) => Array.drop(row, at + 1) }),
  )

/** Claude's IDE pill after the `❯`, `[⧉ In src/a.ts]`, is no input: typing and clearing the box leave it. */
const afterPill = (cells: ReadonlyArray<Cell>) =>
  Option.match(String.match(IDE_PILL)(textOf(cells)), {
    onNone: () => cells,
    onSome: ([pill]) => Array.drop(cells, Array.fromIterable(pill).length),
  })

const textOf = (cells: ReadonlyArray<Cell>) => Array.join(Array.map(cells, ({ char }) => char), "")

const plainText = (lines: ReadonlyArray<string>) => Array.join(Array.map(lines, String.trimEnd), "\n").replace(/ /g, " ")

const isBlank = (text: string) => String.isEmpty(String.trim(text.replace(/ /g, " ")))

/** A solid rule, or one labelled with a session's name: `──── my-session ─`. */
const isRule = (line: string) => /^─+$/.test(String.trim(line)) || /^─{2,}\s.*─$/.test(String.trim(line))

const PROMPT = "❯"

const IDE_PILL = /^[  ]?\[⧉ [^\]\n]+\] ?/

/** Claude's new-session tip in an empty box. */
const TIP = /^Try "/

/** A paste or an image Claude folded into a placeholder: content, however it is drawn. */
const FOLDED = /\[(?:Pasted text #\d+|Image #\d+)/

/**
 * Why text must not be typed into the agent now, if it must not: the paste
 * would join a draft in its input box, or land while it works, which the
 * caller allows only for a message it means to hand over at once.
 */
export const refusal = (box: InputBox, status: Option.Option<Status>, whileWorking: boolean): Option.Option<Refusal> =>
  box._tag === "Draft" || box._tag === "Partial"
    ? Option.some({ kind: "draft", message: `the agent's input box holds text typed in the terminal: "${box.text}"` })
    : !whileWorking && Option.exists(status, ({ state }) => state === "working")
      ? Option.some({ kind: "working", message: "the agent is working" })
      : Option.none()

export type Refusal = Readonly<{ kind: "draft" | "working"; message: string }>

/**
 * The input that replaces the text of a box of `rows` rows with `text`,
 * wherever its cursor is. In vim NORMAL mode `i` enters INSERT mode;
 * otherwise it types a letter the rest delete. Down and End take the cursor
 * to the end of the text; each ctrl+u then deletes back to the start of its
 * line, and the next one the line break before it. The text goes as a
 * bracketed paste, so its line breaks do not send it.
 */
export const replacing = (rows: number, text: string): string =>
  Array.join(["i", ...Array.replicate(DOWN, rows), END, ...Array.replicate(CTRL_U, 2 * rows + 1), ...(String.isEmpty(text) ? [] : [PASTE_START, text, PASTE_END])], "")

// As a terminal sends them with no keyboard mode on, which Claude Code also reads.
const DOWN = "\x1b[B"
const END = "\x1b[F"
const CTRL_U = "\x15"
const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"
