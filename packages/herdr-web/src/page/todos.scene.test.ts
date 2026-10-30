import { Option } from "effect"
import { all, expect, expectAll, given, Mount, scene, selector, Subscription } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
import type { TodoItem } from "../shared/Todo.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Conversation, Message, type Model, Selection, View } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"

const claude: Terminal = {
  address: "t1",
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  foreground: Option.some({ name: "claude", pid: 1, argv: [] }),
  status: Option.some({ state: "working", app: Option.some("claude-code"), msg: Option.none(), kind: Option.none(), progress: Option.none() }),
  labels: {},
  status_ms: Option.none(),
  created_ms: 0,
  records: Option.none(),
  parent: Option.none(),
  cols: 80,
  rows: 24,
}

const fleet: Fleet = {
  connected: true,
  git: {},
  terminals: [claude],
  machines: [
    {
      name: "here",
      isLocal: true,
      state: "connected",
      spaces: [
        {
          id: "s1",
          name: "work",
          folder: "/",
          tabs: [{ id: "a", name: "", root: { _tag: "Block", type: "block", id: "p-t1", size: Option.none(), content: { _tag: "Terminal", terminal: "t1" } } }],
        },
      ],
    },
  ],
}

const chatOpen: Model = {
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.some("t1") }), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [] }).model,
  bridge: Bridge.Watching({ fleet }),
  views: { t1: View.Chat({ conversation: Conversation.Shown({ entries: [] }) }) },
  boxes: { t1: { _tag: "Empty" } },
}

const step = (id: string, text: string, status: TodoItem["status"], activeText: Option.Option<string> = Option.none()): TodoItem => ({ id, text, status, activeText, blockedBy: [] })

const plan = [
  step("1", "Read the code", "completed"),
  step("2", "Run the tests", "in_progress", Option.some("Running the tests")),
  step("3", "Write the fix", "pending"),
]

const received = (todos: ReadonlyArray<TodoItem>) => Subscription.emit(Message.ReceivedTodos({ address: "t1", todos }))

test("an agent's todo list shows over its chat and as a count in its sidebar row, until it has none", () => {
  scene(
    { update, view },
    given(chatOpen),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    expect(selector(".todos")).not.toExist(),
    received(plan),
    // Closed, the list names its count and what the agent does now.
    expect(selector(".todos summary")).toContainText("todo 1/3"),
    expect(selector(".todos summary .now")).toHaveText("Running the tests"),
    expectAll(all.selector(".todos li")).toHaveCount(3),
    expect(selector(".todos li.pending")).toContainText("Write the fix"),
    expect(selector(".agent-row .todo-count")).toHaveText("1/3"),
    received([]),
    expect(selector(".todos")).not.toExist(),
    expect(selector(".agent-row .todo-count")).not.toExist(),
  )
})
