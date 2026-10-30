import { Option } from "effect"
import { expect, test } from "vitest"
import { todosOf } from "./Todos.ts"

test("the steps read in their list's order, without the cancelled ones", () => {
  const todos = todosOf([
    { content: "third step", status: "pending", position: 2 },
    { content: "first step", status: "completed", position: 0 },
    { content: "dropped step", status: "cancelled", position: 1 },
    { content: "fourth step", status: "in_progress", position: 3 },
  ])
  expect(todos).toEqual([
    { id: "0", text: "first step", status: "completed", activeText: Option.none(), blockedBy: [] },
    { id: "2", text: "third step", status: "pending", activeText: Option.none(), blockedBy: [] },
    { id: "3", text: "fourth step", status: "in_progress", activeText: Option.none(), blockedBy: [] },
  ])
})
