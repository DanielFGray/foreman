import { describe, expect, test } from "vitest"
import { Option } from "effect"
import type { Terminal } from "../shared/Fleet.ts"
import { doomed, folderOn, withShellAfter } from "./HerdrApp.ts"

const terminal = (address: string, parent: Option.Option<string>, space = ""): Terminal => ({
  address,
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  status: Option.none(),
  foreground: Option.none(),
  labels: space === "" ? {} : { "herdr.space": space },
  status_ms: Option.none(),
  created_ms: 0,
  records: Option.none(),
  parent,
  cols: 80,
  rows: 24,
})

describe("doomed", () => {
  test("a closed pane's terminal ends with the programs started from it, down the chain, but not one that holds a pane", () => {
    const fleet = [
      terminal("t1", Option.none(), "w1"),
      terminal("t2", Option.some("t1")),
      terminal("t3", Option.some("t2")),
      terminal("t4", Option.some("t1"), "w1"),
      terminal("t5", Option.none()),
    ]
    expect(new Set(doomed(fleet, ["t1"]))).toEqual(new Set(["t1", "t2", "t3"]))
  })
})

describe("withShellAfter", () => {
  test("here, the login shell runs the program and then stays", () => {
    expect(withShellAfter(Option.none(), "/bin/zsh", ["claude", "--resume"])).toEqual(["/bin/zsh", "-ic", '"$@"; exec "$0" -i', "/bin/zsh", "claude", "--resume"])
  })

  test("fish takes its arguments its own way", () => {
    expect(withShellAfter(Option.none(), "/usr/bin/fish", ["claude"])).toEqual(["/usr/bin/fish", "-ic", "command $argv[2..]; exec $argv[1] -i", "/usr/bin/fish", "claude"])
  })

  test("on another machine, sh runs it and then that machine's shell", () => {
    expect(withShellAfter(Option.some("cynic"), "/bin/zsh", ["claude"])).toEqual(["sh", "-c", '"$@"; exec "${SHELL:-sh}" -i', "sh", "claude"])
  })
})

describe("folderOn", () => {
  test("here, a relative folder or ~ is taken from the home", () => {
    expect([folderOn(Option.none(), "/home/u", "src/a"), folderOn(Option.none(), "/home/u", "~/src/a"), folderOn(Option.none(), "/home/u", "~"), folderOn(Option.none(), "/home/u", "/srv")]).toEqual([
      "/home/u/src/a",
      "/home/u/src/a",
      "/home/u",
      "/srv",
    ])
  })

  test("on another machine, hc takes a relative folder from that machine's home", () => {
    expect([folderOn(Option.some("cynic"), "/home/u", "~/src/a"), folderOn(Option.some("cynic"), "/home/u", "~"), folderOn(Option.some("cynic"), "/home/u", "/srv")]).toEqual(["src/a", "", "/srv"])
  })
})
