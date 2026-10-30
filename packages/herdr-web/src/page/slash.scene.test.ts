// @vitest-environment happy-dom
// A tap on a suggestion puts focus back in the prompt through the document, so this file needs one.
import { Option } from "effect"
import { click, Command, expect, given, Mount, role, scene, selector, type as typeInto } from "foldkit/scene"
import { test } from "vitest"
import { BridgeError } from "../shared/Api.ts"
import type { SlashCommand } from "../shared/SlashCommand.ts"
import { ListCommands } from "./commands.ts"
import { KeepTypingFocus } from "./keys.ts"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Conversation, Message, Selection, View, type Model } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"

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

const chatOpen: Model = {
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.some("t1") }), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [] }).model,
  bridge: Bridge.Watching({ fleet }),
  views: { t1: View.Chat({ conversation: Conversation.Shown({ entries: [] }) }) },
  boxes: { t1: { _tag: "Empty" } },
}

const commands: ReadonlyArray<SlashCommand> = [
  { name: "compact", description: "Summarise the conversation to free context", hint: Option.some("[instructions]"), origin: "built-in" },
  { name: "clear", description: "Clear the conversation and start a new one", hint: Option.none(), origin: "built-in" },
  { name: "git:push", description: "Push the branch.", hint: Option.some("<branch>"), origin: "user" },
]

test("a prompt that starts a command reads the agent's commands and lists the matches; a tap writes one in and sends nothing", () => {
  scene(
    { update, view },
    given(chatOpen),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    typeInto(role("textbox", { name: "Prompt" }), "/c"),
    Command.expectExact(ListCommands({ address: "t1" })),
    expect(selector(".slash-note")).toHaveText("Reading the commands…"),
    Command.resolve(ListCommands, Message.ReceivedCommands({ address: "t1", commands })),
    expect(role("list", { name: "commands" })).toContainText("Summarise the conversation to free context"),
    expect(role("button", { name: "/git:push" })).not.toExist(),
    click(role("button", { name: "/compact" })),
    expect(role("textbox", { name: "Prompt" })).toHaveValue("/compact "),
    // The command is written: its row stays, with what it takes.
    expect(role("button", { name: "/compact" })).not.toExist(),
    expect(role("list", { name: "commands" })).toContainText("[instructions]"),
  )
})

test("the commands are read again for the next command, and a failure says why", () => {
  scene(
    { update, view },
    given(chatOpen),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()]),
    typeInto(role("textbox", { name: "Prompt" }), "/"),
    Command.resolve(ListCommands, Message.FailedCommands({ address: "t1", failure: new BridgeError({ kind: "hc", message: "hc did not answer" }) })),
    expect(selector(".slash-note")).toHaveText("The commands cannot be read: hc did not answer"),
    typeInto(role("textbox", { name: "Prompt" }), "hello"),
    expect(selector(".slash-note")).not.toExist(),
    typeInto(role("textbox", { name: "Prompt" }), "/"),
    Command.expectExact(ListCommands({ address: "t1" })),
    Command.resolve(ListCommands, Message.ReceivedCommands({ address: "t1", commands })),
    expect(role("button", { name: "/git:push" })).toExist(),
  )
})
