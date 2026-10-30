import { readFileSync } from "node:fs"
import { Ghostty } from "ghostty-web"
import { expect, test } from "vitest"
import { render } from "../ScreenCells.ts"
import { inputBoxOf } from "./InputBox.ts"

const ghostty = await Ghostty.load(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm")).pathname)

const COLS = 60
const RULE = "─".repeat(COLS)
const FAINT = (text: string) => `\x1b[2m${text}\x1b[22m`
const INVERSE = (text: string) => `\x1b[7m${text}\x1b[27m`

// Claude Code's bottom rows as it draws them: a reply, the box between two
// rules, and its status line under the box.
const screen = (...box: ReadonlyArray<string>) => {
  const lines = ["● Done.", "", RULE, ...box, RULE, "  -- INSERT -- ⏵⏵ auto mode on"]
  return render(ghostty.createTerminal(COLS, lines.length), { cols: COLS, rows: lines.length }, lines.join("\r\n"))
}

test("an empty box", () => {
  expect(inputBoxOf(screen("❯ "))).toEqual({ _tag: "Empty" })
})

test("a suggested prompt is drawn faint, with the terminal's cursor or Claude's inverse one on its first character", () => {
  expect(inputBoxOf(screen(`❯ ${FAINT("commit this")}`))).toEqual({ _tag: "Suggestion", text: "commit this" })
  expect(inputBoxOf(screen(`❯ ${INVERSE("c")}${FAINT("ommit this")}`))).toEqual({ _tag: "Suggestion", text: "commit this" })
})

test("typed text is a draft, also over two rows", () => {
  expect(inputBoxOf(screen("❯ draft"))).toEqual({ _tag: "Draft", text: "draft" })
  expect(inputBoxOf(screen("❯ first line", "  second line"))).toEqual({ _tag: "Draft", text: "first line\n  second line" })
  // The cursor sits inverse on a typed character, with nothing faint after it.
  expect(inputBoxOf(screen(`❯ dr${INVERSE("a")}ft`))).toEqual({ _tag: "Draft", text: "draft" })
})

test("the new-session tip is an empty box", () => {
  expect(inputBoxOf(screen(`❯ ${FAINT('Try "how does src/main.ts work?"')}`))).toEqual({ _tag: "Empty" })
})

test("the IDE pill is no input", () => {
  expect(inputBoxOf(screen("❯ [⧉ In src/main.ts] "))).toEqual({ _tag: "Empty" })
  expect(inputBoxOf(screen(`❯ [⧉ In src/main.ts] ${FAINT("run the tests")}`))).toEqual({ _tag: "Suggestion", text: "run the tests" })
})

test("a folded paste is a draft, however it is drawn", () => {
  expect(inputBoxOf(screen(`❯ ${FAINT("[Pasted text #1 +40 lines]")}`))).toEqual({ _tag: "Draft", text: "[Pasted text #1 +40 lines]" })
})

test("bash mode is a draft: its box runs what is typed as a command", () => {
  expect(inputBoxOf(screen("! ls"))).toEqual({ _tag: "Draft", text: "! ls" })
})

test("a box too tall for the screen shows only its bottom rule, and is taken for a draft", () => {
  const lines = ["❯ a long draft", "  goes on", RULE, "  -- INSERT --"]
  expect(inputBoxOf(render(ghostty.createTerminal(COLS, lines.length), { cols: COLS, rows: lines.length }, lines.join("\r\n")))).toEqual({
    _tag: "Draft",
    text: "❯ a long draft\n  goes on",
  })
})

test("a screen with no rules has no box", () => {
  const lines = ["$ ls", "src  package.json"]
  expect(inputBoxOf(render(ghostty.createTerminal(COLS, 2), { cols: COLS, rows: 2 }, lines.join("\r\n")))).toEqual({ _tag: "Absent" })
})

test("a question or a permission Claude Code asks stands where the box was, so there is no box", () => {
  // The screens were saved from a terminal 200 columns wide.
  const saved = (name: string) => {
    const lines = readFileSync(`${import.meta.dirname}/fixtures/screens/${name}.txt`, "utf8").trimEnd().split("\n")
    return render(ghostty.createTerminal(200, lines.length), { cols: 200, rows: lines.length }, lines.join("\r\n"))
  }
  expect(inputBoxOf(saved("question"))).toEqual({ _tag: "Absent" })
  expect(inputBoxOf(saved("permission"))).toEqual({ _tag: "Absent" })
  expect(inputBoxOf(saved("idle"))._tag).not.toBe("Absent")
})
