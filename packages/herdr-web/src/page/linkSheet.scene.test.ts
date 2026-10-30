import { Option } from "effect"
import { click, Command, expect, given, Mount, role, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import { CopyText } from "./commands.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { LiveTerminal } from "./terminal.ts"

const focused = { ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [], softKeys: Option.none() }).model, selection: Selection.Loose({ address: "t7" }) }

test("a link tapped in a terminal shows its whole address; Open is a link to it, and Copy copies it", () => {
  scene(
    { update, view },
    given(focused),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()], [LiveTerminal, Message.PointedAtLink({ uri: "https://example.com/deploy?id=7" })]),
    expect(role("dialog", { name: "Open link?" })).toContainText("https://example.com/deploy?id=7"),
    expect(role("link", { name: "Open" })).toHaveAttr("href", "https://example.com/deploy?id=7"),
    expect(role("link", { name: "Open" })).toHaveAttr("rel", "noopener noreferrer"),
    click(role("button", { name: "Copy" })),
    Command.expectExact(CopyText({ text: "https://example.com/deploy?id=7" })),
    Command.resolve(CopyText, Message.FailedCopyLink({ reason: "the browser copies only on an https page" })),
    expect(role("dialog", { name: "Open link?" })).toContainText("Not copied: the browser copies only on an https page"),
    click(role("button", { name: "Cancel" })),
    expect(role("dialog", { name: "Open link?" })).not.toExist(),
  )
})

test("a link that is not a web address may be copied, never opened", () => {
  scene(
    { update, view },
    given(focused),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()], [LiveTerminal, Message.PointedAtLink({ uri: "javascript:alert(1)" })]),
    expect(role("link", { name: "Open" })).not.toExist(),
    expect(selector(".sheet")).toContainText("Only http and https addresses open from here."),
    click(role("button", { name: "Copy" })),
    Command.expectExact(CopyText({ text: "javascript:alert(1)" })),
    Command.resolve(CopyText, Message.CopiedLink()),
    expect(selector(".sheet")).toContainText("Copied."),
  )
})
