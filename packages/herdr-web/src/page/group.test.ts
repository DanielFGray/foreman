import { describe, expect, test } from "vitest"
import { Option } from "effect"
import type { Fleet, Layout, Machine, StatusState, Terminal } from "../shared/Fleet.ts"
import { dropSide, isAgent, locate, mostUrgent, type Sidebar, sidebarOf, terminalLabel } from "./group.ts"

const terminal = (address: string, hasStatus = true, state: Terminal["state"] = "live"): Terminal => ({
  address,
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state,
  status: hasStatus
    ? Option.some({ state: "idle", app: Option.none(), msg: Option.none(), kind: Option.none(), progress: Option.none() })
    : Option.none(),
  foreground: Option.none(),
  labels: {},
  status_ms: Option.none(),
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

const here = (spaces: Machine["spaces"]): Machine => ({ name: "here", isLocal: true, state: "connected", spaces })

const fleet: Fleet = {
  connected: true,
  machines: [
    here([
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
    ]),
  ],
  terminals: [terminal("t1"), terminal("t2"), terminal("t3", false), terminal("t4")],
}

const withState = (t: Terminal, state: StatusState): Terminal => ({
  ...t,
  status: Option.map(t.status, (status) => ({ ...status, state })),
})

const outline = ({ machines, loose }: Sidebar) => ({
  spaces: machines.flatMap(({ spaces }) => spaces).map(({ label, status, tabs }) => [
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

test("sidebarOf keeps each machine's spaces under it, in the fleet's order", () => {
  const away: Machine = { name: "cynic", isLocal: false, state: "unreachable", spaces: [{ id: "cynic/s9", name: "far", folder: "/", tabs: [] }] }
  const { machines } = sidebarOf({ ...fleet, machines: [...fleet.machines, away] })
  expect(machines.map(({ machine, spaces }) => [machine.name, spaces.map(({ label }) => label)])).toEqual([
    ["here", ["prog", "empty"]],
    ["cynic", ["far"]],
  ])
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
  test("prefers the name, then the agent, then the foreground program, and never shows the address", () => {
    const plain = { ...terminal("t9", false), title: Option.some("") }
    const claude = { ...plain, foreground: Option.some({ name: "/usr/bin/Claude", pid: 1, argv: [] }) }
    expect(terminalLabel({ ...claude, name: Option.some("build-c8") })).toBe("build-c8")
    expect(terminalLabel(claude)).toBe("Claude Code")
    expect(terminalLabel({ ...plain, foreground: Option.some({ name: "zsh", pid: 1, argv: [] }) })).toBe("zsh")
    expect(terminalLabel(plain)).toBe("terminal")
  })

  test("a known agent's program makes an agent without a status report", () => {
    const codex = { ...terminal("t9", false), foreground: Option.some({ name: "codex", pid: 1, argv: [] }) }
    expect([isAgent(codex), isAgent({ ...codex, foreground: Option.some({ name: "zsh", pid: 1, argv: [] }) })]).toEqual([true, false])
  })
})

describe("dropSide", () => {
  const space = (id: string) => ({ id, name: id, folder: "/", tabs: [] })
  const machine = (name: string, ids: ReadonlyArray<string>): Machine => ({ name, isLocal: name === "here", state: "connected", spaces: ids.map(space) })
  const fleet: Fleet = { connected: true, machines: [machine("here", ["a", "b", "c"]), machine("cynic", ["d"])], terminals: [] }

  test("a space lands after a target below it and before one above it", () => {
    expect(dropSide(fleet, "a", "c")).toStrictEqual(Option.some("after"))
    expect(dropSide(fleet, "c", "a")).toStrictEqual(Option.some("before"))
  })

  test("a space has no place on itself or on another machine", () => {
    expect(dropSide(fleet, "b", "b")).toStrictEqual(Option.none())
    expect(dropSide(fleet, "a", "d")).toStrictEqual(Option.none())
  })
})
