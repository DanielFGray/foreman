// An agent's todo list: over its chat, as one line that opens to every step,
// and as a count in its sidebar row. The page watches the list of each live
// agent that keeps one, so the count shows for agents that are not on screen.
import { Array, Match, Option, Record } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import { supports } from "../shared/Harness.ts"
import { completedCount, type TodoItem } from "../shared/Todo.ts"
import { Circle, CircleCheck, CircleDot, icon } from "./icons.ts"
import type { Message, Model } from "./model.ts"
import { lastFleet } from "./selection.ts"

/** The addresses of the live agents that keep a todo list. */
export const watchedTodos = (model: Model): ReadonlyArray<string> =>
  Option.match(lastFleet(model.bridge), {
    onNone: () => [],
    onSome: ({ terminals }) => Array.map(Array.filter(terminals, (terminal) => terminal.state === "live" && supports(terminal, "todos")), ({ address }) => address),
  })

/** The agent's list as read now; an empty one is no list. */
export const receivedTodos = (model: Model, address: string, todos: ReadonlyArray<TodoItem>): Model =>
  modifyFields(model, { todos: (all) => (Array.isReadonlyArrayNonEmpty(todos) ? Record.set(all, address, todos) : Record.remove(all, address)) })

/** The list over the agent's chat: closed, it shows the count and the step in progress. */
export const todoListView = (model: Model, address: string, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.toArray(
    Option.map(Record.get(model.todos, address), (todos) =>
      h.details(
        [h.Class("todos")],
        [
          h.summary(
            [],
            [
              h.span([h.Class("count")], [`todo ${countText(todos)}`]),
              ...Option.toArray(Option.map(Array.findFirst(todos, ({ status }) => status === "in_progress"), (step) => h.span([h.Class("now")], [shownText(step)]))),
            ],
          ),
          h.ol(
            [],
            Array.map(todos, (step) =>
              h.keyed("li")(step.id, [h.Class(step.status)], [h.span([h.Class("mark"), h.Role("img"), h.AriaLabel(statusLabel(step))], [icon(mark(step), h)]), shownText(step)]),
            ),
          ),
        ],
      ),
    ),
  )

/** The count in the agent's sidebar row, such as `3/7`, while it has a list. */
export const todoCountView = (model: Model, address: string, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.toArray(Option.map(Record.get(model.todos, address), (todos) => h.span([h.Class("todo-count"), h.Title("todo steps completed")], [countText(todos)])))

const countText = (todos: ReadonlyArray<TodoItem>) => `${completedCount(todos)}/${todos.length}`

/** A step in progress reads as what the agent does now, when it says. */
const shownText = ({ status, text, activeText }: TodoItem) => (status === "in_progress" ? Option.getOrElse(activeText, () => text) : text)

const mark = ({ status }: TodoItem) =>
  Match.value(status).pipe(
    Match.when("pending", () => Circle),
    Match.when("in_progress", () => CircleDot),
    Match.when("completed", () => CircleCheck),
    Match.exhaustive,
  )

const statusLabel = ({ status }: TodoItem) =>
  Match.value(status).pipe(
    Match.when("pending", () => "pending"),
    Match.when("in_progress", () => "in progress"),
    Match.when("completed", () => "completed"),
    Match.exhaustive,
  )
