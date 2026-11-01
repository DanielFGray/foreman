// An agent's plan for its work, as the page shows it: the steps it set out,
// each pending, in progress or completed. Each agent keeps its own list; the
// bridge reads it into these items, so the page knows no agent's form.
import { Array, Schema as S } from "effect"

export const TodoStatus = S.Literals(["pending", "in_progress", "completed"])
export type TodoStatus = typeof TodoStatus.Type

export const TodoItem = S.Struct({
  /** Unique within its list. */
  id: S.String,
  text: S.String,
  status: TodoStatus,
  /** What the agent says while the step is in progress, such as "Running the tests". */
  activeText: S.OptionFromOptionalKey(S.String),
  /** The ids of the steps that must be completed first. */
  blockedBy: S.Array(S.String),
})
export type TodoItem = typeof TodoItem.Type

export const completedCount = (items: ReadonlyArray<TodoItem>) => Array.filter(items, ({ status }) => status === "completed").length

export const sameTodos = S.toEquivalence(S.Array(TodoItem))
