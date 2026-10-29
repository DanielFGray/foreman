import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Fleet, Layout, Terminal } from "../shared/Fleet.ts"
import { groupFleet, locate, terminalLabel } from "./group.ts"

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

const outline = (groups: ReturnType<typeof groupFleet>) =>
  groups.map(({ label, terminals }) => [label, terminals.map(({ address }) => address)])

describe("groupFleet", () => {
  test("files agents under the space whose layout shows them, in tab and pane order", () => {
    expect(outline(groupFleet(fleet, "Agents"))).toEqual([
      ["prog", ["t2", "t1"]],
      ["Other", ["t4"]],
    ])
  })

  test("shows non-agent terminals only for the All filter", () => {
    expect(outline(groupFleet(fleet, "All"))[0]).toEqual(["prog", ["t2", "t3", "t1"]])
  })

  test("leaves out terminals whose program has exited", () => {
    expect(outline(groupFleet({ ...fleet, terminals: [terminal("t1", true, "finished"), terminal("t4", false, "finished")] }, "All"))).toEqual([])
  })

  test("omits Other when every terminal is placed", () => {
    expect(outline(groupFleet({ ...fleet, terminals: [terminal("t1")] }, "All"))).toEqual([["prog", ["t1"]]])
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
