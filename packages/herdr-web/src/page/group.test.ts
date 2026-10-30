import { describe, expect, test } from "vitest"
import { Option } from "effect"
import type { Fleet, Layout, StatusState, Terminal } from "../shared/Fleet.ts"
import { locate, mostUrgent, type Sidebar, sidebarOf, terminalLabel } from "./group.ts"

const terminal = (address: string, isAgent = true, state: Terminal["state"] = "live"): Terminal => ({
  address,
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state,
  status: isAgent
    ? Option.some({ state: "idle", app: Option.none(), msg: Option.none(), kind: Option.none(), progress: Option.none() })
    : Option.none(),
  foreground: Option.none(),
  labels: {},
  created_ms: 0,
})

const pane = (address: string): Layout => ({
  _tag: "Block",
  type: "block",
  id: `p-${address}`,
  size: Option.none(),
  content: { _tag: "Terminal", terminal: address },
})
const split = (type: string, children: ReadonlyArray<Layout>): Layout => ({ _tag: "Split", type, id: type, size: Option.none(), children })

const fleet: Fleet = {
  connected: true,
  spaces: [
    {
      id: "s1",
      name: "",
      folder: "/home/dan/build/prog",
      tabs: [
        { id: "a", name: "", root: split("row", [pane("t2"), split("column", [pane("t3"), pane("t1")])]) },
        { id: "b", name: "logs", root: split("row", [pane("t9")]) },
      ],
    },
    { id: "s2", name: "empty", folder: "/", tabs: [{ id: "c", name: "", root: { _tag: "Unknown", type: "browser" } }] },
  ],
  terminals: [terminal("t1"), terminal("t2"), terminal("t3", false), terminal("t4")],
}

const withState = (t: Terminal, state: StatusState): Terminal => ({
  ...t,
  status: Option.map(t.status, (status) => ({ ...status, state })),
})

const outline = ({ spaces, loose }: Sidebar) => ({
  spaces: spaces.map(({ label, status, tabs }) => [
    label,
    Option.getOrNull(status),
    tabs.map(({ label, status, agents }) => [label, Option.getOrNull(status), agents.map(({ address }) => address)]),
  ]),
  loose: loose.map(({ address }) => address),
})

describe("sidebarOf", () => {
  test("lists every space and tab in order, with each tab's agents in pane order and loose agents apart", () => {
    expect(outline(sidebarOf(fleet))).toEqual({
      spaces: [
        ["prog", "idle", [["1", "idle", ["t2", "t1"]], ["logs", null, []]]],
        ["empty", null, [["1", null, []]]],
      ],
      loose: ["t4"],
    })
  })

  test("marks a space and a tab with its most urgent agent", () => {
    const urgent = { ...fleet, terminals: [withState(terminal("t1"), "working"), withState(terminal("t2"), "blocked"), terminal("t9")] }
    expect(outline(sidebarOf(urgent)).spaces[0]).toEqual(["prog", "blocked", [["1", "blocked", ["t2", "t1"]], ["logs", "idle", ["t9"]]]])
  })

  test("leaves out agents whose program has exited, and shells", () => {
    const exited = { ...fleet, terminals: [terminal("t1", true, "finished"), terminal("t3", false), terminal("t4", true, "finished")] }
    expect(outline(sidebarOf(exited))).toEqual({
      spaces: [
        ["prog", null, [["1", null, []], ["logs", null, []]]],
        ["empty", null, [["1", null, []]]],
      ],
      loose: [],
    })
  })
})

describe("mostUrgent", () => {
  test("ranks blocked, error, done, working, then idle", () => {
    const states: ReadonlyArray<StatusState> = ["idle", "working", "done", "error", "blocked"]
    const agents = states.map((state, index) => withState(terminal(`t${index}`), state))
    expect(mostUrgent(agents)).toEqual(Option.some("blocked"))
    expect(mostUrgent(agents.slice(0, 3))).toEqual(Option.some("done"))
    expect(mostUrgent([])).toEqual(Option.none())
  })
})

describe("locate", () => {
  test("finds the space and tab that show a terminal, or none", () => {
    expect(Option.map(locate(fleet, "t1"), ({ space, tab }) => [space.id, tab.id])).toEqual(Option.some(["s1", "a"]))
    expect(locate(fleet, "t4")).toEqual(Option.none())
  })
})

describe("terminalLabel", () => {
  test("prefers the name, then the foreground program, then the address", () => {
    const plain = terminal("t9")
    expect(terminalLabel({ ...plain, name: Option.some("claude") })).toBe("claude")
    expect(terminalLabel({ ...plain, foreground: Option.some({ name: "nvim", pid: 1 }) })).toBe("nvim")
    expect(terminalLabel(plain)).toBe("t9")
  })
})
