import { Option } from "effect"
import { click, Command, expect, Mount, expectAll, all, given, role, scene, selector, Subscription, type as typeInto } from "foldkit/scene"
import { describe, expect as expectValue, test } from "vitest"
import type { Entry } from "../shared/Chat.ts"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
import { SendPrompt } from "./commands.ts"
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

const chatOpen = (entries: ReadonlyArray<Entry>): Model => ({
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.some("t1") }), sidebarWidth: Option.none(), recent: [] }).model,
  bridge: Bridge.Watching({ fleet }),
  views: { t1: View.Chat({ conversation: Conversation.Shown({ entries }) }) },
})

const clockAt = (now: number) => Subscription.emit(Message.TickedClock({ now }))

test("a sent prompt shows at once as a faded bubble, gets a clock after 5 seconds, and gives way to the recorded prompt", () => {
  scene(
    { update, view },
    given(chatOpen([prompt("old", "go on")])),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    typeInto(role("textbox", { name: "Prompt" }), "go on"),
    click(role("button", { name: "send" })),
    Command.expectExact(SendPrompt({ address: "t1", text: "go on" })),
    Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1" })),
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
    given({ ...chatOpen([]), prompt: "hello" }),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    click(role("button", { name: "send" })),
    Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1" })),
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
    given({ ...chatOpen([]), prompt: "/cost" }),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    click(role("button", { name: "send" })),
    Command.resolve(SendPrompt, Message.SucceededSendPrompt({ address: "t1" })),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(0),
  )
  scene(
    { update, view },
    given({ ...chatOpen([]), prompt: "hello" }),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    click(role("button", { name: "send" })),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(1),
    Command.resolve(SendPrompt, Message.FailedSendPrompt({ address: "t1", reason: "no such terminal" })),
    expectAll(all.selector(".bubble.waiting")).toHaveCount(0),
  )
})

describe("comesBackAsPrompt", () => {
  test("is false for a slash command, a shell line and blank text", () => {
    expectValue(["hello", "/cost", " ! ls", "  "].map(comesBackAsPrompt)).toEqual([true, false, false, false])
  })
})

