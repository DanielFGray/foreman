import { Effect, Option } from "effect"
import { expect, test } from "vitest"
import { decodeTaskFile, isTaskFile, todosOf } from "./Tasks.ts"

// Made-up task files in the form Claude Code 2.1 writes them, with the keys the list does not show.
const file = (id: string, subject: string, status: string, extra: string = "") =>
  `{"id":"${id}","subject":"${subject}","description":"made-up detail","status":"${status}","blocks":[],"blockedBy":[]${extra}}`

const decoded = (...texts: ReadonlyArray<string>) => Effect.runSync(Effect.forEach(texts, (text) => decodeTaskFile(text)))

test("the tasks read in the order they were made, the tenth after the second", () => {
  const todos = todosOf(decoded(file("10", "tenth step", "pending"), file("2", "second step", "completed"), file("1", "first step", "completed")))
  expect(todos.map(({ id }) => id)).toEqual(["1", "2", "10"])
})

test("a task gives its subject, its active text and the tasks it waits on", () => {
  const [step] = todosOf(decoded(file("3", "Run the tests", "in_progress", `,"activeForm":"Running the tests","owner":"main","metadata":{"made":"up"},"blockedBy":["1"]`)))
  expect(step).toEqual({ id: "3", text: "Run the tests", status: "in_progress", activeText: Option.some("Running the tests"), blockedBy: ["1"] })
})

test("only a task's own file is read from the list's folder", () => {
  expect(["1.json", "12.json", ".lock", ".highwatermark"].filter(isTaskFile)).toEqual(["1.json", "12.json"])
})
