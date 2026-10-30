// @vitest-environment happy-dom
import { Option } from "effect"
import { all, click, Command, doubleClick, expect, expectAll, expectIgnored, given, hover, inside, keydown, pointerDown, pointerUp, role, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Machine, Terminal } from "../shared/Fleet.ts"
import { FetchFonts, MoveSpace, SaveSelection, SaveSidebarWidth } from "./commands.ts"
import { init, update, view } from "./main.ts"
import { Bridge, Message, Selection } from "./model.ts"
import { DEFAULT_SETTINGS } from "./settings.ts"

const blockedAgent: Terminal = {
  address: "t1",
  name: Option.some("claude"),
  title: Option.none(),
  cwd: "/",
  state: "live",
  status: Option.some({ state: "blocked", app: Option.none(), msg: Option.some("needs a yes"), kind: Option.none(), progress: Option.none() }),
  foreground: Option.none(),
  labels: {},
  status_ms: Option.none(),
  created_ms: 0,
  parent: Option.none(),
  cols: 80,
  rows: 24,
}

const fleet: Fleet = {
  connected: true,
  git: {},
  machines: [
    {
      name: "here",
      isLocal: true,
      state: "connected",
      spaces: [
        {
          id: "s1",
          name: "",
          folder: "/home/dan/build/prog",
          tabs: [
            { id: "b", name: "notes", root: { _tag: "Unknown", type: "browser" } },
            { id: "a", name: "", root: { _tag: "Block", type: "block", id: "p1", size: Option.none(), content: { _tag: "Terminal", terminal: "t1" } } },
          ],
        },
        { id: "s2", name: "quiet", folder: "/", tabs: [{ id: "c", name: "", root: { _tag: "Unknown", type: "browser" } }] },
      ],
    },
  ],
  terminals: [blockedAgent],
}

test("the sidebar lists every space, marked by its agents, and a click opens its first tab", () => {
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet }) }),
    expectAll(all.selector(".space-row")).toHaveCount(2),
    inside(role("button", { name: "prog" }), expect(selector(".badge")).toHaveClass("blocked")),
    // A space without agents still shows, with a neutral badge.
    inside(role("button", { name: "quiet" }), expect(selector(".badge")).toHaveClass("none")),
    click(role("button", { name: "prog" })),
    // A reload opens on it again.
    Command.expectExact(SaveSelection({ selection: Selection.Tab({ tabId: "b", maybeFocus: Option.none() }) })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    expect(role("button", { name: "prog" })).toHaveAttr("aria-current", "page"),
    expect(selector(".tabs .tab.on")).toContainText("notes"),
    // The tab bar marks the tab whose agent waits.
    inside(role("button", { name: "2" }), expect(selector(".dot")).toHaveClass("blocked")),
    inside(role("button", { name: "notes" }), expect(selector(".dot")).not.toExist()),
    // One machine needs no heading.
    expect(selector(".machine-head")).not.toExist(),
  )
})

test("with another machine, each machine heads its spaces and says when it is away", () => {
  const away: Machine = { name: "cynic", isLocal: false, state: "needs_login", spaces: [] }
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet: { ...fleet, machines: [...fleet.machines, away] } }) }),
    expectAll(all.selector(".machine-head")).toHaveCount(2),
    expect(selector(".machine-head.needs_login")).toContainText("cynic"),
    expect(selector(".machine-head.needs_login")).toContainText("needs login"),
  )
})

test("a space row shows its letter badge, coloured by its most urgent agent, and its git branch and changes", () => {
  const git = { s1: { branch: Option.some("feat/sidebar"), changed: true } }
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet: { ...fleet, git } }) }),
    // "prog" has a blocked agent; "quiet" has none, and no git state.
    expectAll(all.selector(".badge")).toHaveCount(2),
    expect(selector(".badge.blocked")).toContainText("P"),
    expect(selector(".badge.none")).toContainText("Q"),
    expect(selector(".badge.blocked")).toHaveAttr("aria-hidden", "true"),
    expectAll(all.selector(".branch")).toHaveCount(1),
    expect(selector(".branch")).toContainText("feat/sidebar"),
    expect(selector(".branch")).toHaveAttr("title", "feat/sidebar"),
    expect(selector(".changes")).toHaveAttr("title", "uncommitted changes"),
  )
})

test("a space with no git state shows no branch, and a clean one shows no changes mark", () => {
  const clean = { s2: { branch: Option.some("main"), changed: false } }
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet }) }),
    expect(selector(".git")).not.toExist(),
  )
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet: { ...fleet, git: clean } }) }),
    expect(selector(".branch")).toContainText("main"),
    expect(selector(".changes")).not.toExist(),
  )
})

test("a space whose name starts with no letter or digit is badged with its place", () => {
  const symbol: Fleet = {
    ...fleet,
    machines: [{ name: "here", isLocal: true, state: "connected", spaces: [{ id: "s9", name: "~", folder: "/", tabs: [] }] }],
  }
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet: symbol }) }),
    expect(selector(".badge")).toContainText("1"),
  )
})

test("agents list below the spaces, or under each space when the settings say so", () => {
  const model = { ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet }) }
  scene(
    { update, view },
    given(model),
    inside(role("region", { name: "Agents" }), expect(selector(".agent-row")).toContainText("needs a yes")),
    expect(selector(".space-agents")).not.toExist(),
  )
  scene(
    { update, view },
    given({ ...model, settings: { ...DEFAULT_SETTINGS, agents: "nested" } }),
    expect(selector(".space-agents .agent-row")).toContainText("needs a yes"),
    // No agent is loose, so no list follows the spaces.
    expect(selector(".agent-list")).not.toExist(),
  )
})

test("a space dragged onto another moves there, and a refusal says why", () => {
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet }) }),
    pointerDown(role("button", { name: "prog" })),
    hover(role("button", { name: "quiet" })),
    // Moving down, it lands after its target.
    expect(role("button", { name: "quiet" })).toHaveClass("drop-after"),
    expect(role("button", { name: "prog" })).toHaveClass("pressed"),
    pointerUp(role("button", { name: "quiet" })),
    Command.expectExact(MoveSpace({ space: "s1", onto: "s2" })),
    Command.resolve(MoveSpace, Message.FailedMoveSpace({ reason: "the herdr-app window is not reachable" })),
    expect(selector(".fleet .note.error")).toContainText("the herdr-app window is not reachable"),
  )
})

test("a press released on its own space moves nothing", () => {
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet }) }),
    pointerDown(role("button", { name: "quiet" })),
    pointerUp(role("button", { name: "quiet" })),
    expect(role("button", { name: "quiet" })).not.toHaveClass("pressed"),
  )
})

test("the sidebar's edge resizes it by key and goes back to the default on a double-click", () => {
  const edge = role("separator", { name: "resize the sidebar" })
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet }) }),
    keydown(edge, "ArrowRight"),
    Command.expectExact(SaveSidebarWidth({ width: Option.some(356) })),
    Command.resolve(SaveSidebarWidth, Message.CompletedSaveSidebarWidth()),
    expect(edge).toHaveAttr("aria-valuenow", "356"),
    // A key that is not the edge's is the page's.
    keydown(edge, "a"),
    expectIgnored(),
    doubleClick(edge),
    Command.expectExact(SaveSidebarWidth({ width: Option.none() })),
    Command.resolve(SaveSidebarWidth, Message.CompletedSaveSidebarWidth()),
    expect(edge).toHaveAttr("aria-valuenow", "340"),
  )
})

test("the settings take the place of the tab, and a space picked after them takes it back", () => {
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, bridge: Bridge.Watching({ fleet }) }),
    click(role("button", { name: "prog" })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    click(role("button", { name: "Settings" })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    Command.resolve(FetchFonts, Message.ReceivedFonts({ families: [] })),
    expect(role("button", { name: "Settings" })).toHaveAttr("aria-current", "page"),
    expect(role("button", { name: "prog" })).toHaveAttr("aria-current", "false"),
    expect(selector(".tabs")).not.toExist(),
    // A second click leaves them open.
    click(role("button", { name: "Settings" })),
    expect(selector(".settings")).toExist(),
    click(role("button", { name: "quiet" })),
    Command.resolve(SaveSelection, Message.CompletedSaveSelection()),
    expect(selector(".settings")).not.toExist(),
    expect(role("button", { name: "Settings" })).toHaveAttr("aria-current", "false"),
  )
})

test("the agent list groups by state, most urgent first, with the time in each state", () => {
  const agent = (address: string, state: "idle" | "working" | "blocked", msg: string, since: Option.Option<number>): Terminal => ({
    ...blockedAgent,
    address,
    status: Option.some({ state, app: Option.none(), msg: Option.some(msg), kind: Option.none(), progress: Option.none() }),
    status_ms: since,
  })
  const pane = (terminal: string) => ({ _tag: "Block" as const, type: "block" as const, id: `p-${terminal}`, size: Option.none(), content: { _tag: "Terminal" as const, terminal } })
  const here: Machine = {
    name: "here",
    isLocal: true,
    state: "connected",
    spaces: [
      { id: "s1", name: "prog", folder: "/", tabs: [{ id: "a", name: "", root: pane("t1") }, { id: "b", name: "", root: pane("t2") }] },
      { id: "s2", name: "quiet", folder: "/", tabs: [{ id: "c", name: "", root: pane("t3") }] },
    ],
  }
  const grouped: Fleet = {
    connected: true,
    git: {},
    machines: [here],
    terminals: [
      agent("t1", "idle", "ready", Option.none()),
      agent("t2", "working", "running tests", Option.some(88_000)),
      agent("t3", "blocked", "needs a yes", Option.some(-152_000)),
    ],
  }
  scene(
    { update, view },
    given({ ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model, now: 100_000, bridge: Bridge.Watching({ fleet: grouped }) }),
    expectAll(all.selector(".agent-list .state-head")).toHaveCount(3),
    expect(selector(".agent-list .state-head")).toContainText("Waiting for you"),
    expectAll(all.selector(".agent-row")).toHaveCount(3),
    // A blocked agent is "space · what it does", and says how long it has waited.
    expect(selector(".agent-list ul .agent-row")).toContainText("quiet"),
    expect(selector(".agent-list ul .agent-row")).toContainText("· needs a yes"),
    expect(selector(".agent-list ul .agent-row .time")).toContainText("waiting 4m"),
    expect(selector(".agent-row .dot.working")).toExist(),
    // Without a time from hc, the row shows none.
    expectAll(all.selector(".agent-row .time")).toHaveCount(2),
  )
})

test("an agent that another started nests one level under its row, in both listings", () => {
  const child: Terminal = { ...blockedAgent, address: "t2", name: Option.some("helper"), parent: Option.some("t1") }
  const model = {
    ...init({ settings: DEFAULT_SETTINGS, selection: Selection.Nothing(), sidebarWidth: Option.none(), recent: [] }).model,
    bridge: Bridge.Watching({ fleet: { ...fleet, terminals: [blockedAgent, child] } }),
  }
  scene(
    { update, view },
    given(model),
    expect(selector(".agent-list .agent-children .agent-row")).toContainText("helper"),
    expectAll(all.selector(".agent-row")).toHaveCount(2),
  )
  scene(
    { update, view },
    given({ ...model, settings: { ...DEFAULT_SETTINGS, agents: "nested" } }),
    expect(selector(".space-agents .agent-children .agent-row")).toContainText("helper"),
    // The child is not also listed as loose.
    expect(selector(".agent-list")).not.toExist(),
  )
})
