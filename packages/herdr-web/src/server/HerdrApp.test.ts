import { describe, expect, test } from "vitest"
import { Option } from "effect"
import type { Terminal } from "../shared/Fleet.ts"
import { doomed } from "./HerdrApp.ts"

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
