import { Option } from "effect"
import { click, Command, expect, given, Mount, role, scene, selector, Subscription, type as typeInto } from "foldkit/scene"
import { test } from "vitest"
import type { Question } from "../shared/Chat.ts"
import type { Fleet, Status, Terminal } from "../shared/Fleet.ts"
import { AnswerQuestion } from "./commands.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Conversation, Message, type Model, Selection, View } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"

const blocked: Status = {
  state: "blocked",
  app: Option.some("claude-code"),
  msg: Option.some("approve Bash: rm -rf build"),
  kind: Option.some("permission"),
  progress: Option.none(),
}

const claude = (status: Status, statusMs: number): Terminal => ({
  address: "t1",
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  foreground: Option.some({ name: "claude", pid: 1, argv: [] }),
  status: Option.some(status),
  labels: {},
  status_ms: Option.some(statusMs),
  created_ms: 0,
  parent: Option.none(),
  cols: 80,
  rows: 24,
})

const fleetWith = (terminal: Terminal): Fleet => ({
  connected: true,
  git: {},
  terminals: [terminal],
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
})

const choice = (number: number, label: string) => ({ number, label, detail: Option.none() })

const proceed: Question = { text: "Do you want to proceed?", choices: [choice(1, "Yes"), choice(2, "Yes, and don't ask again"), choice(3, "No")], ownAnswer: Option.none() }
const size: Question = { text: "Which size?", choices: [choice(1, "Small"), choice(2, "Large")], ownAnswer: Option.some(3) }

const picked = (choice: number) => ({ _tag: "Picked" as const, choice })

const chatOpen = (terminal: Terminal): Model => ({
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.some("t1") }), sidebarWidth: Option.none(), recent: [] }).model,
  bridge: Bridge.Watching({ fleet: fleetWith(terminal) }),
  views: { t1: View.Chat({ conversation: Conversation.Shown({ entries: [] }) }) },
})

const card = role("region", { name: "Question from the agent" })
const read = (question: Question, statusMs = 100) => Subscription.emit(Message.ReceivedQuestion({ address: "t1", statusMs, question: Option.some(question) }))

test("a blocked agent's question shows as a card, and a tap on a choice answers it", () => {
  scene(
    { update, view },
    given(chatOpen(claude(blocked, 100))),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    read(proceed),
    expect(card).toContainText("approve Bash: rm -rf build"),
    expect(card).toContainText("Do you want to proceed?"),
    click(role("button", { name: "3. No" })),
    Command.expectExact(AnswerQuestion({ address: "t1", question: proceed, answer: picked(3) })),
    expect(role("button", { name: "1. Yes" })).toBeDisabled(),
    Command.resolve(AnswerQuestion, Message.SucceededAnswer({ address: "t1" })),
    // The agent moved on, so the card goes until the next read, or for good.
    expect(card).not.toExist(),
    Subscription.emit(Message.ReceivedFleet({ fleet: fleetWith(claude({ ...blocked, state: "working", kind: Option.none() }, 200)) })),
    expect(card).not.toExist(),
  )
})

test("the next question of a series shows after an answer, under the same status", () => {
  scene(
    { update, view },
    given(chatOpen(claude(blocked, 100))),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    read(proceed),
    click(role("button", { name: "1. Yes" })),
    Command.resolve(AnswerQuestion, Message.SucceededAnswer({ address: "t1" })),
    read(size),
    expect(card).toContainText("Which size?"),
  )
})

test("a choice's number typed in the prompt answers the question", () => {
  scene(
    { update, view },
    given(chatOpen(claude(blocked, 100))),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    read(proceed),
    typeInto(role("textbox", { name: "Prompt" }), " 2 "),
    click(role("button", { name: "send" })),
    Command.expectExact(AnswerQuestion({ address: "t1", question: proceed, answer: picked(2) })),
    expect(role("textbox", { name: "Prompt" })).toHaveValue(""),
    Command.resolve(AnswerQuestion, Message.SucceededAnswer({ address: "t1" })),
  )
})

test("an answer the agent no longer asks for is not sent, and the card says why", () => {
  scene(
    { update, view },
    given(chatOpen(claude(blocked, 100))),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    read(proceed),
    click(role("button", { name: "1. Yes" })),
    Command.resolve(AnswerQuestion, Message.FailedAnswer({ address: "t1", reason: "the agent no longer asks this" })),
    read(size),
    expect(card).toContainText("the agent no longer asks this"),
    expect(card).toContainText("Which size?"),
  )
})

test("a question read under an earlier status does not show", () => {
  scene(
    { update, view },
    given(chatOpen(claude(blocked, 200))),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    read(proceed, 100),
    expect(card).not.toExist(),
    expect(selector(".question-note")).not.toExist(),
  )
})

test("text typed in the prompt is the answer of your own, when the question takes one", () => {
  const asking: Status = { ...blocked, kind: Option.some("question"), msg: Option.some("answer: Which size? (Small · Large)") }
  scene(
    { update, view },
    given(chatOpen(claude(asking, 100))),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    read(size),
    // A question's status says the question again, so the card leaves it out.
    expect(card).not.toContainText("answer: Which size?"),
    expect(card).toContainText("Or type your own answer below."),
    typeInto(role("textbox", { name: "Prompt" }), " medium, please "),
    click(role("button", { name: "send" })),
    Command.expectExact(AnswerQuestion({ address: "t1", question: size, answer: { _tag: "Typed", text: "medium, please" } })),
    expect(role("textbox", { name: "Prompt" })).toHaveValue(""),
    Command.resolve(AnswerQuestion, Message.SucceededAnswer({ address: "t1" })),
  )
})
