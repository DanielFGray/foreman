import { Option } from "effect"
import { all, click, expect, expectAll, given, inside, role, scene, selector } from "foldkit/scene"
import { test } from "vitest"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
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
  spaces: [
    {
      id: "s1",
      name: "",
      folder: "/home/dan/build/prog",
      tabs: [
        { id: "a", name: "", root: { _tag: "Block", type: "block", id: "p1", size: Option.none(), content: { _tag: "Terminal", terminal: "t1" } } },
        { id: "b", name: "notes", root: { _tag: "Unknown", type: "browser" } },
      ],
    },
    { id: "s2", name: "quiet", folder: "/", tabs: [{ id: "c", name: "", root: { _tag: "Unknown", type: "browser" } }] },
  ],
  terminals: [blockedAgent],
}

test("the sidebar lists every space and tab, marks them by their agents, and opens a tab", () => {
  scene(
    { update, view },
    given({ ...init(DEFAULT_SETTINGS).model, bridge: Bridge.Watching({ fleet }) }),
    expectAll(all.selector(".space-head")).toHaveCount(2),
    inside(
      role("region", { name: "prog" }),
      expect(selector(".space-head .dot")).toHaveClass("blocked"),
      expect(selector(".agent-row")).toContainText("needs a yes"),
    ),
    // A space without agents still shows, with no mark.
    inside(role("region", { name: "quiet" }), expect(selector(".dot")).not.toExist()),
    click(role("button", { name: "notes" })),
    expect(role("button", { name: "notes" })).toHaveAttr("aria-current", "page"),
    expect(selector(".tabs .tab.on")).toContainText("notes"),
  )
})
