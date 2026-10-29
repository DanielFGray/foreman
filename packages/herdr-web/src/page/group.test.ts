import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Fleet, Terminal } from "../shared/Fleet.ts"
import { groupFleet, terminalLabel } from "./group.ts"

const terminal = (address: string, labels: Record<string, string>, isAgent = true): Terminal => ({
  address,
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  status: isAgent
    ? Option.some({ state: "idle", app: Option.none(), msg: Option.none(), kind: Option.none(), progress: Option.none() })
    : Option.none(),
  foreground: Option.none(),
  labels,
  created_ms: 0,
})

const at = (space: string, tab: string) => ({ "herdr.space": space, "herdr.tab": tab })

const fleet: Fleet = {
  connected: true,
  spaces: [
    { id: "s1", name: "", folder: "/home/dan/build/prog", tabs: [{ id: "a", name: "" }, { id: "b", name: "logs" }] },
    { id: "s2", name: "empty", folder: "/", tabs: [{ id: "c", name: "" }] },
  ],
  terminals: [
    terminal("t1", at("s1", "b")),
    terminal("t2", at("s1", "a")),
    terminal("t3", at("s1", "a"), false),
    terminal("t4", {}),
    terminal("t5", at("gone", "x")),
  ],
}

const addresses = (groups: ReturnType<typeof groupFleet>) =>
  groups.map(({ label, tabs }) => [label, tabs.map((tab) => [tab.label, tab.terminals.map(({ address }) => address)])])

describe("groupFleet", () => {
  test("files agents under their space and tab, in herdr-app's order", () => {
    expect(addresses(groupFleet(fleet, "Agents"))).toEqual([
      ["prog", [["1", ["t2"]], ["logs", ["t1"]]]],
      ["Other", [["", ["t4", "t5"]]]],
    ])
  })

  test("shows non-agent terminals only for the All filter", () => {
    expect(addresses(groupFleet(fleet, "All"))[0]).toEqual(["prog", [["1", ["t2", "t3"]], ["logs", ["t1"]]]])
  })

  test("files a terminal with no known tab at the end of its space", () => {
    const loose = terminal("t6", { "herdr.space": "s1" })
    expect(addresses(groupFleet({ ...fleet, terminals: [terminal("t1", at("s1", "a")), loose] }, "All"))).toEqual([
      ["prog", [["1", ["t1"]], ["", ["t6"]]]],
    ])
  })

  test("omits Other when every terminal has a space", () => {
    expect(addresses(groupFleet({ ...fleet, terminals: [terminal("t1", at("s1", "a"))] }, "All"))).toEqual([
      ["prog", [["1", ["t1"]]]],
    ])
  })
})

describe("terminalLabel", () => {
  test("prefers the name, then the foreground program, then the address", () => {
    const plain = terminal("t9", {})
    expect(terminalLabel({ ...plain, name: Option.some("claude") })).toBe("claude")
    expect(terminalLabel({ ...plain, foreground: Option.some({ name: "nvim" }) })).toBe("nvim")
    expect(terminalLabel(plain)).toBe("t9")
  })
})
