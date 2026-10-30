// Claude Code's task list, which it shows as its todo list. Claude Code keeps
// each task as `<config>/tasks/<list id>/<task id>.json`, and deletes the file
// when the agent deletes the task. The bridge reads the list named by the
// session id. Claude Code names it otherwise for an agent in a team, or one
// started with CLAUDE_CODE_TASK_LIST_ID; the bridge sees neither, so such an
// agent shows no list.
import { Array, Option, Order, Schema } from "effect"
import type { TodoItem } from "../../shared/Todo.ts"

/** One task file, as Claude Code 2.1 writes it. */
export const TaskFile = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  activeForm: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["pending", "in_progress", "completed"]),
  blockedBy: Schema.Array(Schema.String),
})
export type TaskFile = typeof TaskFile.Type

export const decodeTaskFile = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskFile))

/** The list of tasks, in the order the agent made them. */
export const todosOf = (tasks: ReadonlyArray<TaskFile>): ReadonlyArray<TodoItem> =>
  Array.map(Array.sort(tasks, BY_ID), ({ id, subject, activeForm, status, blockedBy }) => ({
    id,
    text: subject,
    status,
    activeText: Option.fromUndefinedOr(activeForm),
    blockedBy,
  }))

/** A task's file in its list's folder. */
export const isTaskFile = (name: string) => /^[\w-]+\.json$/.test(name)

// Ids count up from 1, so a shorter id is an older task: "2" comes before "10".
const BY_ID = Order.combine(
  Order.mapInput(Order.Number, ({ id }: TaskFile) => id.length),
  Order.mapInput(Order.String, ({ id }: TaskFile) => id),
)
