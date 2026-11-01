// An OpenCode session's todo list, from the `todo` table of its database:
// one row per step, at its position in the list.
import { Array, Option, Order, Schema as S } from "effect"
import type { TodoItem } from "../../shared/Todo.ts"
import { quoted } from "./Database.ts"

/** SQL for the session's todo rows, as one JSON array of `TodoRow`. */
export const todosQuery = (session: string) => `
select json_group_array(json_object('content', content, 'status', status, 'position', position))
from todo where session_id = ${quoted(session)}`

export const TodoRow = S.Struct({
  content: S.String,
  status: S.Literals(["pending", "in_progress", "completed", "cancelled"]),
  position: S.Int,
})
export type TodoRow = typeof TodoRow.Type

/** The list in its order. A cancelled step is no longer part of the plan, so it is left out. */
export const todosOf = (rows: ReadonlyArray<TodoRow>): ReadonlyArray<TodoItem> =>
  Array.flatMap(Array.sort(rows, BY_POSITION), ({ content, status, position }) =>
    status === "cancelled" ? [] : [{ id: `${position}`, text: content, status, activeText: Option.none(), blockedBy: [] }],
  )

const BY_POSITION = Order.mapInput(Order.Number, ({ position }: TodoRow) => position)
