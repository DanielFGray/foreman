import { Option } from "effect"
import { expect, test } from "vitest"
import type { Terminal } from "./Fleet.ts"
import { harnessOf, supports } from "./Harness.ts"

const terminal = (app: Option.Option<string>, program: Option.Option<string>): Terminal => ({
  address: "t1",
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  status: Option.map(app, (name) => ({ state: "idle", app: Option.some(name), msg: Option.none(), kind: Option.none(), progress: Option.none() })),
  status_ms: Option.none(),
  foreground: Option.map(program, (name) => ({ name, pid: 1, argv: [name] })),
  labels: {},
  created_ms: 0,
  cols: 80,
  rows: 24,
  parent: Option.none(),
})

const nameOf = (app: Option.Option<string>, program: Option.Option<string>) => Option.map(harnessOf(terminal(app, program)), ({ name }) => name)

test("an agent is known by the app its status names, else by its program's last path segment in any case", () => {
  expect(nameOf(Option.some("claude-code"), Option.some("node"))).toEqual(Option.some("Claude Code"))
  expect(nameOf(Option.none(), Option.some("/home/me/.local/bin/Claude"))).toEqual(Option.some("Claude Code"))
  expect(nameOf(Option.none(), Option.some("open-code"))).toEqual(Option.some("OpenCode"))
  expect(nameOf(Option.none(), Option.some("zsh"))).toEqual(Option.none())
})

test("an agent has only the features it lists, whether it reports a status or not", () => {
  expect(supports(terminal(Option.none(), Option.some("claude")), "chat")).toBe(true)
  expect(supports(terminal(Option.some("codex"), Option.some("codex")), "chat")).toBe(false)
  expect(supports(terminal(Option.none(), Option.some("zsh")), "model")).toBe(false)
})
