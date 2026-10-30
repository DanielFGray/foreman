import { Option } from "effect"
import { click, Command, expect, given, Mount, placeholder, role, scene, selector, submit, type } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Layout } from "../shared/Fleet.ts"
import type { RepoCheckouts } from "../shared/Worktree.ts"
import { FocusField, ListWorktrees, NewWorktree, RemoveWorktree, SaveSelection } from "./commands.ts"
import { KeepTypingFocus } from "./keys.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"
import { LiveTerminal } from "./terminal.ts"

const block = (terminal: string): Layout =>
  ({ _tag: "Block", type: "block", id: `p-${terminal}`, size: Option.none(), content: { _tag: "Terminal", terminal } })

const fleet: Fleet = {
  connected: true,
  git: { s1: { branch: Option.some("main"), changed: false } },
  terminals: [],
  machines: [{ name: "here", isLocal: true, state: "connected", spaces: [{ id: "s1", name: "app", folder: "/src/app", tabs: [{ id: "a", name: "a", root: block("t1") }] }] }],
}

const listed: RepoCheckouts = {
  repo: "app",
  checkouts: [
    { path: "/src/app", branch: Option.some("main"), isMain: true, space: Option.some("s1") },
    { path: "/home/u/.herdr/worktrees/app/feat", branch: Option.some("feat"), isMain: false, space: Option.none() },
  ],
}

const start = {
  ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Tab({ tabId: "a", maybeFocus: Option.none() }), sidebarWidth: Option.none(), recent: [], softKeys: Option.none(), isZoomed: false, viewPicks: [] }).model,
  bridge: Bridge.Watching({ fleet }),
}

test("a repository's space lists its checkouts, checks out a branch, and removes a checkout after a second click", () => {
  scene(
    { update, view },
    given(start),
    Mount.resolveAll([KeepTypingFocus, Message.CompletedKeepTypingFocus()], [LiveTerminal, Message.ChangedLink({ address: "t1", link: { _tag: "Live" } })]),
    click(role("button", { name: "worktrees of app" })),
    Command.expectExact(SaveSelection({ selection: Selection.Worktrees({ space: "s1" }) }), ListWorktrees({ space: "s1" }), FocusField({ id: "worktree-branch" })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    Command.resolve(ListWorktrees, Message.ReceivedWorktrees({ list: listed })),
    Command.resolve(FocusField, Message.CompletedFocusField()),
    Mount.expectEnded(LiveTerminal),
    Mount.expectEnded(KeepTypingFocus),
    expect(selector("h2")).toHaveText("Worktrees of app"),
    // The main checkout has no Remove.
    expect(role("button", { name: "remove the checkout of main" })).not.toExist(),
    click(role("button", { name: "remove the checkout of feat" })),
    click(role("button", { name: "keep the checkout" })),
    click(role("button", { name: "remove the checkout of feat" })),
    click(role("button", { name: "remove the checkout of feat" })),
    Command.expectExact(RemoveWorktree({ space: "s1", path: "/home/u/.herdr/worktrees/app/feat" })),
    Command.resolve(RemoveWorktree, Message.SucceededRemoveCheckout()),
    Command.expectExact(ListWorktrees({ space: "s1" })),
    Command.resolve(ListWorktrees, Message.ReceivedWorktrees({ list: { ...listed, checkouts: listed.checkouts.slice(0, 1) } })),
    type(placeholder("a new or existing branch"), " fix/bug "),
    submit(selector(".worktree-form")),
    Command.expectExact(NewWorktree({ space: "s1", branch: "fix/bug", program: Option.none() })),
    Command.resolve(NewWorktree, Message.FailedCheckoutAction({ reason: "fatal: a branch named 'fix/bug' already exists" })),
    expect(selector(".note.error")).toHaveText("fatal: a branch named 'fix/bug' already exists"),
  )
})
