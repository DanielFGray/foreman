import { Option } from "effect"
import { all, click, expect, expectAll, given, inside, role, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Machine, Terminal } from "../shared/Fleet.ts"
import { Bridge, init, update, view } from "./main.ts"
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
  created_ms: 0,
}

const fleet: Fleet = {
  connected: true,
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
    given({ ...init(DEFAULT_SETTINGS).model, bridge: Bridge.Watching({ fleet }) }),
    expectAll(all.selector(".space-row")).toHaveCount(2),
    inside(role("button", { name: "prog" }), expect(selector(".dot")).toHaveClass("blocked")),
    // A space without agents still shows, with no mark.
    inside(role("button", { name: "quiet" }), expect(selector(".dot")).not.toExist()),
    click(role("button", { name: "prog" })),
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
    given({ ...init(DEFAULT_SETTINGS).model, bridge: Bridge.Watching({ fleet: { ...fleet, machines: [...fleet.machines, away] } }) }),
    expectAll(all.selector(".machine-head")).toHaveCount(2),
    expect(selector(".machine-head.needs_login")).toContainText("cynic"),
    expect(selector(".machine-head.needs_login")).toContainText("needs login"),
  )
})

test("agents list below the spaces, or under each space when the settings say so", () => {
  const model = { ...init(DEFAULT_SETTINGS).model, bridge: Bridge.Watching({ fleet }) }
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
