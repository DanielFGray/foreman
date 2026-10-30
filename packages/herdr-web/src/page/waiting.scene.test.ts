import { Option } from "effect"
import { click, Command, expect, Mount, expectAll, all, given, nth, role, scene, selector, Subscription, type as typeInto } from "foldkit/scene"
import { describe, expect as expectValue, test } from "vitest"
import type { Entry } from "../shared/Chat.ts"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
import { SendPrompt, WriteInputBox } from "./commands.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Conversation, Message, Selection, View, type Model } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { comesBackAsPrompt, GIVE_UP_AFTER } from "./waiting.ts"

const claude: Terminal = {
  address: "t1",
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  foreground: Option.some({ name: "claude", pid: 1, argv: [] }),
  status: Option.some({ state: "idle", app: Option.some("claude-code"), msg: Option.none(), kind: Option.none(), progress: Option.none() }),
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

const prompt = (id: string, text: string): Entry => ({ _tag: "Prompt", id, text })

// A prompt the user typed and the page has not written into the box yet.
const typed = (text: string) => ({ text, agreed: { text: "", typed: "" }, isWriting: false, problem: Option.none() })

const chatOpen = (entries: ReadonlyArray<Entry>): Model => ({
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.some("t1") }), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false }).model,
  bridge: Bridge.Watching({ fleet }),
  views: { t1: View.Chat({ conversation: Conversation.Shown({ entries }) }) },
  boxes: { t1: { _tag: "Empty" } },
})

const clockAt = (now: number) => Subscription.emit(Message.TickedClock({ now }))

test("a sent prompt shows at once as a faded bubble, gets a clock after 5 seconds, and gives way to the recorded prompt", () => {
  scene(
    { update, view },
    given(chatOpen([prompt("old", "go on")])),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    typeInto(role("textbox", { name: "Prompt" }), "go on"),
    click(role("button", { name: "send" })),
    Command.expectExact(SendPrompt({ address: "t1", id: 0, text: "go on", whileWorking: false, replaces: Option.some("") })),
    Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 0 })),
    // The earlier identical prompt is not the answer to this one.
    expectAll(all.selector(".bubble.waiting")).toHaveCount(1),
    expect(selector(".bubble.waiting")).toContainText("go on"),
    clockAt(1_000),
    clockAt(5_999),
    expectAll(all.selector(".waiting-clock")).toHaveCount(0),
    clockAt(6_000),
    expectAll(all.selector(".waiting-clock")).toHaveCount(1),
    Subscription.emit(Message.ReceivedChat({ address: "t1", update: { _tag: "Appended", entries: [prompt("new", "go on")] } })),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(0),
    expectAll(all.selector(".bubble.user")).toHaveCount(2),
  )
})

test("a prompt the agent never records goes after a minute", () => {
  scene(
    { update, view },
    given({ ...chatOpen([]), prompts: { t1: typed("hello") } }),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    click(role("button", { name: "send" })),
    Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 0 })),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(1),
    clockAt(1_000),
    clockAt(1_000 + GIVE_UP_AFTER - 1),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(1),
    clockAt(1_000 + GIVE_UP_AFTER),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(0),
  )
})

test("a command gets no bubble, and a prompt the bridge refused loses its bubble", () => {
  scene(
    { update, view },
    given({ ...chatOpen([]), prompts: { t1: typed("/cost") } }),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    click(role("button", { name: "send" })),
    Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 0 })),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(0),
  )
  scene(
    { update, view },
    given({ ...chatOpen([]), prompts: { t1: typed("hello") } }),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    click(role("button", { name: "send" })),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(1),
    Command.resolve(SendPrompt, Message.FailedSendPrompt({ address: "t1", id: 0, reason: "no such terminal" })),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(0),
    // The message stays queued, with the reason, until something about the agent changes.
    expect(selector(".queued")).toContainText("no such terminal"),
    Subscription.emit(Message.ReceivedInputBox({ address: "t1", box: { _tag: "Suggestion", text: "run the tests" } })),
    Command.expectExact(SendPrompt({ address: "t1", id: 0, text: "hello", whileWorking: false, replaces: Option.some("") })),
    Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 0 })),
    expectAll(all.selector(".queued")).toHaveCount(0),
  )
})

describe("comesBackAsPrompt", () => {
  test("is false for a slash command, a shell line and blank text", () => {
    expectValue(["hello", "/cost", " ! ls", "  "].map(comesBackAsPrompt)).toEqual([true, false, false, false])
  })
})


describe("the queue", () => {
  const withState = (state: "idle" | "working" | "blocked"): Fleet => ({
    ...fleet,
    terminals: [{ ...claude, status: Option.map(claude.status, (status) => ({ ...status, state })), status_ms: Option.some(state.length) }],
  })

  test("holds messages while the agent works, then sends them one at a time, in order", () => {
    scene(
      { update, view },
      given({ ...chatOpen([]), bridge: Bridge.Watching({ fleet: withState("working") }) }),
      Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
      typeInto(role("textbox", { name: "Prompt" }), "first"),
      click(role("button", { name: "send" })),
      typeInto(role("textbox", { name: "Prompt" }), "second"),
      click(role("button", { name: "send" })),
      expectAll(all.selector(".queued")).toHaveCount(2),
      expect(selector(".queued")).toContainText("waits for the agent's turn to end"),
      expectAll(all.selector(".bubble.waiting")).toHaveCount(0),
      Subscription.emit(Message.ReceivedFleet({ fleet: withState("idle") })),
      Command.expectExact(SendPrompt({ address: "t1", id: 0, text: "first", whileWorking: false, replaces: Option.some("") })),
      Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 0 })),
      Command.expectExact(SendPrompt({ address: "t1", id: 1, text: "second", whileWorking: false, replaces: Option.some("") })),
      Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 1 })),
      expectAll(all.selector(".queued")).toHaveCount(0),
      expectAll(all.selector(".bubble.waiting")).toHaveCount(2),
    )
  })

  test("sends a message now on request, and drops one on request", () => {
    scene(
      { update, view },
      given({ ...chatOpen([]), bridge: Bridge.Watching({ fleet: withState("working") }) }),
      Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
      typeInto(role("textbox", { name: "Prompt" }), "now"),
      click(role("button", { name: "send" })),
      typeInto(role("textbox", { name: "Prompt" }), "never"),
      click(role("button", { name: "send" })),
      click(nth(all.role("button", { name: "drop it" }), 1)),
      expectAll(all.selector(".queued")).toHaveCount(1),
      click(role("button", { name: "Send now" })),
      Command.expectExact(SendPrompt({ address: "t1", id: 0, text: "now", whileWorking: true, replaces: Option.some("") })),
      Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 0 })),
      expectAll(all.selector(".queued")).toHaveCount(0),
    )
  })

  test("waits while the agent's input box holds text the page did not write, and says so", () => {
    scene(
      { update, view },
      given(chatOpen([])),
      Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
      Subscription.emit(Message.ReceivedInputBox({ address: "t1", box: { _tag: "Partial", text: "[Pasted text #1 +40 lines]" } })),
      expect(selector(".queue-draft")).toContainText("[Pasted text #1 +40 lines]"),
      typeInto(role("textbox", { name: "Prompt" }), "hello"),
      click(role("button", { name: "send" })),
      expect(selector(".queued")).toContainText("waits for the agent's input box to empty"),
      Subscription.emit(Message.ReceivedInputBox({ address: "t1", box: { _tag: "Empty" } })),
      Command.expectExact(SendPrompt({ address: "t1", id: 0, text: "hello", whileWorking: false, replaces: Option.some("") })),
      Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 0 })),
    )
  })

  test("sends to an idle agent whose input box the page does not read, with no reading of it", () => {
    const opencode: Terminal = {
      ...claude,
      foreground: Option.some({ name: "opencode", pid: 1, argv: [] }),
      status: Option.map(claude.status, (status) => ({ ...status, app: Option.some("opencode") })),
    }
    scene(
      { update, view },
      given({ ...chatOpen([]), bridge: Bridge.Watching({ fleet: { ...fleet, terminals: [opencode] } }), boxes: {} }),
      Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
      typeInto(role("textbox", { name: "Prompt" }), "hello"),
      click(role("button", { name: "send" })),
      Command.expectExact(SendPrompt({ address: "t1", id: 0, text: "hello", whileWorking: false, replaces: Option.none() })),
      Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 0 })),
    )
  })

  test("shows the agent's suggested prompt in the empty prompt", () => {
    scene(
      { update, view },
      given({ ...chatOpen([]), boxes: { t1: { _tag: "Suggestion", text: "commit this" } } }),
      Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
      expect(role("textbox", { name: "Prompt" })).toHaveAttr("placeholder", "commit this"),
    )
  })
})

describe("the prompt and the agent's input box", () => {
  const textbox = role("textbox", { name: "Prompt" })

  test("a draft typed in the terminal shows in the prompt, and sending it empties the box first", () => {
    scene(
      { update, view },
      given(chatOpen([])),
      Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
      Subscription.emit(Message.ReceivedInputBox({ address: "t1", box: { _tag: "Draft", text: "fix the\n  tests" } })),
      expect(textbox).toHaveValue("fix the\n  tests"),
      expectAll(all.selector(".queue-draft")).toHaveCount(0),
      click(role("button", { name: "send" })),
      Command.expectExact(SendPrompt({ address: "t1", id: 0, text: "fix the\n  tests", whileWorking: false, replaces: Option.some("fix the\n  tests") })),
      Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1", id: 0 })),
      Command.expectNone(),
    )
  })

  test("typing in the prompt goes into the box once typing pauses, and the box's reading after it is the new agreement", () => {
    scene(
      { update, view },
      given(chatOpen([])),
      Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
      typeInto(textbox, "a long line"),
      // A pause that began before the last edit writes nothing.
      Subscription.emit(Message.PausedTyping({ address: "t1", text: "a long" })),
      Command.expectNone(),
      Subscription.emit(Message.PausedTyping({ address: "t1", text: "a long line" })),
      Command.expectExact(WriteInputBox({ address: "t1", expected: "", text: "a long line" })),
      // Claude Code wrapped the line.
      Command.resolve(WriteInputBox, Message.WroteInputBox({ address: "t1", text: "a long line", box: { _tag: "Draft", text: "a long\n  line" } })),
      Subscription.emit(Message.ReceivedInputBox({ address: "t1", box: { _tag: "Draft", text: "a long\n  line" } })),
      expect(textbox).toHaveValue("a long line"),
      Command.expectNone(),
    )
  })

  test("a box changed in the terminal keeps the prompt's own edits, which the next pause writes over it", () => {
    scene(
      { update, view },
      given(chatOpen([])),
      Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
      typeInto(textbox, "mine"),
      Subscription.emit(Message.ReceivedInputBox({ address: "t1", box: { _tag: "Draft", text: "theirs" } })),
      expect(textbox).toHaveValue("mine"),
      Subscription.emit(Message.PausedTyping({ address: "t1", text: "mine" })),
      Command.expectExact(WriteInputBox({ address: "t1", expected: "theirs", text: "mine" })),
      Command.resolve(WriteInputBox, Message.FailedWriteInputBox({ address: "t1", reason: "the agent's input box changed in the terminal" })),
      expect(selector(".box-problem")).toContainText("could not write the agent's input box"),
    )
  })

  test("text the screen shows only in part stays in the box, and nothing is written over it", () => {
    scene(
      { update, view },
      given(chatOpen([])),
      Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
      Subscription.emit(Message.ReceivedInputBox({ address: "t1", box: { _tag: "Partial", text: "[Pasted text #1 +40 lines]" } })),
      expect(textbox).toHaveValue(""),
      expect(selector(".queue-draft")).toContainText("[Pasted text #1 +40 lines]"),
      typeInto(textbox, "more"),
      Subscription.emit(Message.PausedTyping({ address: "t1", text: "more" })),
      Command.expectNone(),
    )
  })
})
