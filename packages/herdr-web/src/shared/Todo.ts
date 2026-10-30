// An agent's plan for its work, as the page shows it: the steps it set out,
// each pending, in progress or completed. Each agent keeps its own list; the
// bridge reads it into these items, so the page knows no agent's form.
import { Array, Schema } from "effect"

export const TodoStatus = Schema.Literals(["pending", "in_progress", "completed"])
export type TodoStatus = typeof TodoStatus.Type

export const TodoItem = Schema.Struct({
  /** Unique within its list. */
  id: Schema.String,
  text: Schema.String,
  status: TodoStatus,
  /** What the agent says while the step is in progress, such as "Running the tests". */
  activeText: Schema.OptionFromOptionalKey(Schema.String),
  /** The ids of the steps that must be completed first. */
  blockedBy: Schema.Array(Schema.String),
})
export type TodoItem = typeof TodoItem.Type

export const completedCount = (items: ReadonlyArray<TodoItem>) => Array.filter(items, ({ status }) => status === "completed").length

export const sameTodos = Schema.toEquivalence(Schema.Array(TodoItem))
