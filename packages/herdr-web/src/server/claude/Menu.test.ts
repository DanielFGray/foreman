import { readFileSync } from "node:fs"
import { Option } from "effect"
import { expect, test } from "vitest"
import { asks, keyFor, questionOnScreen } from "./Menu.ts"

// Screens Claude Code drew, read with `hc read`.
const screen = (name: string) => readFileSync(`${import.meta.dirname}/fixtures/screens/${name}.txt`, "utf8")

const choice = (number: number, label: string, detail?: string) => ({ number, label, detail: Option.fromUndefinedOr(detail) })

const picked = (choice: number) => ({ _tag: "Picked" as const, choice })

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
      ownAnswer: Option.none(),
    }),
  )
})

test("a question with set answers, and the choice that takes an answer of your own", () => {
  expect(questionOnScreen(screen("question"))).toEqual(
    Option.some({
      text: "Which colour?",
      choices: [choice(1, "Red", "Choose red."), choice(2, "Green", "Choose green."), choice(3, "Blue", "Choose blue.")],
      ownAnswer: Option.some(4),
    }),
  )
})

test("each step of a series of questions, and its review", () => {
  expect(Option.map(questionOnScreen(screen("two")), ({ text }) => text)).toEqual(Option.some("Which colour?"))
  expect(questionOnScreen(screen("submit"))).toEqual(
    Option.some({ text: "Ready to submit your answers?", choices: [choice(1, "Submit answers"), choice(2, "Cancel")], ownAnswer: Option.none() }),
  )
})

test("a screen whose numbered lines are not at its bottom has no question", () => {
  expect(questionOnScreen(screen("idle"))).toEqual(Option.none())
  expect(questionOnScreen("Steps:\n1. build\n2. test\n\n────\n❯ \n────\n  -- INSERT --")).toEqual(Option.none())
})

test("a choice is pressed only while the screen still asks the same question", () => {
  const pressed = (now: string, choice: number) => Option.flatMap(questionOnScreen(screen("two")), (asked) => keyFor(screen(now), asked, picked(choice)))
  expect(pressed("two", 2)).toEqual(Option.some("2"))
  // The next question of the series, the choice that opens a text field, and the agent back at its prompt.
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
  expect(Option.flatMap(questionOnScreen(screen("permission")), (asked) => keyFor(narrow, asked, picked(2)))).toEqual(Option.some("2"))
})

test("an answered question is gone once the screen shows the next one", () => {
  const stillAsked = (now: string) => Option.exists(questionOnScreen(screen("two")), (asked) => asks(screen(now), asked))
  expect(stillAsked("two")).toBe(true)
  expect(stillAsked("submit")).toBe(false)
  expect(stillAsked("idle")).toBe(false)
})

test("a long question drawn with a bar down its side reads as one sentence", () => {
  expect(Option.map(questionOnScreen(screen("long")), ({ text }) => text)).toEqual(
    Option.some("Terminals break a line at the screen edge, and the app can choose a better break first. Which wrapping algorithm should the chat use when a message line is wider than the window?"),
  )
})

test("an answer of your own is started with the number of the choice that takes it", () => {
  const typed = (now: string) => Option.flatMap(questionOnScreen(screen("two")), (asked) => keyFor(screen(now), asked, { _tag: "Typed", text: "teal" }))
  expect(typed("two")).toEqual(Option.some("3"))
  expect(typed("submit")).toEqual(Option.none())
  expect(Option.flatMap(questionOnScreen(screen("permission")), (asked) => keyFor(screen("permission"), asked, { _tag: "Typed", text: "no" }))).toEqual(Option.none())
})
