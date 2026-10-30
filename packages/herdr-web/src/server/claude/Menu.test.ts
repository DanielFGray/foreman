import { readFileSync } from "node:fs"
import { Option } from "effect"
import { expect, test } from "vitest"
import { keyFor, questionOnScreen } from "./Menu.ts"

// Screens Claude Code drew, read with `hc read`.
const screen = (name: string) => readFileSync(`${import.meta.dirname}/fixtures/screens/${name}.txt`, "utf8")

const choice = (number: number, label: string, detail?: string) => ({ number, label, detail: Option.fromUndefinedOr(detail) })

test("a permission to run a command", () => {
  expect(questionOnScreen(screen("permission"))).toEqual(
    Option.some({
      text: "Do you want to proceed?",
      choices: [
        choice(1, "Yes"),
        choice(2, "Yes, and don't ask again for rm -f now.txt and date commands in /home/me/project"),
        choice(3, "Yes, and switch to auto mode · auto mode handles these prompts for you"),
        choice(4, "No"),
      ],
    }),
  )
})

test("a question with set answers, without the choices that open a text box", () => {
  expect(questionOnScreen(screen("question"))).toEqual(
    Option.some({
      text: "Which colour?",
      choices: [choice(1, "Red", "Choose red."), choice(2, "Green", "Choose green."), choice(3, "Blue", "Choose blue.")],
    }),
  )
})

test("each step of a series of questions, and its review", () => {
  expect(Option.map(questionOnScreen(screen("two")), ({ text }) => text)).toEqual(Option.some("Which colour?"))
  expect(questionOnScreen(screen("submit"))).toEqual(
    Option.some({ text: "Ready to submit your answers?", choices: [choice(1, "Submit answers"), choice(2, "Cancel")] }),
  )
})

test("a screen whose numbered lines are not at its bottom has no question", () => {
  expect(questionOnScreen(screen("idle"))).toEqual(Option.none())
  expect(questionOnScreen("Steps:\n1. build\n2. test\n\n────\n❯ \n────\n  -- INSERT --")).toEqual(Option.none())
})

test("a choice is pressed only while the screen still asks the same question", () => {
  const pressed = (now: string, choice: number) => Option.flatMap(questionOnScreen(screen("two")), (asked) => keyFor(screen(now), asked, choice))
  expect(pressed("two", 2)).toEqual(Option.some("2"))
  // The next question of the series, the choice that opens a text box, and the agent back at its prompt.
  expect(pressed("submit", 2)).toEqual(Option.none())
  expect(pressed("two", 3)).toEqual(Option.none())
  expect(pressed("idle", 1)).toEqual(Option.none())
})

test("the same question drawn at another width is still the same question", () => {
  // A narrower terminal wraps choice 2 onto the line under it, and the question over two lines.
  const narrow = screen("permission")
    .replace(" Do you want to proceed?", " Do you want\n to proceed?")
    .replace("don't ask again for rm -f now.txt and date commands in /home/me/project", "don't ask again for rm -f now.txt and date\n      commands in /home/me/project")
  expect(Option.map(questionOnScreen(narrow), ({ text }) => text)).toEqual(Option.some("Do you want to proceed?"))
  expect(Option.flatMap(questionOnScreen(screen("permission")), (asked) => keyFor(narrow, asked, 2))).toEqual(Option.some("2"))
})
